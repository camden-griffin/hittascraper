/**
 * Generates input/lender_targets.csv containing only companies that have
 * lender keywords found (lenderKeywords.length > 0) in the JSONL.
 *
 * Usage: node scripts/make-lender-input.mjs
 * Then:  $env:RESCAN_LENDER=1; npm run scrape -- --input input/lender_targets.csv
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsonlPath = resolve(__dirname, "../output/finance_table_data.jsonl");
const outPath = resolve(__dirname, "../input/lender_targets.csv");

const lines = readFileSync(jsonlPath, "utf8").split(/\r?\n/).filter(Boolean);

let count = 0;
const rows = ["name,orgnr"];

for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.lenderKeywords || rec.lenderKeywords.length === 0) continue;
    const name = (rec.name || "").replace(/"/g, '""');
    const orgnr = (rec.org || "").replace(/"/g, '""');
    rows.push(`"${name}","${orgnr}"`);
    count++;
}

writeFileSync(outPath, rows.join("\r\n") + "\r\n", "utf8");
console.log(`Written ${count} lender targets to ${outPath}`);
console.log(`\nNow run:`);
console.log(`  $env:RESCAN_LENDER=1; npm run scrape -- --input input/lender_targets.csv`);
