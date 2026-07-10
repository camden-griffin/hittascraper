// scrape_full_throttled.js
// Anti-rate-limit runner for the full-population hitta.se scrape.
//
// Wraps src/scraper.js (via src/cli-scrape.js) with randomized pacing so a
// very large run (~178k orgs) looks less like a bot and is less likely to be
// rate-limited / IP-blocked by hitta.se.
//
// It does NOT modify scraper.js. Instead it:
//   1. Re-launches the scraper in short "sessions" (a random slice of orgs
//      each), so we never hold one long, uniform, easily-fingerprinted crawl.
//   2. Randomizes the per-org DELAY_MS on EVERY session (uniform in the
//      [minDelayMs, maxDelayMs] range), so the base cadence drifts instead of
//      being a constant floor.
//   3. Sleeps a random "rest" between sessions (short pauses most of the time,
//      occasional long breaks) — mimicking a human stepping away.
//   4. Relies on scraper.js's own resume (skips orgs already in
//      output/finance_table_data.jsonl), so each session continues where the
//      last left off without redoing work. Crashes just start a new session.
//
// Usage:
//   node src/scrape_full_throttled.js --input input/backbone_active_ab_deduped.csv
//   node src/scrape_full_throttled.js --input in.csv \
//        --minDelayMs 2500 --maxDelayMs 8000 \
//        --sessionMin 150 --sessionMax 400 \
//        --restMinMs 20000 --restMaxMs 120000 \
//        --longRestEvery 8 --longRestMinMs 300000 --longRestMaxMs 900000 \
//        --concurrency 2 --headless 1
//
// Stop any time with Ctrl+C — the next run resumes from the jsonl.

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));

const INPUT =
    argv.input ||
    argv.in ||
    path.join(__dirname, "..", "input", "backbone_active_ab_deduped.csv");

// ---- Randomized pacing knobs (all overridable via CLI) ----
// Per-org delay is randomized per session inside this range. hitta is more
// tolerant of slow-and-random than fast-and-uniform, so default fairly wide.
const MIN_DELAY_MS = intArg("minDelayMs", 2500);
const MAX_DELAY_MS = intArg("maxDelayMs", 8000);

// How many orgs to attempt per session before restarting the scraper with a
// fresh random delay. Randomized per session in this range.
const SESSION_MIN = intArg("sessionMin", 150);
const SESSION_MAX = intArg("sessionMax", 400);

// Rest between sessions (the common, short pause).
const REST_MIN_MS = intArg("restMinMs", 20_000);
const REST_MAX_MS = intArg("restMaxMs", 120_000);

// Every N sessions (randomized around it), take a much longer break to look
// like a human stepping away. Set --longRestEvery 0 to disable.
const LONG_REST_EVERY = intArg("longRestEvery", 8);
const LONG_REST_MIN_MS = intArg("longRestMinMs", 300_000); // 5 min
const LONG_REST_MAX_MS = intArg("longRestMaxMs", 900_000); // 15 min

// Passed straight through to scraper.js.
const CONCURRENCY = intArg("concurrency", 2);
const HEADLESS = argv.headless != null ? String(argv.headless) : "1";
const ORG_TIMEOUT_MS = intArg("orgTimeoutMs", 180_000);

// Optional overall cap on how many NEW orgs to scrape this run (0 = all).
const MAX_TOTAL = intArg("maxTotal", 0);

function intArg(name, dflt) {
    const v = argv[name];
    if (v == null) return dflt;
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) ? n : dflt;
}

