// filter_backbone.js
// Slices the big registry backbone (input/backbone_active_ab.csv, ~817k active
// AB) into scrape-sized batches so Stage 1/2 can run ICP-first without trying to
// scrape the whole registry in one (ban-prone, weeks-long) run.
//
// Streams the input line-by-line (the backbone is 200MB+), so memory stays flat.
// Filters by SNI code prefix and/or a text regex over name+verksamhetsbeskrivning,
// optionally by county/municipality, then writes matches — capped at --limit per
// run, resumable via --skip — to an output CSV ready for dedupe + resolve.
//
// Examples:
//   # ICP retail/wholesale (SNI 46/47), first 5000 rows:
//   node src/filter_backbone.js --sni 46,47 --limit 5000 --output input/batch_retail.csv
//
//   # Construction by SNI 41-43 in Stockholm county, next 5000 (resume):
//   node src/filter_backbone.js --sni 41,42,43 --kommun STOCKHOLM --limit 5000 --skip 5000 \
//     --output input/batch_bygg_sthlm_2.csv
//
//   # Keyword match over business description (ICP-style), e.g. bygg/konsult:
//   node src/filter_backbone.js --text "bygg|konsult|redovisning" --limit 5000 \
//     --output input/batch_kw.csv

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));

const INPUT =
    argv.input ||
    argv.in ||
    path.join(__dirname, "..", "input", "backbone_active_ab.csv");
const OUTPUT = argv.output || argv.out;
if (!OUTPUT) {
    console.error("❌ --output <batch.csv> is required");
    process.exit(1);
}
const OUTPUT_CSV = path.isAbsolute(OUTPUT)
    ? OUTPUT
    : path.join(__dirname, "..", OUTPUT);

const LIMIT = Math.max(1, parseInt(argv.limit || "5000", 10) || 5000);
const SKIP = Math.max(0, parseInt(argv.skip || "0", 10) || 0);

// SNI prefixes: --sni 46,47 matches any sni_branch_keyword starting 46 or 47.
const SNI_PREFIXES = String(argv.sni || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Free-text regex over company_name + verksamhetsbeskrivning + industries.
const TEXT_RE = argv.text ? new RegExp(String(argv.text), "i") : null;

// Optional location filters (substring, case-insensitive) over post_place.
const KOMMUN = argv.kommun ? String(argv.kommun).toUpperCase() : null;

// ---- minimal quote-aware CSV line splitter (matches build_backbone output) ----
function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (q && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else q = !q;
        } else if (ch === "," && !q) {
            out.push(cur);
            cur = "";
        } else cur += ch;
    }
    out.push(cur);
    return out;
}

(async () => {
    console.log("🔪 Filtering backbone into a scrape batch");
    console.log("====================================");
    console.log(`Input:   ${INPUT}`);
    console.log(`Output:  ${OUTPUT_CSV}`);
    console.log(`SNI:     ${SNI_PREFIXES.join(", ") || "(any)"}`);
    console.log(`Text:    ${TEXT_RE ? TEXT_RE.source : "(none)"}`);
    console.log(`Kommun:  ${KOMMUN || "(any)"}`);
    console.log(`Limit:   ${LIMIT}   Skip: ${SKIP}`);
    console.log("====================================\n");

    fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
    const out = fs.createWriteStream(OUTPUT_CSV, { encoding: "utf8" });

    const rl = readline.createInterface({
        input: fs.createReadStream(INPUT, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    let header = null;
    let col = {};
    let matched = 0; // total rows matching the filter (across skip+kept)
    let written = 0;
    let scanned = 0;

    for await (const line of rl) {
        if (!header) {
            header = line;
            out.write(header + "\n");
            splitCsvLine(line).forEach((h, i) => (col[h.trim()] = i));
            continue;
        }
        if (!line.trim()) continue;
        scanned++;

        const f = splitCsvLine(line);
        const sni = (f[col.sni_branch_keyword] || "").trim();
        const place = (f[col.post_place] || "").toUpperCase();
        const hay =
            (f[col.company_name] || "") +
            " " +
            (f[col.industries] || "") +
            " " +
            (f[col.verksamhetsbeskrivning] || "");

        if (SNI_PREFIXES.length && !SNI_PREFIXES.some((p) => sni.startsWith(p)))
            continue;
        if (TEXT_RE && !TEXT_RE.test(hay)) continue;
        if (KOMMUN && !place.includes(KOMMUN)) continue;

        matched++;
        if (matched <= SKIP) continue; // resume support
        out.write(line + "\n");
        if (++written >= LIMIT) break;
    }

    await new Promise((res) => out.end(res));
    console.log("====================================");
    console.log(`Scanned:        ${scanned}`);
    console.log(`Matched filter: ${matched}`);
    console.log(`Written (batch):${written}  (skipped first ${SKIP})`);
    console.log(`Output:         ${OUTPUT_CSV}`);
    console.log(
        `Next batch:     re-run with --skip ${SKIP + written} (same filters)`,
    );
    console.log("====================================");
})().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
