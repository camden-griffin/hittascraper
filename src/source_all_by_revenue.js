// source_all_by_revenue.js
// STAGE 1 (alt) — full-population sourcing by REVENUE BAND instead of SNI code.
//
// Instead of iterating ICP industry codes (source_candidates_allabolag.js),
// this pulls the ENTIRE population of Swedish AB with 0–35 employees across
// the whole 2–35 MSEK revenue range, sliced into revenue bands so no single
// segmentation query is too large. allabolag's /segmentering __NEXT_DATA__
// endpoint paginates the FULL result set (10 rows/page, no 10k cap — the 10k
// / 5k cap only applies to the paid Excel export), so every band is fully
// retrievable.
//
// Constant filters on every request (per the ICP screenshot):
//   companyType=AB                         (bolagsform: aktiebolag)
//   numEmployeesFrom=0 & numEmployeesTo=35 (anställda: 0–35 — BOTH bounds
//                                           required or the filter is ignored)
//   no naceIndustry                        (bransch: none / all)
// Only revenueFrom / revenueTo vary, per band below.
//
// Output columns are identical to source_candidates_allabolag.js so Stage 2
// (resolve_websites.js) and downstream keep working unchanged.
//
// Usage:
//   node src/source_all_by_revenue.js --output input/backbone_active_ab.csv
//   node src/source_all_by_revenue.js --maxPages 100        (cap pages/band)
//   node src/source_all_by_revenue.js --delayMs 1200
//   node src/source_all_by_revenue.js --bands 2000-2150,2150-2350
//   node src/source_all_by_revenue.js --resume               (skip done bands)

const fs = require("fs");
const path = require("path");
const https = require("https");
const Papa = require("papaparse");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));

// ---- Defaults / CLI ----
const OUTPUT_CSV =
    argv.output ||
    argv.out ||
    path.join(__dirname, "..", "input", "backbone_active_ab.csv");

// Constant filters (held fixed on every request — only revenue varies).
const COMPANY_TYPE = "AB";
const EMP_FROM = 0;
const EMP_TO = 35;

// Revenue is expressed in tkr (thousands of SEK) in the allabolag URL —
// revenueFrom=2000 == 2,000,000 SEK. These are the exact bands from the
// ICP screenshot; each is <10k hits so it paginates cleanly.
const DEFAULT_BANDS = [
    [2000, 2150],
    [2150, 2350],
    [2350, 2550],
    [2550, 2800],
    [2800, 3100],
    [3100, 3450],
    [3450, 3850],
    [3850, 4350],
    [4350, 4950],
    [4950, 5650],
    [5650, 6500],
    [6500, 7550],
    [7550, 8900],
    [8900, 10500],
    [10500, 12500],
    [12500, 15250],
    [15250, 19250],
    [19250, 25250],
    [25250, 35000],
];

const BANDS = (() => {
    const raw = argv.bands;
    if (!raw) return DEFAULT_BANDS;
    return String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pair) => pair.split("-").map((n) => parseInt(n.trim(), 10)))
        .filter((p) => p.length === 2 && p.every(Number.isFinite));
})();

// Safety cap on pages/band. A ~10k band = ~1000 pages. Default high enough
// to drain any band fully; lower it for a quick smoke test.
const MAX_PAGES = Math.max(1, parseInt(argv.maxPages || "1200", 10) || 1200);
const PAGE_DELAY_MS = Math.max(
    300,
    parseInt(argv.delayMs || "1200", 10) || 1200,
);

const RESUME = argv.resume === true || String(argv.resume) === "true";

// Optional contact filters. allabolag exposes "Visa bara företag med E-post /
// Telefon" as URL params email=true / phone=true. These narrow the result set
// to companies allabolag has an email/phone on record for (the VALUE stays
// null in the payload — you still scrape hitta.se for the actual address — but
// this gives a free, precise target list: ~18k have email, ~48k have phone,
// out of ~178k). Use --onlyEmail and/or --onlyPhone.
const ONLY_EMAIL = argv.onlyEmail === true || String(argv.onlyEmail) === "true";
const ONLY_PHONE = argv.onlyPhone === true || String(argv.onlyPhone) === "true";

