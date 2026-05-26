// source_candidates_allabolag.js
// STAGE 1 of the Enrichely lead pipeline.
//
// Pulls candidate Swedish AB companies from allabolag.se's structured
// SNI/NACE segmentation endpoint (/segmentering?naceIndustry=XX.XXX),
// filters by omsättning band (2.5 – 25 MSEK with a 5–15 MSEK "sweet_spot"
// flag), deduplicates by orgnr, and writes a CSV that feeds into Stage 2
// (resolve_websites.js).
//
// We iterate a curated ICP set of SNI 2025 codes (retail / e-commerce /
// wholesale) defined in ICP_SNI_CODES below — edit there to tune the ICP.
// /segmentering returns exact-match NACE results, so off-ICP keyword
// pollution that plagued the old /bransch-sök approach is gone.
//
// Usage:
//   npm run source-candidates -- --output input/candidates.csv
//   npm run source-candidates -- --codes "47.910,47.190" --maxPages 50
//   npm run source-candidates -- --revMinSEK 2500000 --revMaxSEK 25000000

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
    path.join(__dirname, "..", "input", "candidates.csv");

// 2.5 – 25 MSEK hard band; 5 – 15 MSEK = sweet spot
const REV_MIN = parseInt(argv.revMinSEK || "2500000", 10);
const REV_MAX = parseInt(argv.revMaxSEK || "25000000", 10);
const REV_SWEET_MIN = parseInt(argv.revSweetMinSEK || "5000000", 10);
const REV_SWEET_MAX = parseInt(argv.revSweetMaxSEK || "15000000", 10);

// /segmentering paginates 10 rows/page. A 1000-hit code = 100 pages.
// Default of 200 covers every code in the curated list (largest is 47.190
// at ~6000 hits = 600 pages, but yield-per-page drops past 200).
const MAX_PAGES = Math.max(1, parseInt(argv.maxPages || "200", 10) || 200);
const PAGE_DELAY_MS = Math.max(
    300,
    parseInt(argv.delayMs || "1500", 10) || 1500,
);

const KEEP_UNKNOWN_REVENUE =
    argv.keepUnknownRevenue !== false &&
    String(argv.keepUnknownRevenue || "true").toLowerCase() !== "false";

const KEEP_SHELLS =
    argv.keepShells === true ||
    String(argv.keepShells || "false").toLowerCase() === "true";

// ---- Curated ICP SNI codes (3-digit NACE form, validated against allabolag) ----
// Codes sourced from testing/snibranscher (SNI-koder tree). Only 3-digit
// granularity is present in that file for section G, but each 3-digit code
// rolls up all 4/5-digit subdivisions below it on allabolag.
//
// Confirmed hit counts (smoke tested):
//   47.1 → 49,162   47.9 → 1,966   47 → 148,298   46.4 → 25,541
//
// /segmentering gives EXACT-match NACE results per code, so off-ICP
// keyword pollution is gone — every row under 47.9 IS retail.
const DEFAULT_ICP_SNI_CODES = [
    // ---- Section G: Detaljhandel (B2C retail) ----
    { code: "47.1", label: "Detaljhandel i icke-specialiserade butiker (varuhus, livsmedel)" },
    { code: "47.2", label: "Specialiserad detaljhandel med livsmedel, drycker, tobak" },
    { code: "47.3", label: "Detaljhandel med drivmedel" }, // borderline ICP, keep
    { code: "47.4", label: "Detaljhandel, informations- och kommunikationsutrustning (datorer, telekom)" },
    { code: "47.5", label: "Detaljhandel, övrig hushållsutrustning i specialbutik (möbler, järn, färg, vitvaror)" },
    { code: "47.6", label: "Detaljhandel, kultur- och fritidsvaror i specialbutik (böcker, sport, leksaker, musik)" },
    { code: "47.7", label: "Detaljhandel, övriga varor i specialbutik (kläder, skor, kosmetika, optik, guld, blommor)" },
    { code: "47.8", label: "Torg- och marknadshandel" },
    { code: "47.9", label: "Detaljhandel ej i butik, på torg eller marknad (postorder, e-handel)" },

    // ---- Section G: Partihandel (B2B wholesale to retailers) ----
    { code: "46.1", label: "Provisionshandel" },
    { code: "46.2", label: "Partihandel, jordbruksråvaror och levande djur" },
    { code: "46.3", label: "Partihandel, livsmedel, drycker och tobak" },
    { code: "46.4", label: "Partihandel, hushållsvaror (kläder, skor, möbler, ur, kosmetika, böcker, sport)" },
    { code: "46.5", label: "Partihandel, informations- och kommunikationsutrustning" },
    { code: "46.6", label: "Partihandel, andra maskiner, utrustning och tillbehör" },
    { code: "46.7", label: "Övrig specialiserad partihandel" },
    { code: "46.9", label: "Icke-specialiserad partihandel" },
];

