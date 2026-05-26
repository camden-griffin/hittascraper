// enrich_and_score_leads.js
// Reads a CSV with a target_url column, deduplicates by domain (origin),
// and for each domain:
//   1. Extracts company_name / orgnr / email / phone / contact_page
//   2. Detects whether the site is a webshop (cart, checkout, providers, sampling)
//   3. If is_webshop, scores SEO gaps across sampled product pages
//      (meta title, meta description, product description length, image alt
//      coverage, JSON-LD Product completeness, title uniqueness)
//   4. Produces a final lead_score so you can rank rows by Enrichely fit.
//
// Pipeline-friendly: writes the same input CSV columns through plus the new
// enrichment / scoring columns. Resume-safe by default.
//
// Usage:
//   npm i papaparse minimist libphonenumber-js dotenv he
//   node src/enrich_and_score_leads.js --input input/input.csv --limit 4000
//   node src/enrich_and_score_leads.js --input input/input.csv --start 2105
//   node src/enrich_and_score_leads.js --input input/input.csv --fresh true

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const puppeteer = require("puppeteer");
const Papa = require("papaparse");
const minimist = require("minimist");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const he = require("he");
require("dotenv").config();

// ---- CLI ----
const argv = minimist(process.argv.slice(2));
const INPUT_CSV = argv.input || argv.in;
const LIMIT = parseInt(argv.limit || "4000", 10);
const URL_COLUMN = argv.urlcol || "target_url";
const START = Math.max(0, parseInt(argv.start ?? argv.offset ?? "0", 10) || 0);
const FRESH =
    argv.fresh === true || String(argv.fresh || "").toLowerCase() === "true";
const HEADLESS =
    argv.headless === true || String(argv.headless || "").toLowerCase() === "true";
// Recycle the puppeteer browser every N domains. Chrome accumulates memory
// and CDP-channel cruft after a few hundred page navigations; recycling
// cleans the slate cheaply.
const BROWSER_RECYCLE_EVERY = Math.max(
    10,
    parseInt(argv.browserRecycleEvery || "60", 10) || 60,
);
const SEO_SAMPLE_COUNT = Math.max(
    1,
    Math.min(15, parseInt(argv.seoSamples || "5", 10) || 5),
);
const resumeRaw = argv.resume ?? process.env.RESUME;
const RESUME =
    !FRESH &&
    (resumeRaw == null
        ? true
        : resumeRaw === true || String(resumeRaw).toLowerCase() === "true");

if (!INPUT_CSV) {
    console.error("❌ Provide --input path/to/file.csv");
    process.exit(1);
}

let OUTPUT_CSV = argv.output || argv.out;
if (!OUTPUT_CSV) {
    const inputDir = path.dirname(INPUT_CSV);
    const inputName = path.basename(INPUT_CSV, path.extname(INPUT_CSV));
    OUTPUT_CSV = path.join(inputDir, `${inputName}_enriched_scored.csv`);
}

const OUTPUT_COLUMNS = [
    "domain",
    "company_name",
    "orgnr",
    "email",
    "phone",
    "contact_page",
    "source",
    "is_webshop",
    "webshop_signals",
    "webshop_platform",
    "webshop_debug",
    "product_count_estimate",
    "seo_pages_sampled",
    "seo_avg_title_len",
    "seo_avg_desc_len",
    "seo_missing_meta_desc_pct",
    "seo_missing_h1_pct",
    "seo_duplicate_title_pct",
    "seo_avg_alt_coverage_pct",
    "seo_avg_product_desc_words",
    "seo_jsonld_product_pct",
    "seo_gap_score",
    "uses_clerk_io",
    "clerk_io_evidence",
    "lead_score",
    "lead_reasons",
    "debug",
];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ---- CSV helpers ----
function loadCsv(filepath) {
    const csvText = fs.readFileSync(filepath, "utf8");
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    return { rows: parsed.data, headers: parsed.meta.fields || [] };
}

function writeCsv(filepath, rows, headers) {
    const fields = headers.slice();
    for (const c of OUTPUT_COLUMNS) if (!fields.includes(c)) fields.push(c);
    const normalized = rows.map((r) => {
        const o = {};
        for (const h of fields) o[h] = r[h] ?? "";
        return o;
    });
    const csv = Papa.unparse(normalized, { columns: fields });
    fs.writeFileSync(filepath, csv, "utf8");
}

function originKeyFromRow(row, urlColumn) {
    const domain = (row?.domain || "").toString().trim();
    if (domain) {
        const key = canonicalOriginKey(domain);
        if (key) return key;
    }
    const raw = row?.[urlColumn];
    return canonicalOriginKey(raw);
}

// "Processed by Stage 3" means we've already touched columns that ONLY Stage 3
// writes. company_name / orgnr / phone come from Stage 1 (allabolag payload),
// so checking those would mark every row as processed before Stage 3 runs.
function isRowProcessed(row) {
    if (!row) return false;
    const keys = [
        "is_webshop",
        "webshop_signals",
        "webshop_debug",
        "webshop_platform",
        "seo_gap_score",
        "seo_pages_sampled",
        "uses_clerk_io",
        "lead_score",
        "lead_reasons",
        "source", // Stage 3's "source" column = "static" | "browser"
    ];
    return keys.some((k) => (row[k] || "").toString().trim().length > 0);
}

// ---- URL normalization ----
function toOrigin(rawUrl) {
    if (!rawUrl) return null;
    let url = rawUrl.trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function stripWww(origin) {
    try {
        const u = new URL(origin);
        if (u.hostname.startsWith("www.")) {
            u.hostname = u.hostname.replace(/^www\./i, "");
            return u.origin;
        }
        return origin;
    } catch {
        return origin;
    }
}

function addWww(origin) {
    try {
        const u = new URL(origin);
        if (!u.hostname.startsWith("www.")) {
            u.hostname = "www." + u.hostname;
            return u.origin;
        }
        return origin;
    } catch {
        return origin;
    }
}

function canonicalOriginKey(rawOriginOrUrl) {
    const origin = toOrigin(rawOriginOrUrl) || (rawOriginOrUrl || "");
    if (!origin) return null;
    try {
        const u = new URL(origin);
        u.protocol = "https:";
        if (u.hostname.startsWith("www.")) {
            u.hostname = u.hostname.replace(/^www\./i, "");
        }
        return u.origin;
    } catch {
        return stripWww(origin);
    }
}

function getSiteHost(origin) {
    try {
        return new URL(origin).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
        return "";
    }
}

function tldOf(host) {
    const parts = (host || "").split(".");
    if (parts.length < 2) return "";
    return parts[parts.length - 1].toLowerCase();
}

function domainMatchesSite(emailDomain, siteHost) {
    const d = (emailDomain || "").toLowerCase();
    const s = (siteHost || "").toLowerCase();
    return d === s || d.endsWith("." + s) || s.endsWith("." + d);
}

// ---- Static fetch (follows redirects, robust headers) ----
function fetchStatic(url, timeout = 12000, maxRedirects = 6) {
    return new Promise((resolve, reject) => {
        const doReq = (u, redirectsLeft) => {
            const protocol = u.startsWith("https") ? https : http;
            let settled = false;
            const finishResolve = (val) => {
                if (settled) return;
                settled = true;
                clearTimeout(hardTimer);
                resolve(val);
            };
            const finishReject = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(hardTimer);
                reject(err);
            };
            const hardTimer = setTimeout(() => {
                try {
                    req.destroy(new Error("hard_timeout"));
                } catch {}
                finishReject(new Error(`Request timeout after ${timeout}ms for ${u}`));
            }, timeout);

            const req = protocol.get(
                u,
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
                    const code = res.statusCode || 0;
                    if (
                        [301, 302, 303, 307, 308].includes(code) &&
                        res.headers.location
                    ) {
                        if (redirectsLeft <= 0) {
                            reject(new Error(`Too many redirects for ${u}`));
                            return;
                        }
                        const next = new URL(res.headers.location, u).toString();
                        res.resume();
                        doReq(next, redirectsLeft - 1);
                        return;
                    }
                    if (code < 200 || code >= 400) {
                        finishReject(new Error(`HTTP ${code} for ${u}`));
                        return;
                    }
                    let data = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk) => {
                        data += chunk;
                        if (data.length > 8 * 1024 * 1024) {
                            req.destroy();
                            finishReject(new Error("Response too large"));
                        }
                    });
                    res.on("end", () => finishResolve(data));
                    res.on("aborted", () =>
                        finishReject(new Error(`Response aborted for ${u}`)),
                    );
                    res.on("close", () => {
                        if (!settled)
                            finishReject(new Error(`Response closed early for ${u}`));
                    });
                },
            );

            req.on("error", finishReject);
            req.on("timeout", () => {
                try {
                    req.destroy(new Error("socket_timeout"));
                } catch {}
                finishReject(new Error(`Socket timeout after ${timeout}ms for ${u}`));
            });
        };
        doReq(url, maxRedirects);
    });
}

async function fetchStaticWithFallbacks(origin) {
    const attempts = [];
    try {
        const httpsOrigin = new URL(origin);
        httpsOrigin.protocol = "https:";
        attempts.push(httpsOrigin.origin);
        const noWww = stripWww(httpsOrigin.origin);
        const withWww = addWww(httpsOrigin.origin);
        if (!attempts.includes(noWww)) attempts.push(noWww);
        if (!attempts.includes(withWww)) attempts.push(withWww);
        const httpOrigin = new URL(origin);
        httpOrigin.protocol = "http:";
        const httpNoWww = stripWww(httpOrigin.origin);
        const httpWithWww = addWww(httpOrigin.origin);
        if (!attempts.includes(httpNoWww)) attempts.push(httpNoWww);
        if (!attempts.includes(httpWithWww)) attempts.push(httpWithWww);
    } catch {
        attempts.push(origin);
    }
    let lastErr = null;
    for (const a of attempts) {
        try {
            const html = await fetchStatic(a);
            return { html, finalOrigin: a, error: null };
        } catch (e) {
            lastErr = e;
        }
    }
    return {
        html: "",
        finalOrigin: origin,
        error: lastErr ? lastErr.message : "fetch failed",
    };
}

// ---- Phones ----
function extractPhones(text) {
    if (!text) return [];
    const candidates = text.match(/(?:\+46|0)[\d\s().-]{6,20}\d/gim) || [];
    const out = [];
    for (const raw of candidates) {
        const cleaned = raw.replace(/[^\d+]/g, " ").replace(/\s+/g, " ").trim();
        let phone = parsePhoneNumberFromString(cleaned, "SE");
        if (!phone && cleaned.startsWith("0")) {
            phone = parsePhoneNumberFromString("+46" + cleaned.slice(1), "SE");
        }
        if (phone && phone.isValid()) {
            const digitCount = phone.number.replace(/\D/g, "").length;
            if (digitCount >= 9) out.push(phone.formatInternational());
        }
    }
    return [...new Set(out)];
}