// Keep everything — this is a full-population pull, so no revenue-band or
// shell filtering. Downstream stages decide what to enrich.
const KEEP_ALL = true;

const OUTPUT_COLUMNS = [
    "orgnr",
    "company_name",
    "legal_name",
    "sni_branch_keyword",
    "current_industry",
    "industries",
    "county",
    "municipality",
    "post_place",
    "zip_code",
    "address",
    "revenue_sek",
    "revenue_year",
    "revenue_tier",
    "in_revenue_band",
    "employees",
    "status",
    "phone",
    "email_from_allabolag",
    "homepage_from_allabolag",
    "target_url",
    "allabolag_url",
];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ---- HTTPS GET with retry on transient 5xx / timeouts ----
function httpGet(url, timeout = 20000) {
    return new Promise((resolve, reject) => {
        const req = https.get(
            url,
            {
                timeout,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    Accept:
                        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "sv-SE,sv;q=0.9,en-US;q=0.7,en;q=0.6",
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                    return;
                }
                let data = "";
                res.setEncoding("utf8");
                res.on("data", (c) => {
                    data += c;
                    if (data.length > 8 * 1024 * 1024) {
                        req.destroy();
                        reject(new Error("Response too large"));
                    }
                });
                res.on("end", () => resolve(data));
            },
        );
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy(new Error("socket_timeout"));
            reject(new Error(`Timeout for ${url}`));
        });
    });
}

async function httpGetWithRetry(url, { attempts = 4, baseDelayMs = 1500 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await httpGet(url);
        } catch (e) {
            lastErr = e;
            const msg = String(e.message || "");
            const transient =
                /Timeout|socket_timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP 5\d\d|HTTP 429/i.test(
                    msg,
                );
            if (!transient || i === attempts - 1) throw e;
            const wait = baseDelayMs * Math.pow(2, i);
            console.warn(
                `   ↻ retry ${i + 1}/${attempts - 1} in ${wait}ms (${msg})`,
            );
            await delay(wait);
        }
    }
    throw lastErr;
}

// ---- URL builder for /segmentering revenue band ----
// Constant filters + varying revenue. numEmployeesFrom AND numEmployeesTo
// must both be present or allabolag ignores the employee filter entirely.
function buildBandUrl(revFrom, revTo, page) {
    const params = new URLSearchParams({
        companyType: COMPANY_TYPE,
        numEmployeesFrom: String(EMP_FROM),
        numEmployeesTo: String(EMP_TO),
        revenueFrom: String(revFrom),
        revenueTo: String(revTo),
    });
    // Contact-availability filters (values are the bare field name = "true").
    if (ONLY_EMAIL) params.set("email", "true");
    if (ONLY_PHONE) params.set("phone", "true");
    if (page > 1) params.set("page", String(page));
    return `https://www.allabolag.se/segmentering?${params.toString()}`;
}

function buildAllabolagCompanyUrl(c) {
    if (!c) return "";
    const slug = (c.name || c.displayName || "")
        .toLowerCase()
        .replace(/&/g, "och")
        .replace(/[åä]/g, "a")
        .replace(/ö/g, "o")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const city = (c.location?.municipality || "")
        .toLowerCase()
        .replace(/[åä]/g, "a")
        .replace(/ö/g, "o")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const id = c.companyId || c.businessUnitId || "";
    if (!slug || !id) return "";
    return `https://www.allabolag.se/foretag/${slug}/${city || "-"}/-/${id}`;
}

function parseSegmenteringPage(html) {
    const m = html.match(
        /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!m) return { companies: [], hits: 0, pages: 0, currentPage: 0 };
    let data;
    try {
        data = JSON.parse(m[1]);
    } catch {
        return { companies: [], hits: 0, pages: 0, currentPage: 0 };
    }
    const pp = data?.props?.pageProps;
    if (!pp) return { companies: [], hits: 0, pages: 0, currentPage: 0 };
    return {
        companies: Array.isArray(pp.companies) ? pp.companies : [],
        hits: pp.numberOfHits || 0,
        pages: pp.pagination?.numberOfAvailablePages || 0,
        currentPage: pp.pagination?.currentPage || 0,
    };
}

