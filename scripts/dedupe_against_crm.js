// dedupe_against_crm.js
// Drops candidate rows whose orgnr already exists in the CRM (crm/data/crm.db),
// so the resolve/enrich stages never waste cycles on leads we already have.
//
// Matching is by digits-only orgnr. The CRM stores orgnr without the dash
// (e.g. "5595284844"); candidates use "559528-4844". Both normalize to the
// same 10-digit key.
//
// Usage:
//   node scripts/dedupe_against_crm.js --input input/candidates.csv
//   node scripts/dedupe_against_crm.js --input input/candidates.csv --output input/candidates_new.csv
//   node scripts/dedupe_against_crm.js --input input/candidates.csv --db ../crm/data/crm.db
//
// Default output is <input>_new.csv next to the input file.

const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");
const minimist = require("minimist");

let Database;
try {
    // crm/ ships better-sqlite3; reuse it if present.
    Database = require(path.join(__dirname, "..", "crm", "node_modules", "better-sqlite3"));
} catch {
    try {
        Database = require("better-sqlite3");
    } catch {
        Database = null;
    }
}

const argv = minimist(process.argv.slice(2));

const INPUT = argv.input || argv.in;
if (!INPUT) {
    console.error("❌ --input <candidates.csv> is required");
    process.exit(1);
}
const INPUT_CSV = path.isAbsolute(INPUT)
    ? INPUT
    : path.join(process.cwd(), INPUT);

const inputDir = path.dirname(INPUT_CSV);
const inputName = path.basename(INPUT_CSV).replace(/\.csv$/i, "");
const OUTPUT_CSV =
    argv.output ||
    argv.out ||
    path.join(inputDir, `${inputName}_new.csv`);

const DB_PATH = path.isAbsolute(argv.db || "")
    ? argv.db
    : path.join(__dirname, "..", argv.db || "crm/data/crm.db");

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");

function loadCrmOrgnrs() {
    if (!fs.existsSync(DB_PATH)) {
        console.warn(`⚠️  CRM db not found at ${DB_PATH} — nothing to dedupe against.`);
        return new Set();
    }
    if (!Database) {
        console.error(
            "❌ better-sqlite3 not available. Install it (npm i better-sqlite3) " +
                "or run from a checkout where crm/node_modules has it.",
        );
        process.exit(1);
    }
    const db = new Database(DB_PATH, { readonly: true });
    const set = new Set();
    for (const row of db.prepare("SELECT org_nr FROM leads").all()) {
        const d = onlyDigits(row.org_nr);
        if (d) set.add(d);
    }
    db.close();
    return set;
}

(function main() {
    if (!fs.existsSync(INPUT_CSV)) {
        console.error(`❌ input not found: ${INPUT_CSV}`);
        process.exit(1);
    }

    const crm = loadCrmOrgnrs();
    console.log(`CRM orgnrs loaded: ${crm.size}`);

    const raw = fs.readFileSync(INPUT_CSV, "utf8");
    const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });
    const rows = parsed.data;

    const kept = [];
    let dropped = 0;
    for (const r of rows) {
        const d = onlyDigits(r.orgnr || r.org_nr);
        if (d && crm.has(d)) {
            dropped++;
            continue;
        }
        kept.push(r);
    }

    const csv = Papa.unparse(kept, { columns: parsed.meta.fields });
    fs.writeFileSync(OUTPUT_CSV, csv, "utf8");

    console.log("====================================");
    console.log(`Input rows:   ${rows.length}`);
    console.log(`Dropped dup:  ${dropped}`);
    console.log(`Kept (new):   ${kept.length}`);
    console.log(`Output:       ${OUTPUT_CSV}`);
    console.log("====================================");
})();