const ICP_SNI_CODES = (() => {
    const raw = argv.codes || argv.sniCodes;
    if (!raw) return DEFAULT_ICP_SNI_CODES;
    return String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((code) => ({ code, label: code }));
})();

// Output columns are unchanged from the keyword version so Stages 2/3
// keep working without modification.
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
                    "Accept-Language":
                        "sv-SE,sv;q=0.9,en-US;q=0.7,en;q=0.6",
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

// ---- URL builder for /segmentering ----
function buildSegmenteringUrl(naceCode, page) {
    const base = `https://www.allabolag.se/segmentering?naceIndustry=${encodeURIComponent(naceCode)}`;
    return page > 1 ? `${base}&page=${page}` : base;
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

// ---- Parse /segmentering page from __NEXT_DATA__ ----
// Shape: data.props.pageProps.{ companies, numberOfHits, pagination }
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

// ---- Revenue parsing + band classification ----
// /segmentering returns revenue as a NUMBER in tkr (thousands of SEK).
// e.g. revenue: 2168 = 2,168,000 SEK.
function parseRevenueToSEK(rawRevenue) {
    if (rawRevenue == null || rawRevenue === "") return null;
    const tkr =
        typeof rawRevenue === "number"
            ? rawRevenue
            : parseInt(String(rawRevenue).replace(/[^\d-]/g, ""), 10);
    if (!Number.isFinite(tkr)) return null;
    return tkr * 1000;
}

function classifyRevenue(revSEK) {
    if (revSEK == null || revSEK === 0 || !Number.isFinite(revSEK)) {
        return { tier: "unknown", inBand: KEEP_UNKNOWN_REVENUE };
    }
    if (revSEK < REV_MIN) return { tier: "under", inBand: false };
    if (revSEK > REV_MAX) return { tier: "over", inBand: false };
    if (revSEK >= REV_SWEET_MIN && revSEK <= REV_SWEET_MAX)
        return { tier: "sweet_spot", inBand: true };
    return { tier: "in_band", inBand: true };
}

// Shell / dormant: 0 employees AND (no revenue OR revenue < 100k SEK).
function isLikelyShell(revSEK, employees) {
    const emp =
        parseInt(String(employees || "0").replace(/\D/g, ""), 10) || 0;
    if (emp > 0) return false;
    if (revSEK == null) return true;
    return revSEK < 100_000;
}

// ---- Field extractors for /segmentering shape ----
function extractPhone(c) {
    const arr = c.phoneNumbers;
    if (!Array.isArray(arr) || arr.length === 0) return c.phone || "";
    const first = arr[0];
    if (typeof first === "string") return first;
    return first?.number || first?.value || "";
}

function extractCurrentIndustry(c) {
    const arr = c.naceCategories;
    if (!Array.isArray(arr) || arr.length === 0) return "";
    // naceCategories look like "47910 Förmedling avseende ..."
    // Strip the leading code for the human-readable name.
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

// ---- Main ----
(async () => {
    console.log("📋 Stage 1: Allabolag candidate sourcing (SNI segmentering)");
    console.log("====================================");
    console.log(`Output:        ${OUTPUT_CSV}`);
    console.log(
        `Revenue band:  ${REV_MIN.toLocaleString()} – ${REV_MAX.toLocaleString()} SEK`,
    );
    console.log(
        `Sweet spot:    ${REV_SWEET_MIN.toLocaleString()} – ${REV_SWEET_MAX.toLocaleString()} SEK`,
    );
    console.log(`Keep unknown:  ${KEEP_UNKNOWN_REVENUE}`);
    console.log(`SNI codes:     ${ICP_SNI_CODES.length}`);
    console.log(`Max pages/code:${MAX_PAGES}`);
    console.log(`Delay/page:    ${PAGE_DELAY_MS}ms`);
    console.log("====================================\n");

    fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });

    const byOrgnr = new Map();
    const rejectionCounts = {};
    let totalSeen = 0;
    let totalKept = 0;

    for (let i = 0; i < ICP_SNI_CODES.length; i++) {
        const { code, label } = ICP_SNI_CODES[i];
        const tag = `${code} — ${label}`;
        console.log(`\n[${i + 1}/${ICP_SNI_CODES.length}] ${tag}`);

        let page = 1;
        let pagesTotal = 1;
        while (page <= MAX_PAGES && page <= pagesTotal) {
            const url = buildSegmenteringUrl(code, page);
            let html;
            try {
                html = await httpGetWithRetry(url);
            } catch (e) {
                console.warn(`   ⚠️  ${e.message} (skipping page after retries)`);
                page++;
                await delay(PAGE_DELAY_MS);
                continue;
            }
            const parsed = parseSegmenteringPage(html);
            if (page === 1) {
                pagesTotal = parsed.pages || 0;
                console.log(
                    `   hits=${parsed.hits}  pages=${parsed.pages}  (will scan up to ${Math.min(
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

                // AB only: 10-digit orgnr starting with 55. /segmentering
                // also returns 14-digit enskild-firma ids — skip those.
                if (orgnrRaw.length !== 10) continue;
                if (!/^55/.test(orgnrRaw)) continue;

                const revSEK = parseRevenueToSEK(c.revenue);
                const band = classifyRevenue(revSEK);
                if (!band.inBand) {
                    rejectionCounts[`rev_${band.tier}`] =
                        (rejectionCounts[`rev_${band.tier}`] || 0) + 1;
                    continue;
                }

                const employees = c.numberOfEmployees ?? c.employees ?? "";
                if (!KEEP_SHELLS && isLikelyShell(revSEK, employees)) {
                    rejectionCounts.shell =
                        (rejectionCounts.shell || 0) + 1;
                    continue;
                }

                const formatted = {
                    orgnr: `${orgnrRaw.slice(0, 6)}-${orgnrRaw.slice(6)}`,
                    company_name: c.name || c.displayName || "",
                    legal_name: c.displayName || c.name || "",
                    sni_branch_keyword: code,
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
                    revenue_tier: band.tier,
                    in_revenue_band: band.inBand ? "true" : "false",
                    employees: employees || "",
                    status: extractStatus(c),
                    phone: extractPhone(c),
                    email_from_allabolag: c.email || "",
                    homepage_from_allabolag: c.homePage || "",
                    target_url: c.homePage || "",
                    allabolag_url: buildAllabolagCompanyUrl(c),
                };

                const prev = byOrgnr.get(orgnrRaw);
                if (!prev) {
                    byOrgnr.set(orgnrRaw, formatted);
                    totalKept++;
                } else {
                    const score = (r) =>
                        (r.revenue_sek ? 2 : 0) +
                        (r.homepage_from_allabolag ? 1 : 0);
                    if (score(formatted) > score(prev)) {
                        const merged = { ...formatted };
                        const codes = new Set(
                            [prev.sni_branch_keyword, code].filter(Boolean),
                        );
                        merged.sni_branch_keyword = [...codes].join(" | ");
                        byOrgnr.set(orgnrRaw, merged);
                    } else {
                        const codes = new Set(
                            [prev.sni_branch_keyword, code].filter(Boolean),
                        );
                        prev.sni_branch_keyword = [...codes].join(" | ");
                    }
                }
            }

            page++;
            await delay(PAGE_DELAY_MS);
        }

        // Save progress between codes so a crash doesn't lose hours of work.
        if ((i + 1) % 3 === 0 || i === ICP_SNI_CODES.length - 1) {
            const rows = [...byOrgnr.values()];
            const csv = Papa.unparse(rows, { columns: OUTPUT_COLUMNS });
            fs.writeFileSync(OUTPUT_CSV, csv, "utf8");
            console.log(
                `   💾 saved ${rows.length} rows so far → ${OUTPUT_CSV}`,
            );
        }
    }

    const rows = [...byOrgnr.values()];
    rows.sort((a, b) => {
        const tierOrder = { sweet_spot: 0, in_band: 1, unknown: 2 };
        const t =
            (tierOrder[a.revenue_tier] ?? 3) -
            (tierOrder[b.revenue_tier] ?? 3);
        if (t !== 0) return t;
        return (b.revenue_sek || 0) - (a.revenue_sek || 0);
    });
    const csv = Papa.unparse(rows, { columns: OUTPUT_COLUMNS });
    fs.writeFileSync(OUTPUT_CSV, csv, "utf8");

    const tierCount = rows.reduce((acc, r) => {
        acc[r.revenue_tier] = (acc[r.revenue_tier] || 0) + 1;
        return acc;
    }, {});

    console.log("\n====================================");
    console.log("✅ Stage 1 done");
    console.log(`Companies seen:      ${totalSeen}`);
    console.log(`Companies kept:      ${rows.length}`);
    console.log(`  sweet_spot:        ${tierCount.sweet_spot || 0}`);
    console.log(`  in_band:           ${tierCount.in_band || 0}`);
    console.log(`  unknown_revenue:   ${tierCount.unknown || 0}`);
    console.log(
        `With homePage already: ${rows.filter((r) => r.homepage_from_allabolag).length}`,
    );
    const rkeys = Object.keys(rejectionCounts).sort();
    if (rkeys.length) {
        console.log(`Rejections (by reason):`);
        for (const k of rkeys)
            console.log(`  ${k}: ${rejectionCounts[k]}`);
    }
    console.log(`Output: ${OUTPUT_CSV}`);
    console.log("====================================");
})().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