function parseRevenueToSEK(rawRevenue) {
    if (rawRevenue == null || rawRevenue === "") return null;
    const tkr =
        typeof rawRevenue === "number"
            ? rawRevenue
            : parseInt(String(rawRevenue).replace(/[^\d-]/g, ""), 10);
    if (!Number.isFinite(tkr)) return null;
    return tkr * 1000;
}

function extractPhone(c) {
    const p = c.phoneNumbers;
    if (!p) return c.phone || "";
    // /segmentering returns phoneNumbers as an OBJECT:
    //   { telephoneNumber, mobilePhone, faxNumber }
    // (older shapes used an array of strings/objects — handle both).
    if (Array.isArray(p)) {
        const first = p[0];
        if (typeof first === "string") return first;
        return first?.number || first?.value || "";
    }
    if (typeof p === "object") {
        return p.telephoneNumber || p.mobilePhone || "";
    }
    if (typeof p === "string") return p;
    return c.phone || "";
}

function extractCurrentIndustry(c) {
    const arr = c.naceCategories;
    if (!Array.isArray(arr) || arr.length === 0) return "";
    const first = String(arr[0] || "");
    return first.replace(/^\d+\s+/, "");
}

function extractIndustriesList(c) {
    const arr = c.naceCategories;
    if (!Array.isArray(arr)) return "";
    return arr
        .map((s) => String(s || "").replace(/^\d+\s+/, ""))
        .filter(Boolean)
        .join("; ");
}

function extractStatus(c) {
    const s = c.status;
    if (!s) return "";
    if (typeof s === "string") return s;
    return s.status || s.description || "";
}

// ---- Raw append writer ----
// Rows are written raw (no dedup) as we scrape — the same orgnr may appear in
// more than one band, and that's fine: dedupe is a separate downstream step
// (see dedupe_backbone.js). Append-only is faster and crash-resilient.
function ensureHeader(outPath) {
    // Write the header only when starting a fresh file. On --resume we append
    // to whatever is already there.
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
        fs.writeFileSync(outPath, OUTPUT_COLUMNS.join(",") + "\n", "utf8");
        return 0;
    }
    // Count existing data rows (lines minus header) for resume reporting.
    const text = fs.readFileSync(outPath, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    return Math.max(0, lines.length - 1);
}

function appendRows(outPath, rows) {
    if (!rows.length) return;
    // Papa.unparse without the header, then append.
    const csv = Papa.unparse(rows, { columns: OUTPUT_COLUMNS, header: false });
    fs.appendFileSync(outPath, csv + "\n", "utf8");
}

