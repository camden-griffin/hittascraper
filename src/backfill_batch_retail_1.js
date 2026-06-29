// backfill_batch_retail_1.js
// One-off: backfill email + phone for batch_retail_1 from hitta.se.
//
// batch_retail_1_resolved.csv was produced before the resolver scraped
// email/phone, so it has websites but no contact columns. This re-runs the
// resolver in --backfill-contacts mode (revisits every row lacking an email,
// pulls email/phone from the same hitta company page) and writes back in place.
//
// Idempotent: re-running only revisits rows that still have no email, so it
// resumes cleanly if interrupted.
//
// Usage:
//   node src/backfill_batch_retail_1.js

const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "input", "batch_retail_1_resolved.csv");

const args = [
    path.join(ROOT, "src", "resolve_websites.js"),
    "--input",
    FILE,
    "--output",
    FILE, // write back in place
    "--backfill-contacts",
    "true",
    "--delayMs",
    "900",
    "--limit",
    "100000",
];

console.log("📇 Backfilling email/phone for batch_retail_1 from hitta.se");
console.log(`   target: ${FILE}`);
console.log("   (revisits rows with no email; idempotent / resumable)\n");

const p = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
p.on("error", (e) => {
    console.error("❌ failed to start:", e.message);
    process.exit(1);
});
p.on("close", (code) => {
    console.log(`\n✔ backfill finished (resolver exit ${code}).`);
    process.exit(code || 0);
});