// ---- Emails ----
function normalizeEmailText(s) {
    let t = he.decode(s || "");
    t = t.replace(/\s*\[at\]\s*|\s*\(at\)\s*|\s+at\s+/gi, "@");
    t = t.replace(/\s*\[dot\]\s*|\s*\(dot\)\s*|\s+dot\s+/gi, ".");
    t = t.replace(/\{at\}/gi, "@").replace(/\{dot\}/gi, ".");
    t = t.replace(/\s+/g, " ");
    return t;
}

function emailLooksLikeFile(email) {
    return /\.(avif|png|jpg|jpeg|gif|webp|svg|css|js|ico|pdf|zip|rar|mp4|webm|mov)\b/i.test(
        email,
    );
}

function isPlaceholderEmail(email) {
    const e = (email || "").toLowerCase();
    if (/^(test|namn|dittnamn|yourname|example|exempel)@/.test(e)) return true;
    if (/@(example|exempel)\./.test(e)) return true;
    if (e.includes("mail@example")) return true;
    if (e === "user@domain.com") return true;
    return false;
}

function isFreeMailDomain(domain) {
    return [
        "gmail.com",
        "hotmail.com",
        "outlook.com",
        "live.com",
        "yahoo.com",
        "icloud.com",
        "proton.me",
        "protonmail.com",
    ].includes((domain || "").toLowerCase());
}

function roleEmailBonus(local) {
    const l = (local || "").toLowerCase();
    if (
        /^(info|kontakt|kundservice|order|support|offert|sales|service|booking|bokning)\b/.test(
            l,
        )
    )
        return 30;
    return 0;
}

function contextPenalty(ctx) {
    const c = (ctx || "").toLowerCase();
    if (
        /powered by|made by|design by|utvecklad av|skapad av|webbyr[aå]|byr[aå]|agency|loopia|wordpress|elementor/i.test(
            c,
        )
    )
        return -60;
    return 0;
}