// ---- Main ----
(async () => {
    console.log("📋 Stage 1 (alt): full-population sourcing by REVENUE BAND");
    console.log("====================================");
    console.log(`Output:        ${OUTPUT_CSV}`);
    console.log(`Company type:  ${COMPANY_TYPE} (aktiebolag)`);
    console.log(`Employees:     ${EMP_FROM}–${EMP_TO}`);
    console.log(`Bransch:       (none — full population)`);
    console.log(
        `Contact filter:${ONLY_EMAIL ? " email=true" : ""}${ONLY_PHONE ? " phone=true" : ""}${!ONLY_EMAIL && !ONLY_PHONE ? " (none)" : ""}`,
    );
    console.log(`Revenue bands: ${BANDS.length}`);
    console.log(`Max pages/band:${MAX_PAGES}`);
    console.log(`Delay/page:    ${PAGE_DELAY_MS}ms`);
    console.log(`Resume:        ${RESUME}`);
    console.log("====================================\n");

    fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });

    if (!RESUME && fs.existsSync(OUTPUT_CSV)) fs.rmSync(OUTPUT_CSV);
    const existingCount = ensureHeader(OUTPUT_CSV);
    if (RESUME)
        console.log(`Resuming — ${existingCount} rows already in output (bands re-run will append duplicates; dedupe after).\n`);

    let totalSeen = 0;
    let totalWritten = existingCount;
    let bandsNewCount = [];

    for (let bi = 0; bi < BANDS.length; bi++) {
        const [revFrom, revTo] = BANDS[bi];
        const before = totalWritten;
        console.log(
            `\n[${bi + 1}/${BANDS.length}] omsättning ${revFrom}–${revTo} tkr`,
        );

        let page = 1;
        let pagesTotal = 1;
        let bandHits = 0;
        let bandRows = [];
        while (page <= MAX_PAGES && page <= pagesTotal) {
            const url = buildBandUrl(revFrom, revTo, page);
            let html;
            try {
                html = await httpGetWithRetry(url);
            } catch (e) {
                console.warn(
                    `   ⚠️  ${e.message} (skipping page ${page} after retries)`,
                );
                page++;
                await delay(PAGE_DELAY_MS);
                continue;
            }
            const parsed = parseSegmenteringPage(html);
            if (page === 1) {
                pagesTotal = parsed.pages || 0;
                bandHits = parsed.hits || 0;
                console.log(
                    `   hits=${bandHits}  pages=${pagesTotal}  (scanning up to ${Math.min(
                        pagesTotal,
                        MAX_PAGES,
                    )})`,
                );
                if (!parsed.hits) break;
            }
            totalSeen += parsed.companies.length;

            for (const c of parsed.companies) {
                const orgnrRaw = (c.organisationNumber || c.companyId || "")
                    .toString()
                    .replace(/\D/g, "");

                // AB only: 10-digit orgnr. /segmentering with companyType=AB
                // should already be AB-only, but guard against stray ids.
                if (orgnrRaw.length !== 10) continue;

                const revSEK = parseRevenueToSEK(c.revenue);
                const employees = c.numberOfEmployees ?? c.employees ?? "";

                const formatted = {
                    orgnr: `${orgnrRaw.slice(0, 6)}-${orgnrRaw.slice(6)}`,
                    company_name: c.name || c.displayName || "",
                    legal_name: c.displayName || c.name || "",
                    // record which revenue band this row was sourced from
                    sni_branch_keyword: `rev:${revFrom}-${revTo}`,
                    current_industry: extractCurrentIndustry(c),
                    industries: extractIndustriesList(c),
                    county: c.location?.county || "",
                    municipality: c.location?.municipality || "",
                    post_place:
                        c.visitorAddress?.postPlace ||
                        c.postalAddress?.postPlace ||
                        "",
                    zip_code:
                        c.visitorAddress?.zipCode ||
                        c.postalAddress?.zipCode ||
                        "",
                    address:
                        c.visitorAddress?.addressLine ||
                        c.postalAddress?.addressLine ||
                        "",
                    revenue_sek: revSEK != null ? revSEK : "",
                    revenue_year: c.companyAccountsLastUpdatedDate || "",
                    revenue_tier: "",
                    in_revenue_band: "true",
                    employees: employees || "",
                    status: extractStatus(c),
                    phone: extractPhone(c),
                    email_from_allabolag: c.email || "",
                    homepage_from_allabolag: c.homePage || "",
                    target_url: c.homePage || "",
                    allabolag_url: buildAllabolagCompanyUrl(c),
                };

                // Raw — no dedup. Duplicates across bands are expected and
                // filtered downstream.
                bandRows.push(formatted);
            }

            page++;
            await delay(PAGE_DELAY_MS);
        }

        // Append this band's rows (crash never loses more than one band).
        appendRows(OUTPUT_CSV, bandRows);
        totalWritten += bandRows.length;
        const added = totalWritten - before;
        bandsNewCount.push({ band: `${revFrom}-${revTo}`, hits: bandHits, rows: added });
        console.log(
            `   band done: +${added} rows appended (file total ${totalWritten})`,
        );
        console.log(`   💾 → ${OUTPUT_CSV}`);
    }

    console.log("\n====================================");
    console.log("✅ Stage 1 (revenue-band) done");
    console.log(`Rows seen (pre-dedup):  ${totalSeen}`);
    console.log(`Rows written (raw):     ${totalWritten}`);
    console.log(`\nPer-band summary (hits reported vs rows written):`);
    for (const b of bandsNewCount)
        console.log(`  ${b.band.padEnd(14)} hits=${b.hits}  rows=${b.rows}`);
    console.log(
        `\n⚠️  Rows are RAW (may contain cross-band duplicate orgnrs).`,
    );
    console.log(`   Dedupe with:  node src/dedupe_backbone.js --input ${OUTPUT_CSV}`);
    console.log(`\nOutput: ${OUTPUT_CSV}`);
    console.log("====================================");
})().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
