// dedupe_backbone.js
// Post-processing step for source_all_by_revenue.js output.
//
// The revenue-band scraper writes rows RAW — a company whose revenue sits on a
// band boundary can appear in two adjacent bands, so the same orgnr may occur
// more than once. This collapses to one row per orgnr, keeping the richest
// record (prefers rows that have revenue + homepage) and merging the band
// provenance (sni_branch_keyword) so you can still see every band a company
// showed up in.
//
// Usage:
//   node src/dedupe_backbone.js --input input/backbone_active_ab.csv
//   node src/dedupe_backbone.js --input in.csv --output in_deduped.csv

const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));

const INPUT =
    argv.input ||
    argv.in ||
    path.join(__dirname, "..", "input", "backbone_active_ab.csv");

// Default: overwrite in place unless an explicit --output is given.
const OUTPUT = argv.output || argv.out || INPUT;

function normOrgnr(v) {
    return String(v || "").replace(/\D/g, "");
}

function richness(r) {
    return (
        (r.revenue_sek ? 2 : 0) +
        (r.homepage_from_allabolag ? 1 : 0) +
        (r.phone ? 1 : 0) +
        (r.email_from_allabolag ? 1 : 0)
    );
}

function mergeBands(a, b) {
    const set = new Set(
        [a, b]
            .filter(Boolean)
            .flatMap((s) => String(s).split(" | "))
            .map((s) => s.trim())
            .filter(Boolean),
    );
    return [...set].join(" | ");
}

(async () => {
    if (!fs.existsSync(INPUT)) {
        console.error(`❌ input not found: ${INPUT}`);
        process.exit(1);
    }

    console.log(`🧹 Deduping ${INPUT}`);
    const text = fs.readFileSync(INPUT, "utf8");
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    const rows = parsed.data;
    const columns = parsed.meta.fields;

    const byOrgnr = new Map();
    let skippedNoOrgnr = 0;

    for (const row of rows) {
        const key = normOrgnr(row.orgnr);
        if (key.length !== 10) {
            skippedNoOrgnr++;
            continue;
        }
        const prev = byOrgnr.get(key);
        if (!prev) {
            byOrgnr.set(key, row);
            continue;
        }
        // Keep richer row, always merge band provenance.
        const mergedBands = mergeBands(
            prev.sni_branch_keyword,
            row.sni_branch_keyword,
        );
        const winner = richness(row) > richness(prev) ? row : prev;
        winner.sni_branch_keyword = mergedBands;
        byOrgnr.set(key, winner);
    }

    const out = [...byOrgnr.values()];
    const csv = Papa.unparse(out, { columns });
    fs.writeFileSync(OUTPUT, csv, "utf8");

    console.log("====================================");
    console.log(`Input rows (raw):     ${rows.length}`);
    console.log(`Duplicates removed:   ${rows.length - out.length - skippedNoOrgnr}`);
    if (skippedNoOrgnr)
        console.log(`Rows w/o valid orgnr: ${skippedNoOrgnr} (dropped)`);
    console.log(`Unique orgnrs:        ${out.length}`);
    console.log(`Output: ${OUTPUT}`);
    console.log("====================================");
})();