const randInt = (lo, hi) =>
    Math.floor(lo + Math.random() * Math.max(0, hi - lo + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m${String(s % 60).padStart(2, "0")}s`;
};

// ---- Count how many orgs are already scraped (resume awareness) ----
// scraper.js resumes from output/finance_table_data.jsonl; we read it only to
// report progress and to know when to stop (all input orgs done).
function jsonlPath() {
    return path.join(__dirname, "..", "output", "finance_table_data.jsonl");
}

function countScraped() {
    const p = jsonlPath();
    if (!fs.existsSync(p)) return 0;
    try {
        // Count unique orgnrs seen in the jsonl.
        const seen = new Set();
        const text = fs.readFileSync(p, "utf8");
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const o = JSON.parse(line);
                const org = String(o.orgnr || o.org || "").replace(/\D/g, "");
                if (org) seen.add(org);
            } catch {}
        }
        return seen.size;
    } catch {
        return 0;
    }
}

function countInput() {
    try {
        const text = fs.readFileSync(INPUT, "utf8");
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        return Math.max(0, lines.length - 1); // minus header
    } catch {
        return 0;
    }
}

// ---- Run one scraper session as a child process ----
function runSession({ delayMs, limit }) {
    return new Promise((resolve) => {
        const env = {
            ...process.env,
            INPUT_CSV: INPUT,
            DELAY_MS: String(delayMs),
            CONCURRENCY: String(CONCURRENCY),
            HEADLESS,
            ORG_TIMEOUT_MS: String(ORG_TIMEOUT_MS),
            // LIMIT counts NEW (non-skipped) orgs, so a session naturally ends
            // after ~`limit` freshly scraped orgs even though it skips the
            // already-done ones instantly at the top.
            LIMIT: String(limit),
            // Let the child exit on a fatal error so we control restarts here
            // (with our randomized rest) instead of its tight backoff loop.
            EXIT_ON_ERROR: "1",
        };
        const child = spawn(
            process.execPath,
            [path.join(__dirname, "cli-scrape.js")],
            { stdio: "inherit", env },
        );
        child.on("exit", (code, signal) => resolve({ code, signal }));
        child.on("error", (err) => {
            console.error("   ⚠️  failed to spawn scraper:", err.message);
            resolve({ code: 1, signal: null });
        });

        // Forward Ctrl+C to the child so it shuts its browser down cleanly.
        const onSig = () => {
            try {
                child.kill("SIGINT");
            } catch {}
        };
        process.once("SIGINT", onSig);
        child.on("exit", () => process.removeListener("SIGINT", onSig));
    });
}

// ---- Main loop ----
let stopping = false;
process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(
        "\n⏹️  Ctrl+C — finishing current session then stopping (resume-safe).",
    );
});

(async () => {
    const totalInput = countInput();
    const startScraped = countScraped();

    console.log("🐌 Throttled full-run wrapper for hitta.se scraper");
    console.log("====================================");
    console.log(`Input:            ${INPUT}`);
    console.log(`Input orgs:       ${totalInput}`);
    console.log(`Already scraped:  ${startScraped}`);
    console.log(`Per-org delay:    ${MIN_DELAY_MS}–${MAX_DELAY_MS} ms (random/session)`);
    console.log(`Session size:     ${SESSION_MIN}–${SESSION_MAX} new orgs`);
    console.log(`Rest between:     ${fmt(REST_MIN_MS)}–${fmt(REST_MAX_MS)}`);
    if (LONG_REST_EVERY > 0)
        console.log(
            `Long rest:        ~every ${LONG_REST_EVERY} sessions, ${fmt(LONG_REST_MIN_MS)}–${fmt(LONG_REST_MAX_MS)}`,
        );
    console.log(`Concurrency:      ${CONCURRENCY}   Headless: ${HEADLESS}`);
    if (MAX_TOTAL) console.log(`Max new this run: ${MAX_TOTAL}`);
    console.log("====================================\n");

    let session = 0;
    let newThisRun = 0;
    let nextLongRestAt =
        LONG_REST_EVERY > 0 ? randInt(Math.max(1, LONG_REST_EVERY - 2), LONG_REST_EVERY + 2) : 0;

    while (!stopping) {
        const scrapedBefore = countScraped();
        if (totalInput > 0 && scrapedBefore >= totalInput) {
            console.log(`\n✅ All ${totalInput} input orgs scraped. Done.`);
            break;
        }
        if (MAX_TOTAL && newThisRun >= MAX_TOTAL) {
            console.log(`\n✅ Hit maxTotal=${MAX_TOTAL} new orgs this run. Stopping.`);
            break;
        }

        session++;
        const delayMs = randInt(MIN_DELAY_MS, MAX_DELAY_MS);
        let limit = randInt(SESSION_MIN, SESSION_MAX);
        if (MAX_TOTAL) limit = Math.min(limit, MAX_TOTAL - newThisRun);

        const remaining = totalInput ? totalInput - scrapedBefore : "?";
        console.log(
            `\n━━ session ${session} ━━  delay=${delayMs}ms  target=+${limit} orgs  (scraped ${scrapedBefore}/${totalInput}, ~${remaining} left)`,
        );

        const { code, signal } = await runSession({ delayMs, limit });

        const scrapedAfter = countScraped();
        const gained = Math.max(0, scrapedAfter - scrapedBefore);
        newThisRun += gained;
        console.log(
            `   session ${session} ended (exit ${code}${signal ? "/" + signal : ""}) — +${gained} new (total ${scrapedAfter}/${totalInput})`,
        );

        if (stopping) break;

        // If the session made zero progress, it likely hit a block or an
        // input-exhausted state. Back off harder to avoid hammering.
        const blocked = gained === 0;

        // Choose a rest: normally short, occasionally a long human-like break.
        let restMs;
        const isLongRest =
            LONG_REST_EVERY > 0 && session >= nextLongRestAt;
        if (blocked) {
            // Suspected rate-limit: force a long cool-down.
            restMs = randInt(LONG_REST_MIN_MS, LONG_REST_MAX_MS);
            console.log(
                `   ⚠️  no progress this session — possible rate-limit. Cooling down ${fmt(restMs)}.`,
            );
        } else if (isLongRest) {
            restMs = randInt(LONG_REST_MIN_MS, LONG_REST_MAX_MS);
            nextLongRestAt =
                session + randInt(Math.max(1, LONG_REST_EVERY - 2), LONG_REST_EVERY + 2);
            console.log(`   ☕ long rest ${fmt(restMs)}.`);
        } else {
            restMs = randInt(REST_MIN_MS, REST_MAX_MS);
            console.log(`   💤 rest ${fmt(restMs)}.`);
        }

        // Sleep in 1s slices so Ctrl+C is responsive.
        const until = Date.now() + restMs;
        while (Date.now() < until && !stopping) {
            await sleep(Math.min(1000, until - Date.now()));
        }
    }

    const endScraped = countScraped();
    console.log("\n====================================");
    console.log("Throttled run stopped.");
    console.log(`Sessions:         ${session}`);
    console.log(`New this run:     ${newThisRun}`);
    console.log(`Total scraped:    ${endScraped}/${totalInput}`);
    console.log(`Resume any time:  node src/scrape_full_throttled.js --input ${INPUT}`);
    console.log("====================================");
})().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