function extractEmailsWithContext({ html, text, origin }) {
    const siteHost = getSiteHost(origin);
    const normHtml = normalizeEmailText(html || "");
    const normText = normalizeEmailText(text || "");
    const re = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

    function collectFrom(str) {
        const found = [];
        let m;
        while ((m = re.exec(str))) {
            const email = m[1].toLowerCase();
            const start = Math.max(0, m.index - 80);
            const end = Math.min(str.length, m.index + email.length + 80);
            const ctx = str.slice(start, end);
            found.push({ email, ctx });
        }
        return found;
    }

    const candidates = [...collectFrom(normText), ...collectFrom(normHtml)];
    const byEmail = new Map();
    for (const c of candidates) {
        if (
            !byEmail.has(c.email) ||
            (c.ctx || "").length > (byEmail.get(c.email).ctx || "").length
        ) {
            byEmail.set(c.email, c);
        }
    }

    const scored = [];
    for (const { email, ctx } of byEmail.values()) {
        if (!email || email.length > 120) continue;
        if (email.includes("%") || email.includes("&") || email.includes("&#"))
            continue;
        if (emailLooksLikeFile(email)) continue;
        if (isPlaceholderEmail(email)) continue;
        const [local, domain] = email.split("@");
        if (!domain) continue;
        const BAD = [
            "sentry.io",
            "sentry-next.wixpress.com",
            "sentry.wixpress.com",
            "wixpress.com",
            "minhemsida.se",
        ];
        if (BAD.some((bad) => domain.endsWith(bad))) continue;

        let score = 0;
        if (domainMatchesSite(domain, siteHost)) score += 100;
        score += roleEmailBonus(local);
        score += contextPenalty(ctx);
        if (isFreeMailDomain(domain)) score -= 30;
        const siteTld = tldOf(siteHost);
        const mailTld = tldOf(domain);
        if (siteTld && mailTld && siteTld !== mailTld) score -= 20;
        scored.push({ email, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const matching = scored.filter((x) =>
        domainMatchesSite(x.email.split("@")[1], siteHost),
    );
    const chosen = (matching.length ? matching : scored).slice(
        0,
        matching.length ? 3 : 2,
    );
    return chosen.map((x) => x.email);
}

// ---- ORGNR ----
function luhnCheck(digits10) {
    const s = (digits10 || "").replace(/\D/g, "");
    if (s.length !== 10) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) {
        let n = parseInt(s[i], 10);
        let w = i % 2 === 0 ? 2 : 1;
        n = n * w;
        if (n > 9) n -= 9;
        sum += n;
    }
    const check = (10 - (sum % 10)) % 10;
    return check === parseInt(s[9], 10);
}

function normalizeOrgnr(candidate) {
    const raw = (candidate || "").trim();
    const m1 = raw.match(/\b(\d{6})-(\d{4})\b/);
    if (m1) return `${m1[1]}-${m1[2]}`;
    const m2 = raw.match(/\b(55\d{8})\b/);
    if (m2) return `${m2[1].slice(0, 6)}-${m2[1].slice(6)}`;
    return "";
}

function extractOrgnr(text, { requireLuhn = false } = {}) {
    if (!text) return [];
    const lower = text.toLowerCase();
    const keywords = [
        "org.nr",
        "org nr",
        "organisationsnummer",
        "organisationsnr",
        "momsreg.nr",
        "momsreg nr",
        "vat",
        "vat number",
        "vat nr",
        "registration number",
    ];
    const keywordIdxs = [];
    for (const k of keywords) {
        let idx = lower.indexOf(k);
        while (idx !== -1) {
            keywordIdxs.push(idx);
            idx = lower.indexOf(k, idx + 1);
        }
    }
    const rawCandidates = [];
    rawCandidates.push(...(text.match(/\b\d{6}-\d{4}\b/g) || []));
    rawCandidates.push(...(text.match(/\b55\d{8}\b/g) || []));
    const vat = text.match(/\bSE\s?\d{10}\s?01\b/gi) || [];
    for (const v of vat) {
        const digits = v
            .toUpperCase()
            .replace(/^SE\s?/, "")
            .replace(/\s?01$/, "")
            .replace(/\s/g, "");
        if (/^55\d{8}$/.test(digits)) rawCandidates.push(digits);
    }
    const normalized = rawCandidates
        .map((c) => c.replace(/\s+/g, "").toUpperCase())
        .map((c) => normalizeOrgnr(c))
        .filter(Boolean)
        .filter((n) => {
            const d10 = n.replace("-", "");
            if (/^(\d)\1+$/.test(d10)) return false;
            if (requireLuhn && !luhnCheck(d10)) return false;
            return true;
        });
    const scored = normalized.map((norm) => {
        const digits = norm.replace("-", "");
        const pos = lower.indexOf(digits);
        let best = Infinity;
        for (const kpos of keywordIdxs) best = Math.min(best, Math.abs(pos - kpos));
        return { norm, dist: best };
    });
    scored.sort((a, b) => a.dist - b.dist);
    const out = [];
    for (const { norm } of scored) {
        if (!out.includes(norm)) out.push(norm);
        if (out.length >= 3) break;
    }
    return out;
}

function pushOrgnrCandidates(bucket, orgList, sourceLabel, baseScore) {
    for (const o of orgList || []) {
        bucket.push({ orgnr: o, sourceLabel, score: baseScore });
    }
}

function pickBestOrgnr(bucket, max = 2) {
    const bestByOrgnr = new Map();
    for (const c of bucket || []) {
        const prev = bestByOrgnr.get(c.orgnr);
        if (!prev || c.score > prev.score) bestByOrgnr.set(c.orgnr, c);
    }
    return Array.from(bestByOrgnr.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map((x) => x.orgnr);
}

// ---- Parked / holding page detection (expanded) ----
function isParkedDomainPage(text) {
    const t = (text || "").toLowerCase();
    return (
        t.includes("parkerad hos loopia") ||
        t.includes("domain is parked") ||
        t.includes("this domain is parked") ||
        t.includes("this domain is for sale") ||
        t.includes("köp denna domän") ||
        t.includes("kop denna doman") ||
        t.includes("domänen är till salu") ||
        t.includes("domanen ar till salu") ||
        t.includes("buy this domain") ||
        t.includes("future home of something") ||
        t.includes("under construction") ||
        t.includes("kommer snart") ||
        t.includes("coming soon") ||
        t.includes("website is being updated") ||
        t.includes("hemsidan är under uppbyggnad")
    );
}

// Detect whether a page uses Clerk.io (competitor product-recommendation /
// search / email SaaS). When present, the site is already paying for the
// problem Enrichely solves — a warmer lead and a direct competitive angle.
//
// Patterns are deliberately Clerk.io-specific to avoid colliding with:
//   - Clerk.com (auth SaaS — completely unrelated)
//   - "clerk" as in store-clerk in e-commerce body copy
//   - Generic class names like ".clerk-cart" on non-Clerk sites
//
// Validated against hairlust.com, olympiasport.no, hygienesystem.it
// (known Clerk customers per clerk.io blog), and maskinera.se, jula.se
// (known non-customers).
function detectClerkIo(html) {
    if (!html) return { uses: false, evidence: [] };
    const h = html.toLowerCase();
    const evidence = [];

    // Script tags pointing at Clerk's CDN/API. `custom.clerk.io/<store>.js` is
    // Clerk's white-label CDN endpoint used by larger customers — that's why
    // hygienesystem.it was missed before. We accept any *.clerk.io host.
    if (/(?:cdn|custom|api|api-eu|www|static|js)\.clerk\.io/.test(h))
        evidence.push("clerk_io_host");
    if (/['"`]https?:\/\/[^'"`\s]*\.clerk\.io[^'"`\s]*\.js/.test(html))
        evidence.push("clerk_js_script");

    // Initialization variables / API surface that ship with Clerk's snippet.
    // `w.Clerk = w.Clerk || function`, `window.Clerk(`, `__clerk_q` push queue
    // are all signature Clerk.io patterns. We avoid matching `Clerk.com`'s
    // SDK (`window.Clerk?.load`, `<ClerkProvider`) by NOT matching bare
    // `window.Clerk.load` or React component names.
    if (/\b(?:w|window)\.Clerk\s*=\s*(?:w|window)\.Clerk\s*\|\|/.test(html))
        evidence.push("clerk_init_or");
    if (/\bwindow\.Clerk\s*\(\s*['"]config['"]/.test(html))
        evidence.push("clerk_config_call");
    if (/\b__clerk_q\b/.test(html) || /\bclerk_q\.push\b/.test(html))
        evidence.push("clerk_queue");
    if (/window\._clerk_partnertoken|window\.clerk_partnertoken/i.test(html))
        evidence.push("partnertoken_init");
    if (/\binitClerk\s*\(|\btryInitClerk\s*\(/.test(html))
        evidence.push("init_clerk_fn");

    // Clerk-emitted DOM hooks. `data-template="clerk.<...>"` is how Clerk
    // references its hosted templates inside the merchant's HTML.
    if (/data-template=["']clerk\.[a-z0-9_.-]+["']/i.test(html))
        evidence.push("data_template_clerk");
    // `data-clerk-endpoint` is Clerk.io-specific. We avoid matching the
    // generic `data-clerk-*` family because Clerk.com (the auth SaaS) uses
    // `data-clerk-publishable-key`, `data-clerk-js-script`, etc. — they share
    // a name but are unrelated products.
    if (/\bdata-clerk-endpoint\b/i.test(html))
        evidence.push("data_clerk_endpoint");
    // class names like ClerkLiveSearch / ClerkSearchPage that ship as part
    // of Clerk's embedded React widgets
    if (/\bClerk(?:LiveSearch|SearchPage|Carousel|Recommendations)\b/.test(html))
        evidence.push("clerk_widget_class");
    // CSS class hooks Clerk renders into the page (popup-clerk-container,
    // clerk-ios-mobile-zoom-fix). Require the prefix/suffix shape to avoid
    // matching unrelated "clerk-..." class names used by other vendors.
    if (
        /class=["'][^"']*\b(?:popup-clerk-container|clerk-ios-mobile-zoom-fix|clerk-product-recommendations|clerk-search-results)\b/i.test(
            html,
        )
    )
        evidence.push("clerk_known_class");

    // Runtime vars Clerk's snippet stashes (clerk_last_productids,
    // clerk_productids stored in localStorage)
    if (/\bclerk_(?:last_)?productids\b/.test(html))
        evidence.push("clerk_productids_var");
    if (/localStorage\.getItem\(['"]clerk_/.test(html))
        evidence.push("clerk_localstorage");

    return { uses: evidence.length > 0, evidence };
}

function isBadCompanyName(name) {
    const n = (name || "").trim();
    const l = n.toLowerCase();
    if (!n) return true;
    if (n.length < 2) return true;
    if (l === "företagsnamn" || l === "foretagsnamn") return true;
    if (l.includes("parkerad hos loopia") || l.includes("loopia")) return true;
    if (
        /(köp|boka|välkommen|solutions|stort urval|snabb leverans|för en|installera|läs mer|kolla så att du inte är en bot)/i.test(
            n,
        )
    )
        return true;
    if (/(wordpress|elementor|powered by|made by)/i.test(n)) return true;
    const hasLegal = /\b(AB|HB|KB)\b/i.test(n);
    if (n.length > 70 && !hasLegal) return true;
    return false;
}

function mustContainAB(name) {
    return /\bAB\b/i.test((name || "").trim());
}

function looksLikeDomainToken(s) {
    return /\b[a-z0-9-]+\.(se|com|nu|net|org|io|shop|online|store|eu)\b/i.test(
        s || "",
    );
}

function extractLegalEntityNameFromString(s) {
    const str = (s || "").replace(/\s+/g, " ").trim();
    if (!str) return "";
    const re =
        /([A-ZÅÄÖ0-9][A-ZÅÄÖa-zåäö0-9&'’.()\- ]{1,100}?\b(?:AB|Aktiebolag|HB|KB|Oy|AS|A\/S|Ltd|Limited|Inc|LLC|GmbH|BV))\b/g;
    const matches = Array.from(str.matchAll(re))
        .map((m) => m[1])
        .filter(Boolean);
    if (!matches.length) return "";
    return matches[matches.length - 1].replace(/\s+/g, " ").trim();
}

function extractCompanyNameFromCopyrightText(text) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const candidates = [];
    const re1 =
        /(?:©|&copy;|\(c\))\s*(?:copyright\s*)?(?:\d{4}\s*)?([^.|\n\r]{2,140})/gi;
    for (const m of t.matchAll(re1)) if (m?.[1]) candidates.push(m[1]);
    const re2 =
        /copyright\s*(?:©|&copy;|\(c\))?\s*(?:\d{4}\s*)?([^.|\n\r]{2,140})/gi;
    for (const m of t.matchAll(re2)) if (m?.[1]) candidates.push(m[1]);
    const cleaned = candidates
        .map((c) =>
            c
                .replace(/\b(19|20)\d{2}\b/g, " ")
                .replace(/\bcopyright\b/gi, " ")
                .replace(/alla\s+rättigheter\s+förbehållna\b/gi, " ")
                .replace(/all\s+rights\s+reserved\b/gi, " ")
                .replace(/\s+/g, " ")
                .trim(),
        )
        .filter(Boolean);
    if (!cleaned.length) return "";
    const legal = cleaned
        .map((c) => ({ c, legal: !!extractLegalEntityNameFromString(c) }))
        .sort((a, b) => (b.legal ? 1 : 0) - (a.legal ? 1 : 0));
    return legal[0].c;
}

function sanitizeCompanyName(raw, { origin } = {}) {
    let n = he
        .decode((raw || "").toString())
        .replace(/\s+/g, " ")
        .trim();
    if (!n) return "";
    n = n.replace(/^\s*(adress|address|kontakt|contact)\s*[:\-–—]?\s*/i, "");
    n = n
        .replace(/^[^A-ZÅÄÖa-zåäö0-9]+/, "")
        .replace(/\b(19|20)\d{2}\b/g, " ")
        .replace(/\b(copyright)\b/gi, " ")
        .replace(/[©®™]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const legal = extractLegalEntityNameFromString(n);
    if (legal) return legal;
    const parts = n
        .split(/\s*[|•·]\s*|\s+[-–—]\s+|\s+\|\s+/)
        .map((p) => p.trim())
        .filter(Boolean);
    const originHost = getSiteHost(origin || "");
    const scorePart = (p) => {
        const pl = p.toLowerCase();
        let score = 0;
        if (p.split(" ").length >= 2) score += 2;
        if (!looksLikeDomainToken(p)) score += 2;
        if (originHost && pl.includes(originHost)) score -= 4;
        if (/\b(ab|aktiebolag|hb|kb|ltd|inc|llc|gmbh|bv|oy|as)\b/i.test(p))
            score += 6;
        if (
            /(oberoende|välkommen|snabb|stort urval|kundservice|information|konsumentens sida)/i.test(
                p,
            )
        )
            score -= 4;
        return score;
    };
    if (parts.length) {
        const ranked = parts
            .map((p) => ({ p, s: scorePart(p) }))
            .sort((a, b) => b.s - a.s);
        const best = ranked[0]?.p || "";
        if (best) return best.replace(/\s+/g, " ").trim();
    }
    if (looksLikeDomainToken(n)) {
        const without = n
            .replace(
                /\b[a-z0-9-]+\.(se|com|nu|net|org|io|shop|online|store|eu)\b/gi,
                " ",
            )
            .replace(/\s+/g, " ")
            .trim();
        if (without && without.length >= 3) return without;
    }
    return n;
}

// ---- Contact / commerce hints ----
function isContactLike(str) {
    const s = (str || "").toLowerCase();
    return /kontakt|kontakta|kontakta-oss|contact|contact-us|get-in-touch|support|kundtjanst|kundtjänst|customer-service|help|service|om-oss|about|impressum/i.test(
        s,
    );
}

function isCommerceLike(str) {
    const s = (str || "").toLowerCase();
    return /shop|butik|store|produkter|products|webshop|ehandel|e-handel|kassa|checkout|varukorg|kundvagn|cart|basket/i.test(
        s,
    );
}

// ---- Cookie banner handling ----
async function dismissCookieBanners(page) {
    const selectors = [
        'button[id*="accept" i]',
        'button[class*="accept" i]',
        'button[id*="cookie" i]',
        'button[class*="cookie" i]',
        'a[id*="accept" i]',
        'a[class*="accept" i]',
        ".cookie-consent button",
        "#cookieConsent button",
        '[aria-label*="Accept" i]',
        '[aria-label*="Acceptera" i]',
        '[aria-label*="Godkänn" i]',
    ];
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click().catch(() => {});
                await delay(300);
                return;
            }
        } catch {}
    }
    try {
        await page.evaluate(() => {
            const wanted =
                /acceptera|godkänn|tillåt alla|accept all|accept|allow all/i;
            const btns = Array.from(
                document.querySelectorAll(
                    "button, a, input[type=button], input[type=submit]",
                ),
            );
            for (const el of btns) {
                const txt = (el.innerText || el.value || "").trim();
                if (txt && wanted.test(txt)) {
                    el.click && el.click();
                    break;
                }
            }
        });
        await delay(300);
    } catch {}
}

// ---- Webshop detection ----
function detectCheckoutProviders(html) {
    if (!html) return [];
    const h = html.toLowerCase();
    const providers = [
        {
            name: "klarna",
            patterns: ["klarna.com", "checkout.klarna", "klarna-"],
        },
        {
            name: "stripe",
            patterns: ["stripe.com", "checkout.stripe", "v3.stripe"],
        },
        {
            name: "paypal",
            patterns: ["paypal.com", "checkout.paypal", "paypalapi"],
        },
        {
            name: "adyen",
            patterns: ["adyen.com", "checkout.adyen", "adyenencrypt"],
        },
        { name: "svea", patterns: ["svea.com", "sveawebpay", "sveacheckout"] },
        { name: "nets", patterns: ["nets.eu", "easy.nets", "netaxept"] },
        { name: "qliro", patterns: ["qliro.com", "qliroone"] },
        { name: "woocommerce", patterns: ["/wp-content/plugins/woocommerce/"] },
        { name: "shopify", patterns: ["cdn.shopify.com", "window.shopify"] },
        { name: "centra", patterns: ["centra.com", "centraapi"] },
        { name: "jetshop", patterns: ["jetshop.io", "jetshop.se"] },
        { name: "wikinggruppen", patterns: ["wikinggruppen.se"] },
        { name: "starweb", patterns: ["starweb.se"] },
        { name: "magento", patterns: ["mage/cookies", "/static/version", "magento"] },
        { name: "prestashop", patterns: ["prestashop", "/themes/classic/"] },
    ];
    const found = [];
    for (const p of providers) {
        if (p.patterns.some((pat) => h.includes(pat))) found.push(p.name);
    }
    return [...new Set(found)];
}

function detectHasCartCheckout(html, text) {
    const h = (html || "").toLowerCase();
    const t = (text || "").toLowerCase();
    const findUrlPathEvidence = (paths) => {
        for (const p of paths) {
            const pEsc = p
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                .replace(/\//g, "\\/");
            const re = new RegExp(
                `(href|action)\\s*=\\s*["'][^"']*${pEsc}(\\b|\\/|\\?|#|["'])`,
                "i",
            );
            if (re.test(h)) return `urlPath:${p}`;
        }
        return null;
    };
    const cartPaths = [
        "/cart",
        "/basket",
        "/varukorg",
        "/kundvagn",
        "/shopping-cart",
    ];
    const checkoutPaths = [
        "/checkout",
        "/kassa",
        "/payment",
        "/betalning",
        "/order",
        "/bestallning",
        "/beställning",
    ];
    const uiCartStrong = [
        "lägg i varukorg",
        "lägg i kundvagn",
        "add to cart",
        "add to basket",
        "till varukorgen",
        "varukorg",
        "kundvagn",
    ];
    const uiCheckoutStrong = [
        "till kassan",
        "gå till kassan",
        "proceed to checkout",
        "continue to checkout",
        "betalning",
        "pay now",
    ];
    const cartUrlEv = findUrlPathEvidence(cartPaths);
    const checkoutUrlEv = findUrlPathEvidence(checkoutPaths);
    const cartUiEv = uiCartStrong.find((p) => t.includes(p)) ? "uiPhrase" : null;
    const checkoutUiEv = uiCheckoutStrong.find((p) => t.includes(p))
        ? "uiPhrase"
        : null;
    return {
        hasCart: !!cartUrlEv || !!cartUiEv,
        hasCheckout: !!checkoutUrlEv || !!checkoutUiEv,
        cartEvidence: cartUrlEv || cartUiEv || "",
        checkoutEvidence: checkoutUrlEv || checkoutUiEv || "",
    };
}

function countProductCards(html) {
    if (!html) return 0;
    const h = html.toLowerCase();
    const patterns = [
        /class="[^"]*product[^"]*"/g,
        /class="[^"]*product-card[^"]*"/g,
        /class="[^"]*collection[^"]*item[^"]*"/g,
        /class="[^"]*grid[^"]*item[^"]*"/g,
        /data-product-id=/g,
    ];
    let count = 0;
    for (const re of patterns) count += (h.match(re) || []).length;
    return Math.min(count, 200);
}

function hasPricedProductCards(html, text) {
    const t = (text || "").toLowerCase();
    const priceMatches =
        (text || "").match(
            /([0-9]+[,.]?[0-9]*\s*(kr|sek|€|eur|\$|usd|£|gbp))/gi,
        ) || [];
    const hasMultiplePrices = priceMatches.length >= 2;
    const hasPriceMicrodata =
        /itemprop=["']?price["']?/i.test(html || "") ||
        /property=["']?product:price/i.test(html || "") ||
        /"price"\s*:/i.test(html || "");
    const contactForPrice =
        t.includes("kontakta oss för pris") ||
        t.includes("contact us for price") ||
        t.includes("begär offert") ||
        t.includes("request a quote");
    if (contactForPrice && !hasMultiplePrices && !hasPriceMicrodata)
        return { ok: false, evidence: "quoteOnly" };
    const cardCount = countProductCards(html);
    const hasListing = cardCount >= 2;
    const ok = hasListing && (hasMultiplePrices || hasPriceMicrodata);
    let evidence = "";
    if (ok) evidence = hasMultiplePrices ? "multiPrices" : "priceMicrodata";
    return { ok, evidence };
}

function classifyProductDetailSignals({ html, text }) {
    const h = (html || "").toLowerCase();
    const t = (text || "").toLowerCase();
    const hasProductSchema =
        /itemtype=["']https?:\/\/schema\.org\/product["']/.test(h) ||
        /"@type"\s*:\s*"product"/.test(h);
    const prices =
        (text || "").match(
            /([0-9]+[,.]?[0-9]*\s*(kr|sek|€|eur|\$|usd|£|gbp))/gi,
        ) || [];
    const hasSinglePrice = prices.length >= 1 && prices.length <= 4;
    const addToCartPhrases = [
        "lägg i varukorg",
        "lägg i kundvagn",
        "add to cart",
        "add to basket",
        "till varukorgen",
        "go to cart",
        "köp",
        "buy now",
    ];
    const hasAddToCart = addToCartPhrases.some((p) => t.includes(p));
    const hasQuantityUI =
        /quantity|antal|st\.\b|qty\b/.test(t) ||
        /name=["']quantity["']/.test(h) ||
        /type=["']number["']/.test(h);
    const isProductDetail =
        (hasProductSchema && hasSinglePrice) ||
        (hasAddToCart && hasSinglePrice) ||
        (hasAddToCart && hasQuantityUI);
    return { isProductDetail, hasAddToCart, hasProductSchema, hasSinglePrice };
}

function detectWebshop({ html, text, sample }) {
    const providers = detectCheckoutProviders(html);
    const cc = detectHasCartCheckout(html, text);
    const productCardCount = countProductCards(html);
    const priced = hasPricedProductCards(html, text);

    const signals = new Set();
    if (providers.length) signals.add("checkout_provider");
    if (cc.hasCart) signals.add("cart");
    if (cc.hasCheckout) signals.add("checkout");
    if (productCardCount >= 2) signals.add("product_cards");
    if (priced.ok) signals.add("priced_cards");
    if (sample?.sampledCount) signals.add(`sampled_${sample.sampledCount}`);
    if (sample?.productDetailCount)
        signals.add(`sample_pdp_${sample.productDetailCount}`);
    if (sample?.addToCartCount)
        signals.add(`sample_addtocart_${sample.addToCartCount}`);
    if (sample?.priceCount) signals.add(`sample_price_${sample.priceCount}`);

    const lower = ((text || "") + " " + (html || "")).toLowerCase();
    const leadOnly =
        (lower.includes("begär offert") ||
            lower.includes("request a quote") ||
            lower.includes("kontakta oss")) &&
        !cc.hasCheckout &&
        !cc.hasCart &&
        !priced.ok &&
        !sample?.isWebshopBySampling;

    const hasStrongCommercialProof =
        priced.ok || providers.length > 0 || !!sample?.isWebshopBySampling;

    const isWebshop =
        !leadOnly &&
        ((cc.hasCheckout && (cc.hasCart || hasStrongCommercialProof)) ||
            (cc.hasCart && hasStrongCommercialProof) ||
            hasStrongCommercialProof);

    return {
        isWebshop,
        hasCart: cc.hasCart,
        hasCheckout: cc.hasCheckout,
        cartEvidence: cc.cartEvidence,
        checkoutEvidence: cc.checkoutEvidence,
        productCardCount,
        hasPricedProductCards: priced.ok,
        pricedCardsEvidence: priced.evidence,
        checkoutProviders: providers,
        webshopSignals: [...signals].slice(0, 14),
    };
}

// ---- Product link sampling from DOM ----
async function sampleProductCardLinks(page, origin, maxSamples = 3) {
    const originObj = new URL(origin);
    const candidates = await page.evaluate(() => {
        const badText =
            /kontakt|contact|om oss|about|privacy|integritet|kundtjänst|kundtjanst|support|villkor|terms|policy|blogg|nyheter/i;
        const scoreLink = (a) => {
            const href = a.getAttribute("href") || "";
            const txt = (a.innerText || "").trim();
            const cls = (a.getAttribute("class") || "").toLowerCase();
            const parentCls = (
                a.closest("[class]")?.getAttribute("class") || ""
            ).toLowerCase();
            if (!href || href.startsWith("#")) return null;
            if (/mailto:|tel:|javascript:/i.test(href)) return null;
            if (badText.test(txt)) return null;
            let score = 0;
            if (/card|product|grid|listing|item|collection/i.test(cls)) score += 2;
            if (/card|product|grid|listing|item|collection/i.test(parentCls))
                score += 3;
            if (
                /\/product|\/produkter\/|\/products\/|\/shop\/|\/butik\/|\/p\/|\/item\/|\/artikel/i.test(
                    href.toLowerCase(),
                )
            )
                score += 4;
            if (txt && txt.length >= 3 && txt.length <= 80) score += 1;
            return { href, score };
        };
        const out = [];
        document.querySelectorAll("a[href]").forEach((a) => {
            const r = scoreLink(a);
            if (r && r.score >= 3) out.push(r);
        });
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, 50).map((x) => x.href);
    });

    const seen = new Set();
    const urls = [];
    for (const h of candidates) {
        try {
            const u = new URL(h, origin);
            if (u.origin !== originObj.origin) continue;
            const p = u.pathname.toLowerCase();
            if (
                p === "/" ||
                p.startsWith("/kontakt") ||
                p.startsWith("/contact") ||
                p.startsWith("/om")
            )
                continue;
            if (
                p.includes("/privacy") ||
                p.includes("/integritet") ||
                p.includes("/policy") ||
                p.includes("/terms") ||
                p.includes("/villkor")
            )
                continue;
            if (
                p.includes("/cart") ||
                p.includes("/checkout") ||
                p.includes("/kassa")
            )
                continue;
            const key = u.href.split("#")[0];
            if (seen.has(key)) continue;
            seen.add(key);
            urls.push(key);
        } catch {}
        if (urls.length >= 20) break;
    }

    const targets = urls.slice(0, maxSamples);
    const sample = {
        sampledCount: 0,
        productDetailCount: 0,
        addToCartCount: 0,
        priceCount: 0,
        isWebshopBySampling: false,
        sampledUrls: [],
        sampledResults: [],
    };

    for (const url of targets) {
        try {
            sample.sampledCount++;
            sample.sampledUrls.push(url);
            const r = await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 25000,
            });
            if (!r || r.status() >= 400) {
                sample.sampledResults.push({
                    url,
                    status: r ? r.status() : 0,
                    pdp: false,
                    atc: false,
                    price: false,
                });
                continue;
            }
            await delay(600);
            await dismissCookieBanners(page);
            await delay(250);
            const html = await page.content();
            const text = await page.evaluate(
                () => document.body?.innerText || "",
            );
            const pdp = classifyProductDetailSignals({ html, text });
            if (pdp.isProductDetail) sample.productDetailCount++;
            if (pdp.hasAddToCart) sample.addToCartCount++;
            if (pdp.hasSinglePrice) sample.priceCount++;
            sample.sampledResults.push({
                url,
                status: r.status(),
                pdp: !!pdp.isProductDetail,
                atc: !!pdp.hasAddToCart,
                price: !!pdp.hasSinglePrice,
            });
            if (
                (sample.productDetailCount >= 1 && sample.addToCartCount >= 1) ||
                sample.productDetailCount >= 2
            ) {
                sample.isWebshopBySampling = true;
                break;
            }
        } catch {
            sample.sampledResults.push({
                url,
                status: -1,
                pdp: false,
                atc: false,
                price: false,
            });
        }
    }
    return sample;
}

// ---- Company name helpers ----
function extractCompanyNameFromJsonLd(html) {
    if (!html) return "";
    const scripts = [
        ...html.matchAll(
            /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
        ),
    ]
        .map((m) => (m[1] || "").trim())
        .filter(Boolean);
    const pickName = (obj) => {
        if (!obj || typeof obj !== "object") return "";
        const t = obj["@type"];
        const types = Array.isArray(t)
            ? t.map((x) => String(x).toLowerCase())
            : [String(t || "").toLowerCase()];
        const isOrg = types.some(
            (x) => x.includes("organization") || x.includes("localbusiness"),
        );
        if (!isOrg) return "";
        return (obj.legalName || obj.name || "").toString().trim();
    };
    const walk = (node) => {
        if (!node) return "";
        if (Array.isArray(node)) {
            for (const n of node) {
                const r = walk(n);
                if (r) return r;
            }
            return "";
        }
        if (typeof node === "object") {
            if (node["@graph"]) {
                const r = walk(node["@graph"]);
                if (r) return r;
            }
            const n = pickName(node);
            if (n) return n;
            for (const k of Object.keys(node)) {
                const r = walk(node[k]);
                if (r) return r;
            }
        }
        return "";
    };
    for (const raw of scripts) {
        try {
            const parsed = JSON.parse(raw);
            const found = walk(parsed);
            if (found) return found;
        } catch {}
    }
    return "";
}

function extractCompanyNameFromHtml(html) {
    if (!html) return "";
    const jsonLdName = extractCompanyNameFromJsonLd(html);
    if (jsonLdName) return jsonLdName;
    const og =
        html.match(/property=["']og:site_name["']\s+content=["']([^"']+)["']/i) ||
        html.match(/content=["']([^"']+)["']\s+property=["']og:site_name["']/i);
    if (og && og[1]) return he.decode(og[1]).trim();
    const appName =
        html.match(/name=["']application-name["']\s+content=["']([^"']+)["']/i) ||
        html.match(/content=["']([^"']+)["']\s+name=["']application-name["']/i);
    if (appName && appName[1]) return he.decode(appName[1]).trim();
    const title = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
    if (title && title[1]) {
        const t = he.decode(title[1]).replace(/\s+/g, " ").trim();
        return t.split("|")[0].split("–")[0].split("-")[0].trim() || t;
    }
    return "";
}

function extractFooterText(html) {
    if (!html) return "";
    const m = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/i);
    if (!m) return "";
    const footerHtml = (m[1] || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ");
    return he
        .decode(footerHtml)
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractCompanyNearOrgnr(footerText, orgnrs) {
    if (!footerText || !orgnrs?.length) return "";
    const legalSuffix =
        /\b(AB|HB|KB|Oy|AS|A\/S|Ltd|Limited|Inc|LLC|GmbH|BV)\b/i;
    for (const org of orgnrs) {
        const idx = footerText.indexOf(org);
        if (idx === -1) continue;
        const windowStart = Math.max(0, idx - 240);
        const windowEnd = Math.min(footerText.length, idx + 120);
        const chunk = footerText.slice(windowStart, windowEnd);
        const m =
            chunk.match(
                /(?:©\s*)?([A-ZÅÄÖ][A-ZÅÄÖa-zåäö0-9&.'’\- ]{2,80}\b(?:AB|HB|KB|Ltd|Limited|Inc|LLC|GmbH|BV))\b/i,
            ) ||
            chunk.match(
                /([A-ZÅÄÖ][A-ZÅÄÖa-zåäö0-9&.'’\- ]{2,80})\s+(?:org\.? ?nr|organisationsnummer)/i,
            );
        if (m?.[1]) {
            const cand = m[1].replace(/\s+/g, " ").trim();
            if (
                cand.length >= 3 &&
                (legalSuffix.test(cand) || cand.split(" ").length >= 2)
            )
                return cand;
        }
    }
    return "";
}

function addWebshopDebug(debugArr, label, url, ws, sample) {
    const prefix = `${label}@${url}`;
    if (ws?.hasCheckout)
        debugArr.push(`${prefix}:hasCheckout(${ws.checkoutEvidence || "?"})`);
    if (ws?.hasCart) debugArr.push(`${prefix}:hasCart(${ws.cartEvidence || "?"})`);
    if (ws?.hasPricedProductCards)
        debugArr.push(`${prefix}:pricedCards(${ws.pricedCardsEvidence || "?"})`);
    if ((ws?.checkoutProviders || []).length)
        debugArr.push(`${prefix}:providers(${ws.checkoutProviders.join(",")})`);
    if ((ws?.productCardCount || 0) >= 2)
        debugArr.push(`${prefix}:productCards(${ws.productCardCount})`);
    if (sample) {
        debugArr.push(`${prefix}:samplingRan(sampled=${sample.sampledCount})`);
        for (const r of sample.sampledResults || []) {
            const flags = [
                r.pdp ? "PDP" : "",
                r.atc ? "ATC" : "",
                r.price ? "PRICE" : "",
            ].filter(Boolean);
            debugArr.push(
                `sampleURL@${r.url}:status=${r.status}${
                    flags.length ? ":" + flags.join("+") : ""
                }`,
            );
        }
        if (sample.isWebshopBySampling)
            debugArr.push(`DECISION@sample (confirmed)`);
    }
    if (ws?.isWebshop) debugArr.push(`DECISION@${label}@${url}`);
}

// ---- Sitemap product discovery (accuracy boost) ----
async function fetchSitemapProductUrls(origin, maxUrls = 60) {
    const result = { productUrls: [], totalUrlsSeen: 0, sitemapsTried: [] };
    const candidates = [
        `${origin}/sitemap.xml`,
        `${origin}/sitemap_index.xml`,
        `${origin}/sitemap-index.xml`,
        `${origin}/wp-sitemap.xml`,
        `${origin}/sitemap/sitemap.xml`,
    ];

    const PRODUCT_PATTERNS =
        /\/(product|products|produkter|produkt|shop|butik|p|item|artikel|vara|varor)\//i;
    const NON_PRODUCT_PATTERNS =
        /\/(blog|blogg|news|nyheter|category|kategori|tag|page|sida|kontakt|contact|about|om|policy|villkor|terms|integritet|privacy)\//i;

    const visited = new Set();

    async function parseSitemap(url, depth = 0) {
        if (depth > 2) return;
        if (visited.has(url)) return;
        visited.add(url);
        result.sitemapsTried.push(url);

        let xml;
        try {
            xml = await fetchStatic(url, 10000, 3);
        } catch {
            return;
        }
        if (!xml) return;

        const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
        const isIndex = /<sitemapindex[\s>]/i.test(xml);
        const locs = [];
        let m;
        while ((m = locRe.exec(xml))) locs.push(m[1].trim());

        if (isIndex) {
            const subs = locs.filter((u) => /sitemap.*\.xml/i.test(u)).slice(0, 8);
            const productLikeFirst = subs.sort((a, b) => {
                const ap = /product|produkt/i.test(a) ? -1 : 0;
                const bp = /product|produkt/i.test(b) ? -1 : 0;
                return ap - bp;
            });
            for (const s of productLikeFirst) {
                if (result.productUrls.length >= maxUrls) break;
                await parseSitemap(s, depth + 1);
            }
            return;
        }

        for (const u of locs) {
            result.totalUrlsSeen++;
            if (NON_PRODUCT_PATTERNS.test(u)) continue;
            if (PRODUCT_PATTERNS.test(u)) {
                result.productUrls.push(u);
                if (result.productUrls.length >= maxUrls) return;
            }
        }
    }

    for (const c of candidates) {
        if (result.productUrls.length >= maxUrls) break;
        await parseSitemap(c, 0);
    }

    const seen = new Set();
    result.productUrls = result.productUrls.filter((u) => {
        const k = u.split("#")[0].split("?")[0];
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    return result;
}

// ---- SEO scoring on product pages ----
function extractProductPageSeoSignals({ html, text }) {
    const signals = {
        titleLen: 0,
        titleText: "",
        descLen: 0,
        hasMetaDesc: false,
        hasH1: false,
        h1Text: "",
        altCoveragePct: 0,
        productDescWords: 0,
        hasJsonLdProduct: false,
        jsonLdProductHasDesc: false,
    };

    if (!html) return signals;

    const titleMatch = html.match(/<title[^>]*>([^<]{0,300})<\/title>/i);
    if (titleMatch?.[1]) {
        const t = he.decode(titleMatch[1]).replace(/\s+/g, " ").trim();
        signals.titleText = t;
        signals.titleLen = t.length;
    }

    const descMatch =
        html.match(
            /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
        ) ||
        html.match(
            /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
        );
    if (descMatch?.[1]) {
        const d = he.decode(descMatch[1]).replace(/\s+/g, " ").trim();
        signals.descLen = d.length;
        signals.hasMetaDesc = d.length > 0;
    }

    const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match?.[1]) {
        const txt = he
            .decode(h1Match[1].replace(/<[^>]*>/g, " "))
            .replace(/\s+/g, " ")
            .trim();
        if (txt) {
            signals.hasH1 = true;
            signals.h1Text = txt;
        }
    }

    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    if (imgs.length) {
        const withAlt = imgs.filter((img) => /\salt=["'][^"']+["']/i.test(img)).length;
        signals.altCoveragePct = Math.round((withAlt / imgs.length) * 100);
    } else {
        signals.altCoveragePct = 100;
    }

    const visibleText = text || "";
    const wordCount = (visibleText.match(/\b[\wåäöÅÄÖ]+\b/g) || []).length;
    const chromeWords = 250;
    signals.productDescWords = Math.max(0, wordCount - chromeWords);

    const jsonLdBlocks = [
        ...html.matchAll(
            /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
        ),
    ].map((m) => (m[1] || "").trim());

    for (const raw of jsonLdBlocks) {
        try {
            const parsed = JSON.parse(raw);
            const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
            while (stack.length) {
                const node = stack.pop();
                if (!node || typeof node !== "object") continue;
                if (node["@graph"] && Array.isArray(node["@graph"]))
                    stack.push(...node["@graph"]);
                const types = []
                    .concat(node["@type"] || [])
                    .map((x) => String(x).toLowerCase());
                if (types.includes("product")) {
                    signals.hasJsonLdProduct = true;
                    const d = (node.description || "").toString().trim();
                    if (d.length > 30) signals.jsonLdProductHasDesc = true;
                }
                for (const k of Object.keys(node)) {
                    if (typeof node[k] === "object" && node[k]) stack.push(node[k]);
                }
            }
        } catch {}
    }

    return signals;
}

// Compute final SEO gap score 0..100 (higher = worse SEO = better Enrichely fit)
function computeSeoGapScore(agg) {
    if (!agg.pagesSampled) return null;

    const titleIdeal = (len) => {
        if (len === 0) return 100;
        if (len < 30) return 70;
        if (len > 65) return 40;
        return 0;
    };
    const descIdeal = (len) => {
        if (len === 0) return 100;
        if (len < 80) return 60;
        if (len > 160) return 35;
        return 0;
    };

    const titleGap = titleIdeal(agg.avgTitleLen);
    const descGap = descIdeal(agg.avgDescLen);
    const missingDescGap = agg.missingMetaDescPct;
    const missingH1Gap = agg.missingH1Pct;
    const dupTitleGap = agg.duplicateTitlePct;
    const altGap = Math.max(0, 100 - agg.avgAltCoveragePct);
    const descWordGap =
        agg.avgProductDescWords >= 100
            ? 0
            : agg.avgProductDescWords >= 50
              ? 30
              : agg.avgProductDescWords >= 20
                ? 60
                : 90;
    const jsonLdGap = 100 - agg.jsonLdProductPct;

    const weights = {
        titleGap: 0.18,
        descGap: 0.18,
        missingDescGap: 0.14,
        missingH1Gap: 0.06,
        dupTitleGap: 0.1,
        altGap: 0.08,
        descWordGap: 0.16,
        jsonLdGap: 0.1,
    };
    const score =
        titleGap * weights.titleGap +
        descGap * weights.descGap +
        missingDescGap * weights.missingDescGap +
        missingH1Gap * weights.missingH1Gap +
        dupTitleGap * weights.dupTitleGap +
        altGap * weights.altGap +
        descWordGap * weights.descWordGap +
        jsonLdGap * weights.jsonLdGap;

    return Math.round(Math.max(0, Math.min(100, score)));
}

async function scoreSeoOnProductPages(page, productUrls, maxSamples) {
    const agg = {
        pagesSampled: 0,
        titleLens: [],
        descLens: [],
        missingDesc: 0,
        missingH1: 0,
        titles: [],
        altCoverages: [],
        productDescWords: [],
        jsonLdProductCount: 0,
        perPage: [],
    };

    const samples = productUrls.slice(0, maxSamples);
    for (const url of samples) {
        try {
            const r = await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 25000,
            });
            if (!r || r.status() >= 400) continue;
            await delay(500);
            await dismissCookieBanners(page);
            await delay(200);
            const html = await page.content();
            const text = await page.evaluate(
                () => document.body?.innerText || "",
            );
            const s = extractProductPageSeoSignals({ html, text });
            agg.pagesSampled++;
            agg.titleLens.push(s.titleLen);
            agg.descLens.push(s.descLen);
            if (!s.hasMetaDesc) agg.missingDesc++;
            if (!s.hasH1) agg.missingH1++;
            agg.titles.push(s.titleText);
            agg.altCoverages.push(s.altCoveragePct);
            agg.productDescWords.push(s.productDescWords);
            if (s.hasJsonLdProduct) agg.jsonLdProductCount++;
            agg.perPage.push({ url, ...s });
        } catch {}
    }

    if (!agg.pagesSampled) return null;

    const avg = (arr) =>
        arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    const uniqueTitles = new Set(
        agg.titles.map((t) => (t || "").toLowerCase().trim()).filter(Boolean),
    );
    const duplicateTitlePct =
        agg.titles.length > 1
            ? Math.round(
                  ((agg.titles.length - uniqueTitles.size) / agg.titles.length) *
                      100,
              )
            : 0;

    const summary = {
        pagesSampled: agg.pagesSampled,
        avgTitleLen: avg(agg.titleLens),
        avgDescLen: avg(agg.descLens),
        missingMetaDescPct: Math.round(
            (agg.missingDesc / agg.pagesSampled) * 100,
        ),
        missingH1Pct: Math.round((agg.missingH1 / agg.pagesSampled) * 100),
        duplicateTitlePct,
        avgAltCoveragePct: avg(agg.altCoverages),
        avgProductDescWords: avg(agg.productDescWords),
        jsonLdProductPct: Math.round(
            (agg.jsonLdProductCount / agg.pagesSampled) * 100,
        ),
    };

    summary.gapScore = computeSeoGapScore(summary);
    return summary;
}

// ---- Lead scoring (overall fit) ----
function computeLeadScore({ res, seo, productCountEstimate, clerk }) {
    const reasons = [];
    let score = 0;

    if (!res.success) {
        return { score: 0, reasons: ["unreachable_or_parked"] };
    }
    if ((res.sources || []).includes("parked_domain_detected")) {
        return { score: 0, reasons: ["parked_domain"] };
    }

    const ws = res.webshop || {};
    if (!ws.isWebshop) {
        if (res.companyName) {
            score += 5;
            reasons.push("has_identity");
        }
        return { score, reasons: reasons.length ? reasons : ["not_webshop"] };
    }

    score += 25;
    reasons.push("is_webshop");

    if ((ws.checkoutProviders || []).length) {
        score += 8;
        reasons.push(`platform:${ws.checkoutProviders.join(",")}`);
    }

    // Clerk.io: site is already paying a competitor — warmer pitch
    if (clerk?.uses) {
        score += 20;
        reasons.push("uses_clerk_io");
    }

    if (productCountEstimate >= 50) {
        score += 15;
        reasons.push("catalog_50plus");
    } else if (productCountEstimate >= 20) {
        score += 10;
        reasons.push("catalog_20plus");
    } else if (productCountEstimate >= 5) {
        score += 4;
        reasons.push("catalog_small");
    }

    if (seo && typeof seo.gapScore === "number") {
        const gapPoints = Math.round(seo.gapScore * 0.5);
        score += gapPoints;
        if (seo.gapScore >= 70) reasons.push("seo_gap_severe");
        else if (seo.gapScore >= 45) reasons.push("seo_gap_moderate");
        else reasons.push("seo_gap_low");

        if (seo.missingMetaDescPct >= 60) reasons.push("missing_meta_desc");
        if (seo.duplicateTitlePct >= 40) reasons.push("duplicate_titles");
        if (seo.avgProductDescWords < 30) reasons.push("thin_product_copy");
        if (seo.jsonLdProductPct < 30) reasons.push("no_product_schema");
    }

    if (res.emails && res.emails.length) {
        score += 5;
        reasons.push("has_email");
    }
    if (res.orgnrs && res.orgnrs.length) {
        score += 3;
        reasons.push("has_orgnr");
    }

    return { score: Math.min(score, 100), reasons };
}

// ---- Browser/footer helpers ----
async function getFooterText(page) {
    return await page.evaluate(() => {
        const el =
            document.querySelector("footer") ||
            document.querySelector('[id*="footer" i]') ||
            document.querySelector('[class*="footer" i]');
        return (el?.innerText || "").replace(/\s+/g, " ").trim();
    });
}

async function scrollToBottom(page) {
    try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } catch {}
}

// ---- Static extraction per origin ----
async function extractStatic(origin) {
    const emails = [];
    const phones = [];
    let companyName = "";
    let contactPageUsed = origin;
    let webshop = null;
    const sources = [];
    const webshopDebug = [];
    const orgBucket = [];

    try {
        const fetched = await fetchStaticWithFallbacks(origin);
        if (!fetched.html) {
            return {
                success: false,
                companyName: "",
                emails: [],
                phones: [],
                orgnrs: [],
                contactPageUsed: "",
                webshop: null,
                webshopDebug: [],
                sources: [],
                method: "static",
                error: fetched.error || "fetch failed",
            };
        }

        const html = fetched.html;
        contactPageUsed = fetched.finalOrigin || origin;

        const cand = sanitizeCompanyName(extractCompanyNameFromHtml(html), {
            origin: contactPageUsed,
        });
        if (!isBadCompanyName(cand) && mustContainAB(cand)) companyName = cand;

        const cleanHtml = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
        const text = he.decode(
            cleanHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "),
        );

        if (isParkedDomainPage(text)) {
            return {
                success: true,
                companyName: "",
                emails: [],
                phones: [],
                orgnrs: [],
                contactPageUsed,
                webshop: null,
                webshopDebug: [],
                sources: ["parked_domain_detected"],
                method: "static",
            };
        }

        const rankedEmails = extractEmailsWithContext({
            html,
            text,
            origin: contactPageUsed,
        });
        if (rankedEmails.length) {
            emails.push(...rankedEmails);
            sources.push("email_static_ranked");
        }

        phones.push(...extractPhones(text));
        if (phones.length) sources.push("phone_static");

        pushOrgnrCandidates(
            orgBucket,
            extractOrgnr(text, { requireLuhn: false }),
            "static_body",
            10,
        );
        if (orgBucket.length) sources.push("orgnr_static");

        const footerText = extractFooterText(html);
        if (footerText) {
            pushOrgnrCandidates(
                orgBucket,
                extractOrgnr(footerText, { requireLuhn: true }),
                "static_footer",
                100,
            );
            const bestOrgsForName = pickBestOrgnr(orgBucket, 2);
            const near = extractCompanyNearOrgnr(footerText, bestOrgsForName);
            if (!companyName && near) {
                const cleaned = sanitizeCompanyName(near, {
                    origin: contactPageUsed,
                });
                if (!isBadCompanyName(cleaned) && mustContainAB(cleaned)) {
                    companyName = cleaned;
                    sources.push("company_footer_near_orgnr_static");
                }
            }
            if (!companyName) {
                const cpy = sanitizeCompanyName(
                    extractCompanyNameFromCopyrightText(footerText),
                    { origin: contactPageUsed },
                );
                if (!isBadCompanyName(cpy)) {
                    companyName = cpy;
                    sources.push("company_footer_copyright_static");
                }
            }
        }

        const finalOrgs = pickBestOrgnr(orgBucket, 2);
        webshop = detectWebshop({ html, text });
        addWebshopDebug(webshopDebug, "static", contactPageUsed, webshop, null);

        return {
            success: true,
            companyName,
            emails: [...new Set(emails)].slice(0, 3),
            phones: [...new Set(phones)].slice(0, 3),
            orgnrs: finalOrgs,
            contactPageUsed,
            webshop,
            webshopDebug: [...new Set(webshopDebug)].slice(0, 80),
            sources: [...new Set(sources)].slice(0, 10),
            method: "static",
        };
    } catch (err) {
        return {
            success: false,
            companyName: "",
            emails: [],
            phones: [],
            orgnrs: [],
            contactPageUsed: "",
            webshop: null,
            webshopDebug: [],
            sources: [],
            method: "static",
            error: err.message,
        };
    }
}

// ---- Browser extraction per origin ----
async function extractWithBrowser(page, origin, maxInternalLinks = 10) {
    const emails = [];
    const phones = [];
    const sources = [];
    let companyName = "";
    let contactPageUsed = origin;
    const orgBucket = [];
    const webshopAgg = {
        isWebshop: false,
        hasCart: false,
        hasCheckout: false,
        productCardCount: 0,
        hasPricedProductCards: false,
        checkoutProviders: [],
        webshopSignals: [],
    };
    const webshopDebug = [];
    let samplingDone = false;

    async function ingestFromCurrentPage(label) {
        const currentUrl = page.url();
        const html = await page.content();
        const text = await page.evaluate(() => document.body?.innerText || "");
        if (label === "main" && isParkedDomainPage(text)) {
            sources.push("parked_domain_detected");
            companyName = "";
            return { parked: true, html, text, currentUrl };
        }
        if (!companyName) {
            const cand = sanitizeCompanyName(extractCompanyNameFromHtml(html), {
                origin: currentUrl,
            });
            if (!isBadCompanyName(cand) && mustContainAB(cand)) companyName = cand;
        }
        const newEmails = extractEmailsWithContext({ html, text, origin });
        if (newEmails.length) {
            emails.push(...newEmails);
            sources.push(`${label}_email_ranked`);
        }
        const newPhones = extractPhones(text);
        if (newPhones.length) {
            phones.push(...newPhones);
            sources.push(`${label}_phone`);
        }
        const bodyScore =
            label === "contact_like" ? 60 : label === "main" ? 20 : 15;
        pushOrgnrCandidates(
            orgBucket,
            extractOrgnr(text, { requireLuhn: false }),
            `${label}_body`,
            bodyScore,
        );
        const footerText = await getFooterText(page);
        if (footerText) {
            pushOrgnrCandidates(
                orgBucket,
                extractOrgnr(footerText, { requireLuhn: true }),
                `${label}_footer`,
                120,
            );
            if (!companyName) {
                const bestOrgsForName = pickBestOrgnr(orgBucket, 2);
                const near = extractCompanyNearOrgnr(footerText, bestOrgsForName);
                if (near && !isBadCompanyName(near)) {
                    const cleaned = sanitizeCompanyName(near, {
                        origin: currentUrl,
                    });
                    if (!isBadCompanyName(cleaned) && mustContainAB(cleaned)) {
                        companyName = cleaned;
                        sources.push(`${label}_company_footer_near_orgnr`);
                    }
                }
            }
            if (!companyName) {
                const cpy = sanitizeCompanyName(
                    extractCompanyNameFromCopyrightText(footerText),
                    { origin: currentUrl },
                );
                if (!isBadCompanyName(cpy)) {
                    companyName = cpy;
                    sources.push(`${label}_company_footer_copyright`);
                }
            }
        }
        let sample = null;
        const baseWs = detectWebshop({ html, text });
        const shouldSample =
            !samplingDone &&
            !baseWs.isWebshop &&
            (baseWs.productCardCount >= 2 ||
                /produkter|products|shop|butik|webshop/i.test(text || ""));
        if (shouldSample) {
            samplingDone = true;
            try {
                sample = await sampleProductCardLinks(page, origin, 3);
            } catch {}
        }
        const ws = detectWebshop({ html, text, sample });
        addWebshopDebug(webshopDebug, label, currentUrl, ws, sample);
        webshopAgg.isWebshop = webshopAgg.isWebshop || ws.isWebshop;
        webshopAgg.hasCart = webshopAgg.hasCart || ws.hasCart;
        webshopAgg.hasCheckout = webshopAgg.hasCheckout || ws.hasCheckout;
        webshopAgg.productCardCount = Math.max(
            webshopAgg.productCardCount,
            ws.productCardCount,
        );
        webshopAgg.hasPricedProductCards =
            webshopAgg.hasPricedProductCards || ws.hasPricedProductCards;
        webshopAgg.checkoutProviders = [
            ...new Set([
                ...webshopAgg.checkoutProviders,
                ...(ws.checkoutProviders || []),
            ]),
        ];
        webshopAgg.webshopSignals = [
            ...new Set([
                ...webshopAgg.webshopSignals,
                ...(ws.webshopSignals || []),
            ]),
        ].slice(0, 14);
        return { parked: false, html, text, currentUrl };
    }

    try {
        const resp = await page.goto(origin, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });
        if (!resp || resp.status() >= 400) {
            const status = resp ? resp.status() : 0;
            return {
                success: false,
                companyName: "",
                emails: [],
                phones: [],
                orgnrs: [],
                contactPageUsed: "",
                webshop: webshopAgg,
                webshopDebug: [],
                sources: [],
                method: "browser",
                error: status ? `HTTP ${status}` : "no_response",
            };
        }
        await delay(800);
        await dismissCookieBanners(page);
        await delay(300);
        await scrollToBottom(page);
        await delay(550);
        await dismissCookieBanners(page);

        try {
            const mailtoLinks = await page.$$eval("a[href^='mailto:']", (as) =>
                as
                    .map((a) => a.getAttribute("href"))
                    .filter(Boolean)
                    .map((href) => href.replace(/^mailto:/i, "").split("?")[0]),
            );
            if (mailtoLinks.length) emails.push(...mailtoLinks);
        } catch {}

        const mainIngest = await ingestFromCurrentPage("main");
        if (mainIngest.parked) {
            return {
                success: true,
                companyName: "",
                emails: [],
                phones: [],
                orgnrs: pickBestOrgnr(orgBucket, 2),
                contactPageUsed: page.url(),
                webshop: webshopAgg,
                webshopDebug: [...new Set(webshopDebug)].slice(0, 120),
                sources: [...new Set(sources)].slice(0, 10),
                method: "browser",
            };
        }

        const links = await page.$$eval("a[href]", (as) =>
            as
                .map((a) => ({
                    href: a.getAttribute("href"),
                    text: (a.innerText || "").trim(),
                }))
                .filter((x) => x.href),
        );
        const originUrl = new URL(page.url());
        const originBase = originUrl.origin;
        const candidates = [];

        let navLinks = [];
        try {
            navLinks = await page.evaluate(() => {
                const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
                const roots = [
                    document.querySelector("header"),
                    document.querySelector("nav"),
                    document.querySelector('[role="navigation"]'),
                ].filter(Boolean);
                const out = [];
                for (const root of roots) {
                    root.querySelectorAll("a[href]").forEach((a) => {
                        const href = a.getAttribute("href") || "";
                        const txt = norm(a.innerText || a.textContent || "");
                        if (href) out.push({ href, text: txt });
                    });
                }
                return out;
            });
        } catch {}

        for (const l of navLinks) {
            try {
                const full = new URL(l.href, originBase).href;
                if (!full.startsWith(originBase)) continue;
                const score =
                    (isContactLike(full) || isContactLike(l.text) ? 8 : 0) +
                    (isCommerceLike(full) || isCommerceLike(l.text) ? 3 : 0);
                if (score > 0) candidates.push({ url: full, score });
            } catch {}
        }

        for (const l of links) {
            try {
                const full = new URL(l.href, originBase).href;
                if (!full.startsWith(originBase)) continue;
                const score =
                    (isContactLike(full) || isContactLike(l.text) ? 4 : 0) +
                    (isCommerceLike(full) || isCommerceLike(l.text) ? 2 : 0);
                if (score > 0) candidates.push({ url: full, score });
            } catch {}
        }

        const commonPaths = [
            "/kontakt",
            "/kontakta-oss",
            "/contact",
            "/contact-us",
            "/om-oss",
            "/about",
            "/kundtjanst",
            "/kundtjänst",
            "/customer-service",
            "/support",
            "/integritet",
            "/privacy",
            "/policy",
            "/villkor",
            "/terms",
            "/impressum",
            "/cart",
            "/varukorg",
            "/kundvagn",
            "/checkout",
            "/kassa",
            "/shop",
            "/butik",
            "/products",
            "/produkter",
        ];
        for (const p of commonPaths) {
            try {
                const u = new URL(p, originBase).href;
                const score =
                    (isContactLike(p) ? 6 : 0) + (isCommerceLike(p) ? 2 : 0);
                candidates.push({ url: u, score });
            } catch {}
        }

        const unique = [];
        const seen = new Set();
        candidates
            .sort((a, b) => b.score - a.score)
            .forEach((c) => {
                const key = c.url.split("#")[0];
                if (!seen.has(key)) {
                    seen.add(key);
                    unique.push({ url: key, score: c.score });
                }
            });

        for (const c of unique.slice(0, maxInternalLinks)) {
            try {
                const r = await page.goto(c.url, {
                    waitUntil: "domcontentloaded",
                    timeout: 25000,
                });
                if (!r || r.status() >= 400) continue;
                await delay(600);
                await dismissCookieBanners(page);
                await delay(300);
                await scrollToBottom(page);
                await delay(500);
                try {
                    const mailtoLinks = await page.$$eval(
                        "a[href^='mailto:']",
                        (as) =>
                            as
                                .map((a) => a.getAttribute("href"))
                                .filter(Boolean)
                                .map((href) =>
                                    href.replace(/^mailto:/i, "").split("?")[0],
                                ),
                    );
                    if (mailtoLinks.length) emails.push(...mailtoLinks);
                } catch {}
                const label = isContactLike(c.url) ? "contact_like" : "internal";
                await ingestFromCurrentPage(label);
                if (isContactLike(c.url)) contactPageUsed = c.url;
                const finalOrgsNow = pickBestOrgnr(orgBucket, 2);
                if (
                    (companyName && finalOrgsNow.length >= 1) ||
                    ([...new Set(emails)].length >= 1 && finalOrgsNow.length >= 1)
                ) {
                    break;
                }
            } catch {}
        }

        const finalEmails = [...new Set(emails)]
            .map((e) => e.toLowerCase())
            .filter((e) => !isPlaceholderEmail(e))
            .filter((e) => !emailLooksLikeFile(e));
        const siteHost = getSiteHost(origin);
        const matching = finalEmails.filter((e) =>
            domainMatchesSite(e.split("@")[1], siteHost),
        );
        const finalChosen = (matching.length ? matching : finalEmails).slice(
            0,
            matching.length ? 3 : 2,
        );

        return {
            success: true,
            companyName: companyName || "",
            emails: finalChosen,
            phones: [...new Set(phones)].slice(0, 3),
            orgnrs: pickBestOrgnr(orgBucket, 2),
            contactPageUsed: contactPageUsed || originBase,
            webshop: webshopAgg,
            webshopDebug: [...new Set(webshopDebug)].slice(0, 120),
            sources: [...new Set(sources)].slice(0, 10),
            method: "browser",
        };
    } catch (err) {
        return {
            success: false,
            companyName: "",
            emails: [],
            phones: [],
            orgnrs: [],
            contactPageUsed: "",
            webshop: webshopAgg,
            webshopDebug: [],
            sources: [],
            method: "browser",
            error: err.message,
        };
    }
}

// ---- Fallback wrapper ----
async function extractDomainEnrichment(page, origin) {
    const staticRes = await extractStatic(origin);

    if ((staticRes.sources || []).includes("parked_domain_detected")) {
        return staticRes;
    }

    const staticHasAny =
        staticRes.success &&
        (staticRes.emails.length > 0 ||
            staticRes.phones.length > 0 ||
            staticRes.orgnrs.length > 0 ||
            !!staticRes.companyName);

    const needBrowserForIdentity =
        staticRes.success &&
        (!staticRes.companyName || !mustContainAB(staticRes.companyName)) &&
        staticRes.orgnrs.length === 0;

    if (staticHasAny && !needBrowserForIdentity) return staticRes;
    return await extractWithBrowser(page, origin);
}

// ---- Main ----
(async () => {
    console.log("📋 Enrichely Lead Enricher + SEO Scorer");
    console.log("====================================");
    console.log(`Input:  ${INPUT_CSV}`);
    console.log(
        `Output: ${OUTPUT_CSV}${
            RESUME && fs.existsSync(OUTPUT_CSV) ? " (resume)" : ""
        }`,
    );
    console.log(`URL col: ${URL_COLUMN}   SEO samples/site: ${SEO_SAMPLE_COUNT}`);
    if (START) console.log(`Start:  ${START}`);
    console.log("====================================\n");

    if (!fs.existsSync(INPUT_CSV)) {
        console.error(`❌ Input file not found: ${INPUT_CSV}`);
        process.exit(1);
    }
    const { rows, headers } = loadCsv(INPUT_CSV);
    if (!headers.includes(URL_COLUMN)) {
        console.error(`❌ CSV must have a "${URL_COLUMN}" column`);
        process.exit(1);
    }
    for (const c of OUTPUT_COLUMNS) if (!headers.includes(c)) headers.push(c);

    // Resume: merge prior output rows by origin key
    const processedOrigins = new Set();
    if (RESUME && fs.existsSync(OUTPUT_CSV)) {
        try {
            const prev = loadCsv(OUTPUT_CSV);
            const byKey = new Map();
            for (const r of prev.rows || []) {
                const k = originKeyFromRow(r, URL_COLUMN);
                if (!k) continue;
                if (isRowProcessed(r)) {
                    byKey.set(k, r);
                    processedOrigins.add(k);
                }
            }
            for (const r of rows) {
                const k = originKeyFromRow(r, URL_COLUMN);
                if (!k) continue;
                const src = byKey.get(k);
                if (!src) continue;
                for (const c of OUTPUT_COLUMNS) {
                    if (src[c] != null && src[c] !== "") r[c] = src[c];
                }
            }
            console.log(
                `Resume: ${processedOrigins.size} domains already processed`,
            );
        } catch (e) {
            console.warn(`⚠️ Could not parse prior output: ${e.message}`);
        }
    }

    const originToRows = new Map();
    for (let i = 0; i < rows.length; i++) {
        const raw = rows[i][URL_COLUMN];
        const key = canonicalOriginKey(raw);
        if (!key) continue;
        if (!originToRows.has(key)) originToRows.set(key, []);
        originToRows.get(key).push(i);
        if (isRowProcessed(rows[i])) processedOrigins.add(key);
    }

    const allOrigins = Array.from(originToRows.keys());
    const remaining = allOrigins.filter((k) => !processedOrigins.has(k));
    console.log(`Total unique domains: ${allOrigins.length}`);
    console.log(`Already processed: ${processedOrigins.size}`);
    console.log(`Remaining: ${remaining.length}`);

    if (remaining.length === 0) {
        if (fs.existsSync(OUTPUT_CSV)) writeCsv(OUTPUT_CSV, rows, headers);
        console.log("✓ Nothing to process.");
        process.exit(0);
    }

    const origins = remaining.slice(START, START + LIMIT);
    console.log(
        `Will process: ${origins.length} (start=${START}, limit=${LIMIT})\n`,
    );
    if (!origins.length) process.exit(0);

    // Launch & page-init are factored out so we can recycle them on memory
    // bloat or after a Chrome-side crash (ProtocolError, target_closed, etc.).
    // protocolTimeout is bumped from the puppeteer default (~30s) because heavy
    // pages occasionally stall CDP calls like addScriptToEvaluateOnNewDocument.
    async function launchBrowser() {
        const b = await puppeteer.launch({
            headless: HEADLESS,
            ignoreHTTPSErrors: true,
            protocolTimeout: 180_000,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
        const p = await b.newPage();
        await p.setViewport({ width: 1366, height: 900 });
        await p.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        );
        return { browser: b, page: p };
    }

    let { browser, page } = await launchBrowser();
    let processed = 0;
    let sinceRecycle = 0;
    for (const originKey of origins) {
        processed++;
        sinceRecycle++;
        console.log(`\n[${processed}/${origins.length}] Domain: ${originKey}`);

        // Periodic recycle: close the browser and reopen. Cheap (~2s) and
        // prevents the slow accumulation of Chrome memory / leaked CDP state.
        if (sinceRecycle >= BROWSER_RECYCLE_EVERY) {
            sinceRecycle = 0;
            try {
                await browser.close();
            } catch {}
            console.log(
                `   ♻️  recycling browser after ${BROWSER_RECYCLE_EVERY} domains`,
            );
            ({ browser, page } = await launchBrowser());
        }

        const origin = (() => {
            try {
                const u = new URL(originKey);
                u.protocol = "https:";
                return u.origin;
            } catch {
                return originKey;
            }
        })();

        // Outer try/catch survives Chrome-side failures (ProtocolError,
        // Target closed, addScriptToEvaluateOnNewDocument timeout, etc.).
        // Without this, one bad page would kill the whole run and we'd
        // lose hours of work. Bad domain → row gets marked with the error
        // in `debug` and we move on. If the browser itself looks dead
        // (target_closed / protocol_), recycle it so the next domain
        // starts from a clean Chrome.
        let res;
        let domainError = null;
        try {
            res = await extractDomainEnrichment(page, origin);
        } catch (e) {
            domainError = e?.message || String(e);
            console.log(`   ⚠️  domain error: ${domainError.slice(0, 120)}`);
            res = {
                success: false,
                companyName: "",
                emails: [],
                phones: [],
                orgnrs: [],
                contactPageUsed: "",
                webshop: null,
                webshopDebug: [],
                sources: [],
                method: "browser",
                error: domainError,
            };
            // If this looks like a Chrome-side failure (not a network/HTTP
            // issue with the target site), force a recycle before the next
            // domain. The page object is probably unusable.
            if (
                /ProtocolError|Target closed|Session closed|Connection closed|Protocol error/i.test(
                    domainError,
                )
            ) {
                console.log(
                    `   ♻️  forcing browser recycle (chrome-side error)`,
                );
                try {
                    await browser.close();
                } catch {}
                ({ browser, page } = await launchBrowser());
                sinceRecycle = 0;
            }
        }

        // SEO scoring + product count for confirmed webshops
        let seo = null;
        let productCountEstimate = 0;
        const seoDebug = [];

        if (res.success && res.webshop?.isWebshop) {
            // Sitemap-based product discovery
            try {
                const sm = await fetchSitemapProductUrls(origin, 80);
                productCountEstimate = sm.productUrls.length;
                if (productCountEstimate)
                    seoDebug.push(
                        `sitemap:${productCountEstimate}_products_from_${sm.sitemapsTried.length}_sitemaps`,
                    );

                let productUrls = sm.productUrls;
                if (productUrls.length < SEO_SAMPLE_COUNT) {
                    // Fallback: harvest product cards via DOM
                    try {
                        await page.goto(origin, {
                            waitUntil: "domcontentloaded",
                            timeout: 30000,
                        });
                        await delay(700);
                        await dismissCookieBanners(page);
                        const more = await page.evaluate(() => {
                            const out = [];
                            document
                                .querySelectorAll("a[href]")
                                .forEach((a) => {
                                    const href = a.getAttribute("href") || "";
                                    if (
                                        /\/(product|products|produkter|produkt|shop|butik|p|item|artikel|vara)\//i.test(
                                            href,
                                        )
                                    )
                                        out.push(href);
                                });
                            return out;
                        });
                        const merged = [
                            ...productUrls,
                            ...more
                                .map((h) => {
                                    try {
                                        return new URL(h, origin).href;
                                    } catch {
                                        return null;
                                    }
                                })
                                .filter(Boolean),
                        ];
                        const dedup = new Set();
                        productUrls = merged.filter((u) => {
                            const k = u.split("#")[0].split("?")[0];
                            if (dedup.has(k)) return false;
                            dedup.add(k);
                            return true;
                        });
                        seoDebug.push(`dom_fallback:${productUrls.length}_urls`);
                    } catch {}
                }

                productCountEstimate = Math.max(
                    productCountEstimate,
                    productUrls.length,
                );

                if (productUrls.length) {
                    seo = await scoreSeoOnProductPages(
                        page,
                        productUrls,
                        SEO_SAMPLE_COUNT,
                    );
                    if (seo) {
                        seoDebug.push(
                            `seo_sampled:${seo.pagesSampled} gap:${seo.gapScore}`,
                        );
                    }
                }
            } catch (e) {
                seoDebug.push(`seo_error:${(e.message || "").slice(0, 80)}`);
            }
        }

        // Clerk.io detection — fetch homepage statically and scan for snippets.
        // Cheap (~one extra GET, often cached at the OS level after Stage 3's
        // earlier fetch) and avoids reshaping the extractor return values.
        let clerk = { uses: false, evidence: [] };
        if (res.success && !(res.sources || []).includes("parked_domain_detected")) {
            try {
                const fetched = await fetchStaticWithFallbacks(origin);
                if (fetched.html) clerk = detectClerkIo(fetched.html);
            } catch {}
        }

        const { score: leadScore, reasons } = computeLeadScore({
            res,
            seo,
            productCountEstimate,
            clerk,
        });

        const idxs = originToRows.get(originKey) || [];
        for (const idx of idxs) {
            const row = rows[idx];
            row.domain = getSiteHost(originKey) || "";
            row.company_name = res.companyName || "";
            row.orgnr = (res.orgnrs || []).join("; ");
            row.email = (res.emails || []).join("; ");
            row.phone = (res.phones || []).join("; ");
            row.contact_page = res.contactPageUsed || origin;
            row.source = res.method || "not_found";

            const ws = res.webshop || {
                isWebshop: false,
                checkoutProviders: [],
                webshopSignals: [],
            };
            row.is_webshop = ws.isWebshop ? "yes" : "no";
            const providers = (ws.checkoutProviders || []).map(
                (p) => `provider:${p}`,
            );
            row.webshop_signals = [
                ...new Set([...(ws.webshopSignals || []), ...providers]),
            ]
                .slice(0, 20)
                .join("; ");
            row.webshop_platform = (ws.checkoutProviders || []).join(",");
            row.webshop_debug = (res.webshopDebug || []).join(" | ");

            row.product_count_estimate = productCountEstimate || "";

            if (seo) {
                row.seo_pages_sampled = seo.pagesSampled;
                row.seo_avg_title_len = seo.avgTitleLen;
                row.seo_avg_desc_len = seo.avgDescLen;
                row.seo_missing_meta_desc_pct = seo.missingMetaDescPct;
                row.seo_missing_h1_pct = seo.missingH1Pct;
                row.seo_duplicate_title_pct = seo.duplicateTitlePct;
                row.seo_avg_alt_coverage_pct = seo.avgAltCoveragePct;
                row.seo_avg_product_desc_words = seo.avgProductDescWords;
                row.seo_jsonld_product_pct = seo.jsonLdProductPct;
                row.seo_gap_score = seo.gapScore;
            } else {
                row.seo_pages_sampled = "";
                row.seo_avg_title_len = "";
                row.seo_avg_desc_len = "";
                row.seo_missing_meta_desc_pct = "";
                row.seo_missing_h1_pct = "";
                row.seo_duplicate_title_pct = "";
                row.seo_avg_alt_coverage_pct = "";
                row.seo_avg_product_desc_words = "";
                row.seo_jsonld_product_pct = "";
                row.seo_gap_score = "";
            }

            row.uses_clerk_io = clerk.uses ? "yes" : "no";
            row.clerk_io_evidence = (clerk.evidence || []).join(";");

            row.lead_score = leadScore;
            row.lead_reasons = (reasons || []).join(", ");

            const debugBits = [];
            if (!res.success) {
                debugBits.push(res.error || "not_found");
                debugBits.push(`method:${res.method || "unknown"}`);
            }
            if ((res.sources || []).includes("parked_domain_detected"))
                debugBits.push("parked_domain_detected");
            if (seoDebug.length) debugBits.push(seoDebug.join(" | "));
            row.debug = debugBits.join(" | ");
        }

        console.log(
            `   ↳ webshop=${res.webshop?.isWebshop ? "yes" : "no"} ` +
                `products~${productCountEstimate} ` +
                `seo_gap=${seo?.gapScore ?? "-"} ` +
                `clerk=${clerk.uses ? "yes" : "no"} ` +
                `lead_score=${leadScore}`,
        );

        if (processed % 5 === 0) {
            writeCsv(OUTPUT_CSV, rows, headers);
            console.log(`💾 Saved progress: ${OUTPUT_CSV}`);
        }
        await delay(1200);
    }

    await browser.close();
    writeCsv(OUTPUT_CSV, rows, headers);
    console.log("\n====================================");
    console.log("✅ Done");
    console.log(`Domains processed: ${origins.length}`);
    console.log(`Output: ${OUTPUT_CSV}`);
    console.log("====================================");
})();
