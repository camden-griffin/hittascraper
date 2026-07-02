// run_batches.js
// Auto-chaining batch runner for the registry scrape pipeline.
//
// Loops: filter next N backbone rows (by --skip offset) -> dedupe vs CRM ->
// resolve websites. When a batch finishes it automatically advances the offset
// and starts a fresh batch on NEW rows. Stops when the filter yields 0 rows
// (backbone exhausted for the chosen SNI/text filter) or --maxBatches is hit.
//
// The offset is persisted to a small state file so it resumes across restarts
// (Ctrl-C, crash, reboot) without rescraping.
//
// Usage:
//   node src/run_batches.js --sni 46,47 --size 5000
//   node src/run_batches.js --sni 41,42,43 --kommun STOCKHOLM --size 5000 --tag bygg_sthlm
//   node src/run_batches.js --text "konsult|redovisning" --size 5000 --maxBatches 3

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));

const ROOT = path.join(__dirname, "..");
const SIZE = Math.max(1, parseInt(argv.size || "5000", 10) || 5000);
const MAX_BATCHES = parseInt(argv.maxBatches || "0", 10) || 0; // 0 = unlimited
const TAG =
    argv.tag ||
    (argv.sni ? `sni_${String(argv.sni).replace(/[^0-9]/g, "_")}` : "batch");
const DELAY_MS = String(argv.delayMs || "1200");
// Step 4 (crawl resolved sites for email/phone) runs by default; --noContacts skips it.
const SKIP_CONTACTS =
    argv.noContacts === true ||
    String(argv.noContacts || "").toLowerCase() === "true";
const STATE_FILE = path.join(ROOT, "input", `.runstate_${TAG}.json`);

// Filter args passed straight through to filter_backbone.js.
const filterArgs = [];
if (argv.sni) filterArgs.push("--sni", String(argv.sni));
if (argv.text) filterArgs.push("--text", String(argv.text));
if (argv.kommun) filterArgs.push("--kommun", String(argv.kommun));

function loadOffset() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).skip || 0;
    } catch {
        return Math.max(0, parseInt(argv.skip || "0", 10) || 0);
    }
}
function saveOffset(skip) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ skip, tag: TAG, ts: Date.now() }));
}

// Run a node script, inheriting stdout/stderr; resolve with exit code.
function run(scriptRelo, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [path.join(ROOT, scriptRelo), ...args], {
            cwd: ROOT,
            stdio: "inherit",
        });
        p.on("error", reject);
        p.on("close", (code) => resolve(code));
    });
}

// Count data rows in a CSV (minus header), without loading it all.
function countRows(file) {
    if (!fs.existsSync(file)) return 0;
    const data = fs.readFileSync(file, "utf8");
    const n = data.split("\n").filter((l) => l.trim()).length;
    return Math.max(0, n - 1);
}

(async () => {
    console.log("🔁 Auto-chaining batch runner");
    console.log("====================================");
    console.log(`Tag:        ${TAG}`);
    console.log(`Batch size: ${SIZE}`);
    console.log(`Filter:     ${filterArgs.join(" ") || "(none)"}`);
    console.log(`State file: ${STATE_FILE}`);
    console.log(`Resolve delay: ${DELAY_MS}ms`);
    console.log("====================================\n");

    let skip = loadOffset();
    let batchNum = 0;

    while (true) {
        if (MAX_BATCHES && batchNum >= MAX_BATCHES) {
            console.log(`\n⏹  Reached --maxBatches ${MAX_BATCHES}. Stopping.`);
            break;
        }
        batchNum++;
        const stamp = `${TAG}_${skip}_${skip + SIZE}`;
        const rawCsv = path.join("input", `${stamp}.csv`);
        const newCsv = path.join("input", `${stamp}_new.csv`);
        const resolvedCsv = path.join("input", `${stamp}_resolved.csv`);

        console.log(`\n===== BATCH ${batchNum} (skip ${skip}) =====`);

        // 1. filter
        const fc = await run("src/filter_backbone.js", [
            ...filterArgs,
            "--limit",
            String(SIZE),
            "--skip",
            String(skip),
            "--output",
            rawCsv,
        ]);
        if (fc !== 0) {
            console.error("❌ filter failed; aborting.");
            process.exit(1);
        }
        const got = countRows(path.join(ROOT, rawCsv));
        if (got === 0) {
            console.log("\n✅ Backbone exhausted for this filter — no more rows. Done.");
            break;
        }

        // 2. dedupe vs CRM
        const dc = await run("scripts/dedupe_against_crm.js", [
            "--input",
            rawCsv,
            "--output",
            newCsv,
        ]);
        if (dc !== 0) {
            console.error("❌ dedupe failed; aborting.");
            process.exit(1);
        }
        const newRows = countRows(path.join(ROOT, newCsv));

        // 3. resolve websites (skip if dedupe left nothing)
        //
        // Resolve in place on resolvedCsv so a mid-batch kill/restart resumes:
        // resolve_websites.js skips rows that already have a target_url and
        // flushes every 10 rows, so re-running over its own partial output
        // continues where it stopped. We seed resolvedCsv from newCsv only if
        // it doesn't already exist (i.e. this is a fresh batch, not a resume).
        if (newRows > 0) {
            if (!fs.existsSync(path.join(ROOT, resolvedCsv))) {
                fs.copyFileSync(
                    path.join(ROOT, newCsv),
                    path.join(ROOT, resolvedCsv),
                );
            }
            const rc = await run("src/resolve_websites.js", [
                "--input",
                resolvedCsv,
                "--output",
                resolvedCsv,
                "--delayMs",
                DELAY_MS,
            ]);
            if (rc !== 0) {
                console.error(`⚠️  resolver exited ${rc} for batch ${batchNum} — advancing anyway.`);
            }
        } else {
            console.log("   (all rows were CRM dupes — skipping resolve)");
        }

        // 4. extract real email + phone by crawling the resolved websites
        //    (target_url). This is what actually fills the contact columns —
        //    the registry/backbone has none. Skipped with --noContacts.
        const enrichedCsv = path.join(
            "input",
            `${stamp}_resolved_with_domain_enrichment.csv`,
        );
        if (!SKIP_CONTACTS && newRows > 0 && fs.existsSync(path.join(ROOT, resolvedCsv))) {
            const ec = await run("extract_domains_contacts_and_webshop.js", [
                "--input",
                resolvedCsv,
                "--limit",
                String(SIZE),
            ]);
            if (ec !== 0) {
                console.error(`⚠️  contact extractor exited ${ec} for batch ${batchNum} — advancing anyway.`);
            } else {
                console.log(`   ✓ contacts → ${enrichedCsv}`);
            }
        }

        // 5. advance offset and persist — next loop scrapes fresh rows
        skip += got;
        saveOffset(skip);
        console.log(`\n✔ Batch ${batchNum} done. Next offset: ${skip}`);
    }

    console.log("\n🏁 Runner finished.");
})().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
