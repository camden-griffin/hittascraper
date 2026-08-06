// hunt_emails_from_input.js
// One command to email-hunt EVERY company across all of /input, continuously,
// while other scrapers are still producing files.
//
// What it does each pass:
//   1. Scans input/ for every *.csv that carries a website column
//      (target_url | homepage_from_allabolag | domain).
//   2. Merges all their rows, deduped by orgnr, into a single work-list
//      (input/_email_hunt_worklist.csv). Rows without any URL are dropped —
//      nothing to crawl. Newer files fill gaps left by earlier ones.
//   3. Runs extract_domains_contacts_and_webshop.js over that work-list. That
//      extractor RESUMES (skips rows it already enriched), so each pass only
//      does new work — the recall-improved static contact-subpage sweep runs
//      per site.
//
// Because it re-scans input/ and re-merges every pass, you can leave it running
// WHILE resolve/scrape keep dropping new *_resolved.csv files in — the next
// pass automatically picks up the newly-arrived rows.
//
// Output (emails + phones) lands in input/_email_hunt_worklist_out.csv.
//
// Usage:
//   node src/hunt_emails_from_input.js                 # one pass then exit
//   node src/hunt_emails_from_input.js --watch          # loop forever, re-scan each pass
//   node src/hunt_emails_from_input.js --watch --idleSec 120
//   node src/hunt_emails_from_input.js --limit 2000     # cap rows/pass (speed)
//   node src/hunt_emails_from_input.js --concurrency 6  # passed to extractor

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Papa = require("papaparse");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2), { boolean: ["watch"] });

const ROOT = path.join(__dirname, "..");
const INPUT_DIR = path.join(ROOT, "input");
const WORKLIST = path.join(INPUT_DIR, "_email_hunt_worklist.csv");
const WORKLIST_OUT = path.join(INPUT_DIR, "_email_hunt_worklist_out.csv");
const EXTRACTOR = path.join(ROOT, "extract_domains_contacts_and_webshop.js");

const WATCH = !!argv.watch;
const IDLE_SEC = Math.max(15, parseInt(argv.idleSec || "120", 10) || 120);
const LIMIT = parseInt(argv.limit || "0", 10) || 0; // 0 = all
const CONCURRENCY = parseInt(argv.concurrency || "0", 10) || 0;

// Columns that can hold a crawlable website, in priority order.
const URL_COLS = ["target_url", "homepage_from_allabolag", "domain", "url"];
// Output columns the extractor writes — presence means "already processed".
const DONE_COLS = ["email", "phone", "contact_page", "source", "debug"];

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const nz = (v) => v != null && String(v).trim() !== "";

function firstUrl(row) {
    for (const c of URL_COLS) {
        if (nz(row[c])) {
            let u = String(row[c]).trim();
            if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
            return u;
        }
    }
    return "";
}

// Files we should never treat as source input (our own artifacts).
function isOwnArtifact(name) {
    return (
        name.startsWith("_email_hunt_") ||
        name.endsWith("_out.csv") ||
        name === path.basename(WORKLIST)
    );
}

// ---- Build/refresh the merged work-list from all of input/ ----
function buildWorklist() {
    const files = fs
        .readdirSync(INPUT_DIR)
        .filter((f) => f.toLowerCase().endsWith(".csv") && !isOwnArtifact(f))
        .map((f) => path.join(INPUT_DIR, f));

    // Carry forward already-hunted results so we never redo a row: load prior
    // output first and seed the merge with its enrichment.
    const byOrg = new Map(); // orgnr -> merged row
    if (fs.existsSync(WORKLIST_OUT)) {
        try {
            const prev = Papa.parse(fs.readFileSync(WORKLIST_OUT, "utf8"), {
                header: true,
                skipEmptyLines: true,
            });
            for (const r of prev.data) {
                const k = onlyDigits(r.orgnr || r.org_nr);
                if (k.length === 10) byOrg.set(k, { ...r });
            }
        } catch {}
    }

    let scannedRows = 0;
    let withUrl = 0;
    for (const file of files) {
        let parsed;
        try {
            parsed = Papa.parse(fs.readFileSync(file, "utf8"), {
                header: true,
                skipEmptyLines: true,
            });
        } catch {
            continue;
        }
        for (const row of parsed.data) {
            const k = onlyDigits(row.orgnr || row.org_nr);
            if (k.length !== 10) continue;
            scannedRows++;
            const url = firstUrl(row);
            if (!url) continue; // nothing to crawl → skip
            withUrl++;

            const existing = byOrg.get(k) || {};
            // Prefer existing enrichment; fill identity/url fields from source.
            const merged = { ...row, ...existing };
            merged.orgnr = row.orgnr || existing.orgnr || k;
            if (!nz(merged.target_url)) merged.target_url = url;
            byOrg.set(k, merged);
        }
    }

    // Union of all columns so the extractor preserves everything.
    const cols = new Set(["orgnr", "target_url"]);
    for (const r of byOrg.values()) Object.keys(r).forEach((c) => cols.add(c));

    const rows = [...byOrg.values()];
    fs.writeFileSync(
        WORKLIST,
        Papa.unparse(rows, { columns: [...cols] }),
        "utf8",
    );

    const pending = rows.filter(
        (r) => nz(r.target_url) && !DONE_COLS.some((c) => nz(r[c])),
    ).length;

    return {
        files: files.length,
        scannedRows,
        withUrl,
        unique: rows.length,
        pending,
    };
}

