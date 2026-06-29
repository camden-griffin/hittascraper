// build_backbone.js
// STAGE 0 of the Enrichely lead pipeline (registry ingest).
//
// Turns the free Bolagsverket + SCB "värdefulla datamängder" bulk files into a
// clean backbone CSV that drops straight into Stage 2 (resolve_websites.js) and
// can be enriched by Stage 1 (source_candidates_allabolag.js) by orgnr.
//
// It:
//   1. Streams bolagsverket_bulkfil.txt (";"-delimited, quote-aware, with
//      "$TAG" markers and packed name/date subfields), filters to ACTIVE
//      AKTIEBOLAG (AB-ORGFO, empty avregistreringsdatum), and parses orgnr,
//      name, business description, address.
//   2. Streams scb_bulkfil_*.txt (TAB-delimited, LATIN-1 encoded) into a
//      lookup of orgnr -> { sni codes, address, status } and joins it on.
//   3. Emits backbone CSV with the columns Stage 2 reads (orgnr, company_name,
//      sni_branch_keyword, address fields, homepage_from_allabolag,
//      target_url) so no scraper changes are needed.
//
// Usage:
//   node src/build_backbone.js \
//     --bv registry_data/bolagsverket_bulkfil.txt \
//     --scb registry_data/scb_bulkfil_JE_20260615T062613_78.txt \
//     --output input/backbone_active_ab.csv

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));

const BV_FILE =
    argv.bv ||
    path.join(__dirname, "..", "registry_data", "bolagsverket_bulkfil.txt");
const SCB_FILE = argv.scb || findScbFile();
const OUTPUT_CSV =
    argv.output ||
    argv.out ||
    path.join(__dirname, "..", "input", "backbone_active_ab.csv");

// Scope flags (default = active AB only, per the chosen scope).
const INCLUDE_DEREGISTERED =
    argv.includeDeregistered === true ||
    String(argv.includeDeregistered || "").toLowerCase() === "true";

function findScbFile() {
    const dir = path.join(__dirname, "..", "registry_data");
    try {
        const f = fs
            .readdirSync(dir)
            .find((n) => /^scb_bulkfil.*\.txt$/i.test(n));
        if (f) return path.join(dir, f);
    } catch {}
    return path.join(dir, "scb_bulkfil.txt");
}

// ---- CSV escaping ----
function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---- Quote-aware split for the Bolagsverket ";"-delimited, "-quoted format ----
// Fields are wrapped in double quotes and may themselves contain ";" inside the
// quotes, so a naive split on ";" is wrong (see the embedded-handelsbolag rows).
function splitBvLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ";" && !inQuotes) {
            out.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

// "5560012402$ORGNR-IDORG" -> "5560012402"
function stripTag(v) {
    if (!v) return "";
    const i = v.indexOf("$");
    return (i === -1 ? v : v.slice(0, i)).trim();
}

// "Castolin Scandinavia Aktiebolag$FORETAGSNAMN-ORGNAM$2001-04-..." -> name only
function unpackName(v) {
    if (!v) return "";
    return v.split("$")[0].trim();
}

// postadress packs "Storgatan 100$$SOLLEFTEÅ$88140$SE-LAND"
// shape (observed): street $ (extra) $ postort $ postnr $ land
function unpackAddress(v) {
    const parts = (v || "").split("$");
    const street = (parts[0] || "").trim();
    const postOrt = (parts[2] || "").trim();
    const postNr = (parts[3] || "").trim();
    return { street, postOrt, postNr };
}

const dash = (orgnr10) =>
    orgnr10.length === 10 ? `${orgnr10.slice(0, 6)}-${orgnr10.slice(6)}` : orgnr10;

// ---- Pass A: build SCB lookup (orgnr -> sni + address + status) ----
// SCB is TAB-delimited, LATIN-1. PeOrgNr is 12-digit; AB orgnr is the last 10
// digits (the 12-digit form zero/century-prefixes). We key by the 10-digit AB
// orgnr (strip to last 10, must start with 55 after stripping leading "16"/"55"
// century markers — we just take trailing 10 and match what BV emits).
async function buildScbLookup() {
    const map = new Map();
    if (!fs.existsSync(SCB_FILE)) {
        console.warn(`⚠️  SCB file not found at ${SCB_FILE} — SNI/address join skipped.`);
        return map;
    }
    // SCB is LATIN-1. Read as a binary stream and decode each chunk with the
    // built-in "latin1" Buffer codec — no external iconv dependency needed.
    const stream = fs.createReadStream(SCB_FILE);
    stream.setEncoding("latin1");
    const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
    });
    let header = null;
    let idx = {};
    let n = 0;
    for await (const line of rl) {
        if (!header) {
            header = line.split("\t");
            header.forEach((h, i) => (idx[h.trim()] = i));
            continue;
        }
        const f = line.split("\t");
        const peOrg = (f[idx.PeOrgNr] || "").replace(/\D/g, "");
        if (peOrg.length < 10) continue;
        const org10 = peOrg.slice(-10);
        if (!/^55/.test(org10)) continue; // AB only
        const sni = [
            f[idx.Ng1],
            f[idx.Ng2],
            f[idx.Ng3],
            f[idx.Ng4],
            f[idx.Ng5],
        ]
            .map((s) => (s || "").trim())
            .filter(Boolean);
        map.set(org10, {
            sni1: sni[0] || "",
            sni_all: sni.join("; "),
            gatuadress: (f[idx.Gatuadress] || "").trim(),
            postnr: (f[idx.PostNr] || "").trim(),
            postort: (f[idx.PostOrt] || "").trim(),
            ftgstat: (f[idx.FtgStat] || "").trim(),
        });
        if (++n % 200000 === 0) console.log(`   SCB indexed ${n}…`);
    }
    console.log(`   SCB lookup built: ${map.size} AB rows`);
    return map;
}

