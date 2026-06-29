// backfill_all_contacts.js
// Runs the website-crawl contact extractor (extract_domains_contacts_and_webshop)
// over EVERY resolved batch so all rows with a website get an email/phone attempt.
//
// Why: hitta only surfaces a contact for ~6% of companies, but crawling the
// resolved website yields email for a far higher share of sites that have one.
// Most batches were resolved before contact extraction ran, so they have 0
// emails. This sweeps them all, in place, columns preserved (see the writeCsv
// fix in the extractor).
//
// Idempotent: the extractor resumes by domain, so re-running skips done domains.
// Runs batches sequentially (one puppeteer instance at a time) to avoid thrash.
//
// Usage:
//   node src/backfill_all_contacts.js                 # all *_resolved.csv
//   node src/backfill_all_contacts.js --glob retail   # only files matching "retail"

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));
const ROOT = path.join(__dirname, "..");
const INPUT_DIR = path.join(ROOT, "input");
const MATCH = argv.glob ? String(argv.glob) : "";
// Comma-separated substrings to SKIP (e.g. files an auto-runner is actively
// writing — backfilling those in place would collide with the live run).
const EXCLUDE = String(argv.exclude || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Resolved batches = the *_resolved.csv files (not _new, not backbone, not
// already-enriched). Optionally filter by a substring.
const files = fs
    .readdirSync(INPUT_DIR)
    .filter((n) => /_resolved\.csv$/.test(n))
    .filter((n) => !MATCH || n.includes(MATCH))
    .filter((n) => !EXCLUDE.some((x) => n.includes(x)))
    .sort()
    .map((n) => path.join(INPUT_DIR, n));

function run(scriptRel, args) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(ROOT, scriptRel), ...args], {
            cwd: ROOT,
            stdio: "inherit",
        });
        p.on("error", (e) => {
            console.error("  ❌ spawn error:", e.message);
            resolve(1);
        });
        p.on("close", (code) => resolve(code));
    });
}

(async () => {
    console.log("📇 Backfilling contacts (website-crawl) across all resolved batches");
    console.log("====================================");
    console.log(`Batches found: ${files.length}`);
    files.forEach((f) => console.log("  - " + path.basename(f)));
    console.log("====================================\n");

    if (!files.length) {
        console.log("Nothing to do.");
        return;
    }

    let i = 0;
    for (const file of files) {
        i++;
        console.log(`\n===== [${i}/${files.length}] ${path.basename(file)} =====`);
        // Write back in place: extractor's output column merge preserves all
        // input columns and adds email/phone/webshop signals.
        const code = await run("extract_domains_contacts_and_webshop.js", [
            "--input",
            file,
            "--output",
            file,
            "--limit",
            "100000",
        ]);
        console.log(`   exit ${code}`);
    }

    console.log("\n🏁 All batches backfilled.");
})().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