// ---- Run the extractor over the work-list (it resumes internally) ----
function runExtractor() {
    return new Promise((resolve) => {
        const args = [
            EXTRACTOR,
            "--input",
            WORKLIST,
            "--output",
            WORKLIST_OUT,
            "--resume",
            "true",
        ];
        if (LIMIT) args.push("--limit", String(LIMIT));
        const env = { ...process.env };
        if (CONCURRENCY) env.CONCURRENCY = String(CONCURRENCY);

        const child = spawn(process.execPath, args, { stdio: "inherit", env });
        child.on("exit", (code, signal) => resolve({ code, signal }));
        child.on("error", (err) => {
            console.error("   ⚠️  extractor spawn failed:", err.message);
            resolve({ code: 1, signal: null });
        });
        const onSig = () => {
            try {
                child.kill("SIGINT");
            } catch {}
        };
        process.once("SIGINT", onSig);
        child.on("exit", () => process.removeListener("SIGINT", onSig));
    });
}

function countEmails() {
    if (!fs.existsSync(WORKLIST_OUT)) return { rows: 0, emails: 0 };
    try {
        const d = Papa.parse(fs.readFileSync(WORKLIST_OUT, "utf8"), {
            header: true,
            skipEmptyLines: true,
        });
        let emails = 0;
        for (const r of d.data) if (nz(r.email)) emails++;
        return { rows: d.data.length, emails };
    } catch {
        return { rows: 0, emails: 0 };
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\n⏹️  Ctrl+C — finishing current pass then stopping (resume-safe).");
});

(async () => {
    console.log("📧 Email hunter over all of input/  (recall-improved static + browser)");
    console.log("====================================");
    console.log(`Input dir:   ${INPUT_DIR}`);
    console.log(`Work-list:   ${WORKLIST}`);
    console.log(`Output:      ${WORKLIST_OUT}`);
    console.log(`Mode:        ${WATCH ? `watch (re-scan every pass, idle ${IDLE_SEC}s)` : "single pass"}`);
    if (LIMIT) console.log(`Limit/pass:  ${LIMIT}`);
    console.log("====================================\n");

    let pass = 0;
    while (!stopping) {
        pass++;
        const stats = buildWorklist();
        console.log(
            `\n━━ pass ${pass} ━━  ${stats.files} input files → ${stats.unique} unique w/ URL  (${stats.pending} pending email-hunt)`,
        );

        if (stats.pending === 0) {
            const c = countEmails();
            console.log(
                `   nothing pending. ${c.emails} emails found across ${c.rows} rows.`,
            );
            if (!WATCH) break;
        } else {
            await runExtractor();
            const c = countEmails();
            console.log(
                `   pass ${pass} done — ${c.emails} emails total across ${c.rows} rows → ${path.basename(WORKLIST_OUT)}`,
            );
        }

        if (!WATCH || stopping) break;

        // Idle wait before re-scanning input/ for newly-arrived files.
        console.log(`   💤 idle ${IDLE_SEC}s (waiting for new input rows)…`);
        const until = Date.now() + IDLE_SEC * 1000;
        while (Date.now() < until && !stopping) {
            await sleep(Math.min(1000, until - Date.now()));
        }
    }

    const c = countEmails();
    console.log("\n====================================");
    console.log(`Stopped after ${pass} pass(es).`);
    console.log(`Emails found: ${c.emails} / ${c.rows} rows`);
    console.log(`Output:       ${WORKLIST_OUT}`);
    console.log(`Merge to CRM: node scripts/merge_csvs_to_crm.js --glob "${path.relative(ROOT, WORKLIST_OUT)}"`);
    console.log("====================================");
})().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
