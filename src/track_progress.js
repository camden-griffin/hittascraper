// track_progress.js
// Read-only progress dashboard for the registry batch-scraping pipeline.
// Scans input/*_resolved.csv batches, reports how many companies have been
// resolved, the website hit-rate, breakdown by source/confidence, and overall
// coverage against the 817k backbone.
//
// Usage:
//   node src/track_progress.js
//   node src/track_progress.js --dir input --glob "batch_*_resolved.csv"

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));
const DIR = path.isAbsolute(argv.dir || "")
    ? argv.dir
    : path.join(__dirname, "..", argv.dir || "input");
const BACKBONE = path.join(__dirname, "..", "input", "backbone_active_ab.csv");
// Match resolved batches by default. Override with --glob.
const PATTERN = new RegExp(
    "^" +
        String(argv.glob || "*_resolved.csv")
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*") +
        "$",
);

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

async function countBackbone() {
    if (!fs.existsSync(BACKBONE)) return 0;
    let n = 0;
    const rl = readline.createInterface({
        input: fs.createReadStream(BACKBONE, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) if (line.trim()) n++;
    return Math.max(0, n - 1); // minus header
}

async function scanBatch(file) {
    const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    let col = null;
    const stat = {
        total: 0,
        resolved: 0,
        notFound: 0,
        pending: 0,
        email: 0,
        phone: 0,
        bySource: {},
        byConf: {},
    };
    for await (const line of rl) {
        if (!line.trim()) continue;
        if (!col) {
            col = {};
            splitCsvLine(line).forEach((h, i) => (col[h.trim()] = i));
            continue;
        }
        const f = splitCsvLine(line);
        stat.total++;
        const url = (f[col.target_url] || "").trim();
        const src = (f[col.target_url_source] || "").trim();
        const conf = (f[col.target_url_confidence] || "").trim();
        if (url) {
            stat.resolved++;
            if (src) stat.bySource[src] = (stat.bySource[src] || 0) + 1;
            if (conf) stat.byConf[conf] = (stat.byConf[conf] || 0) + 1;
        } else if (src.toLowerCase() === "not_found") {
            stat.notFound++;
            stat.bySource["not_found"] = (stat.bySource["not_found"] || 0) + 1;
        } else {
            stat.pending++;
        }
        // contact extraction columns (present only in *_with_domain_enrichment.csv)
        if (col.email !== undefined && (f[col.email] || "").trim()) stat.email++;
        if (col.phone !== undefined && (f[col.phone] || "").trim()) stat.phone++;
    }
    return stat;
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");

// --watch [seconds]: redraw on an interval so progress updates live.
// `--watch` alone defaults to 15s; `--watch 30` polls every 30s.
const WATCH_SECONDS =
    argv.watch === undefined || argv.watch === false
        ? 0
        : Math.max(2, parseInt(argv.watch, 10) || 15);

// The backbone row count reads a 232MB file, but never changes during a run —
// cache it across refreshes so --watch stays cheap.
let backboneCache = null;

async function render() {
    const files = fs.existsSync(DIR)
        ? fs
              .readdirSync(DIR)
              .filter((n) => PATTERN.test(n))
              .map((n) => path.join(DIR, n))
        : [];

    if (WATCH_SECONDS) {
        // Clear screen + move cursor home so each refresh redraws in place.
        process.stdout.write("\x1b[2J\x1b[H");
    }
    console.log(
        `\n📊 Scraping progress${WATCH_SECONDS ? `  (live, every ${WATCH_SECONDS}s — Ctrl-C to stop)` : ""}  ${new Date().toLocaleTimeString()}`,
    );
    console.log("====================================");
    if (!files.length) {
        console.log(`No batches matching ${PATTERN} in ${DIR}`);
        if (!WATCH_SECONDS) process.exit(0);
        return;
    }

    const totals = {
        total: 0,
        resolved: 0,
        notFound: 0,
        pending: 0,
        email: 0,
        phone: 0,
        bySource: {},
        byConf: {},
    };

    for (const file of files.sort()) {
        const s = await scanBatch(file);
        const done = s.resolved + s.notFound;
        const contacts =
            s.email || s.phone
                ? `  |  email ${s.email} (${pct(s.email, s.resolved)} of sites)  phone ${s.phone}`
                : "";
        console.log(
            `\n${path.basename(file)}` +
                `\n  processed ${done}/${s.total} (${pct(done, s.total)})` +
                `  |  websites ${s.resolved} (${pct(s.resolved, s.total)})` +
                `  not_found ${s.notFound}  pending ${s.pending}` +
                contacts,
        );
        totals.total += s.total;
        totals.resolved += s.resolved;
        totals.notFound += s.notFound;
        totals.pending += s.pending;
        totals.email += s.email;
        totals.phone += s.phone;
        for (const k in s.bySource)
            totals.bySource[k] = (totals.bySource[k] || 0) + s.bySource[k];
        for (const k in s.byConf)
            totals.byConf[k] = (totals.byConf[k] || 0) + s.byConf[k];
    }

    if (backboneCache === null) backboneCache = await countBackbone();
    const backbone = backboneCache;
    const done = totals.resolved + totals.notFound;

    console.log("\n------------------------------------");
    console.log("TOTAL across all batches");
    console.log(`  rows in batches:   ${totals.total}`);
    console.log(`  processed:         ${done} (${pct(done, totals.total)})`);
    console.log(
        `  websites found:    ${totals.resolved} (${pct(totals.resolved, totals.total)} of processed batches)`,
    );
    console.log(`  not_found:         ${totals.notFound}`);
    console.log(`  pending in batch:  ${totals.pending}`);
    console.log(
        `  emails extracted:  ${totals.email} (${pct(totals.email, totals.resolved)} of sites with a website)`,
    );
    console.log(`  phones extracted:  ${totals.phone} (${pct(totals.phone, totals.resolved)} of sites)`);
    console.log("  by source:        ", JSON.stringify(totals.bySource));
    console.log("  by confidence:    ", JSON.stringify(totals.byConf));
    if (backbone) {
        console.log("------------------------------------");
        console.log(
            `  backbone total:    ${backbone} active AB` +
                `\n  coverage:          ${done}/${backbone} processed (${pct(done, backbone)})`,
        );
    }
    console.log("====================================\n");
}

(async () => {
    if (!WATCH_SECONDS) {
        await render();
        return;
    }
    // Live mode: render now, then on an interval until Ctrl-C.
    const tick = async () => {
        try {
            await render();
        } catch (e) {
            console.error("❌ render error:", e.message);
        }
    };
    await tick();
    const timer = setInterval(tick, WATCH_SECONDS * 1000);
    process.on("SIGINT", () => {
        clearInterval(timer);
        console.log("\n👋 stopped watching.");
        process.exit(0);
    });
})().catch((e) => {
    console.error("❌", e);
    process.exit(1);
});
