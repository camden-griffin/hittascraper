#!/usr/bin/env node
// live_progress.js — standalone live scrape dashboard.
//
// Run it in your own terminal:
//   node live_progress.js            # refresh every 10s
//   node live_progress.js 5          # refresh every 5s
//   node live_progress.js --once     # print once and exit
//
// Reads the pipeline outputs in input/ and reports, per batch and in total:
//   processed / websites / emails / phones, plus % of the 817k backbone.
//
// Counts each batch ONCE: for a given batch it prefers the richer
// *_with_domain_enrichment.csv over the plain *_resolved.csv (the enrichment
// file has the website-crawl emails). No double counting.

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const arg = process.argv.slice(2);
const ONCE = arg.includes("--once");
const intervalArg = arg.find((a) => /^\d+$/.test(a));
const INTERVAL = Math.max(2, parseInt(intervalArg || "10", 10) || 10);

const ROOT = __dirname;
const INPUT_DIR = path.join(ROOT, "input");
const BACKBONE = path.join(INPUT_DIR, "backbone_active_ab.csv");

let backboneCache = null;

// minimal quote-aware CSV line splitter
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

async function scan(file) {
    const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    let col = null;
    const s = { total: 0, websites: 0, notFound: 0, email: 0, phone: 0 };
    for await (const line of rl) {
        if (!line.trim()) continue;
        if (!col) {
            col = {};
            splitCsvLine(line).forEach((h, i) => (col[h.trim()] = i));
            continue;
        }
        const f = splitCsvLine(line);
        s.total++;
        const url = (f[col.target_url] ?? "").trim();
        const src = (f[col.target_url_source] ?? "").trim().toLowerCase();
        if (url) s.websites++;
        else if (src === "not_found") s.notFound++;
        if (col.email !== undefined && (f[col.email] || "").trim()) s.email++;
        if (col.phone !== undefined && (f[col.phone] || "").trim()) s.phone++;
    }
    return s;
}

async function countBackbone() {
    if (!fs.existsSync(BACKBONE)) return 0;
    let n = 0;
    const rl = readline.createInterface({
        input: fs.createReadStream(BACKBONE, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    for await (const _ of rl) n++;
    return Math.max(0, n - 1);
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");

// Group batch files by base name; prefer the enrichment version per batch.
function pickFiles() {
    if (!fs.existsSync(INPUT_DIR)) return [];
    const all = fs
        .readdirSync(INPUT_DIR)
        .filter((n) => /_resolved(_with_domain_enrichment)?\.csv$/.test(n))
        .filter((n) => !n.startsWith("candidates_")); // skip old pre-backbone runs
    const byBase = new Map();
    for (const n of all) {
        const base = n.replace(/_with_domain_enrichment\.csv$/, ".csv");
        const isEnriched = n.includes("_with_domain_enrichment");
        const prev = byBase.get(base);
        if (!prev || (isEnriched && !prev.enriched)) {
            byBase.set(base, { name: n, enriched: isEnriched });
        }
    }
    return [...byBase.values()].map((x) => x.name).sort();
}

async function render() {
    const files = pickFiles();
    if (!ONCE) process.stdout.write("\x1b[2J\x1b[H");
    console.log(
        `📊 Scrape progress${ONCE ? "" : `  (live, every ${INTERVAL}s — Ctrl-C to stop)`}   ${new Date().toLocaleTimeString()}`,
    );
    console.log("=".repeat(78));
    if (!files.length) {
        console.log("No batch files found in input/.");
        return;
    }

    const tot = { total: 0, websites: 0, notFound: 0, email: 0, phone: 0 };
    for (const f of files) {
        const s = await scan(path.join(INPUT_DIR, f));
        console.log(
            `${f.replace(/_resolved.*\.csv$/, "").padEnd(26)} ` +
                `rows ${String(s.total).padStart(5)}  ` +
                `web ${String(s.websites).padStart(4)} (${pct(s.websites, s.total).padStart(5)})  ` +
                `email ${String(s.email).padStart(4)}  phone ${String(s.phone).padStart(4)}`,
        );
        tot.total += s.total;
        tot.websites += s.websites;
        tot.notFound += s.notFound;
        tot.email += s.email;
        tot.phone += s.phone;
    }

    if (backboneCache === null) backboneCache = await countBackbone();
    console.log("-".repeat(78));
    console.log(
        `TOTAL  rows ${tot.total}  |  websites ${tot.websites} (${pct(tot.websites, tot.total)})  |  ` +
            `emails ${tot.email} (${pct(tot.email, tot.websites)} of sites)  |  phones ${tot.phone}`,
    );
    if (backboneCache) {
        console.log(
            `Backbone ${backboneCache} active AB  |  coverage ${pct(tot.total, backboneCache)} processed`,
        );
    }
    console.log("=".repeat(78));
}

(async () => {
    await render();
    if (ONCE) return;
    const timer = setInterval(() => render().catch((e) => console.error(e.message)), INTERVAL * 1000);
    process.on("SIGINT", () => {
        clearInterval(timer);
        console.log("\n👋 stopped.");
        process.exit(0);
    });
})();