// ---- Pass B: stream Bolagsverket, filter active AB, join SCB, write CSV ----
const OUTPUT_COLUMNS = [
    "orgnr",
    "company_name",
    "sni_branch_keyword",
    "current_industry",
    "industries",
    "post_place",
    "zip_code",
    "address",
    "verksamhetsbeskrivning",
    "registration_date",
    "status",
    "email_from_allabolag",
    "homepage_from_allabolag",
    "target_url",
    "allabolag_url",
];

(async () => {
    console.log("📋 Stage 0: Registry backbone ingest");
    console.log("====================================");
    console.log(`Bolagsverket:  ${BV_FILE}`);
    console.log(`SCB:           ${SCB_FILE}`);
    console.log(`Output:        ${OUTPUT_CSV}`);
    console.log(`Scope:         active AB only${INCLUDE_DEREGISTERED ? " (+deregistered)" : ""}`);
    console.log("====================================\n");

    console.log("→ Pass A: indexing SCB for SNI/address join…");
    const scb = await buildScbLookup();

    console.log("\n→ Pass B: streaming Bolagsverket, filtering active AB…");
    fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
    const out = fs.createWriteStream(OUTPUT_CSV, { encoding: "utf8" });
    out.write(OUTPUT_COLUMNS.join(",") + "\n");

    const rl = readline.createInterface({
        input: fs.createReadStream(BV_FILE, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    let header = null;
    let idx = {};
    let seen = 0;
    let kept = 0;
    let withSni = 0;
    for await (const line of rl) {
        if (!header) {
            header = splitBvLine(line);
            header.forEach((h, i) => (idx[h.trim()] = i));
            continue;
        }
        if (!line.trim()) continue;
        seen++;
        const f = splitBvLine(line);

        const form = stripTag(f[idx.organisationsform]);
        if (form !== "AB-ORGFO") continue;

        const dereg = (f[idx.avregistreringsdatum] || "").trim();
        if (!INCLUDE_DEREGISTERED && dereg) continue;

        const orgnr10 = stripTag(f[idx.organisationsidentitet]).replace(/\D/g, "");
        if (orgnr10.length !== 10 || !/^55/.test(orgnr10)) continue;

        const name = unpackName(f[idx.organisationsnamn]);
        const addr = unpackAddress(f[idx.postadress]);
        const verk = (f[idx.verksamhetsbeskrivning] || "").trim();
        const regdat = stripTag(f[idx.registreringsdatum]);

        const s = scb.get(orgnr10);
        if (s && s.sni1) withSni++;

        const row = {
            orgnr: dash(orgnr10),
            company_name: name,
            sni_branch_keyword: s ? s.sni1 : "",
            current_industry: "",
            industries: s ? s.sni_all : "",
            post_place: (s && s.postort) || addr.postOrt || "",
            zip_code: (s && s.postnr) || addr.postNr || "",
            address: (s && s.gatuadress) || addr.street || "",
            verksamhetsbeskrivning: verk,
            registration_date: regdat,
            status: dereg ? `deregistered:${dereg}` : "active",
            email_from_allabolag: "",
            homepage_from_allabolag: "",
            target_url: "",
            allabolag_url: "",
        };
        out.write(OUTPUT_COLUMNS.map((c) => csvCell(row[c])).join(",") + "\n");
        kept++;
        if (kept % 100000 === 0) console.log(`   kept ${kept}…`);
    }

    await new Promise((res) => out.end(res));
    console.log("\n====================================");
    console.log("✅ Stage 0 done");
    console.log(`BV rows scanned:   ${seen}`);
    console.log(`Active AB kept:    ${kept}`);
    console.log(`  with SCB SNI:    ${withSni}`);
    console.log(`Output:            ${OUTPUT_CSV}`);
    console.log("====================================");
})().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
