// resolve_websites.js
// STAGE 2 of the Enrichely lead pipeline.
//
// Takes the candidate CSV from Stage 1 (source_candidates_allabolag.js) and
// fills the `target_url` column for rows where allabolag didn't already
// expose a homepage.
//
// Strategy (in order):
//   1. hitta.se search by orgnr → take canonical detail page →
//      extract `link[]` entry with `text:"Url"`. Verify the page's orgno
//      matches the row's orgnr before trusting the result.
//   2. hitta.se search by company name (fuzzy fallback) → same extraction,
//      same orgnr verification.
//   3. DuckDuckGo HTML search ("<company name> AB" hemsida) → take the
//      first non-blacklisted external result.
//   4. Google search → only used when DDG yields nothing AND --useGoogle
//      is passed, because Google rate-limits scrapers aggressively.
//
// Skips rows where `target_url` is already populated. Idempotent — re-run
// to resume.
//
// Usage:
//   npm run resolve-websites -- --input input/candidates.csv
//   npm run resolve-websites -- --input input/candidates.csv --output input/candidates.csv --useGoogle true

const fs = require("fs");
const path = require("path");
const https = require("https");
const Papa = require("papaparse");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));

const INPUT_CSV =
    argv.input ||
    argv.in ||
    path.join(__dirname, "..", "input", "candidates.csv");
const OUTPUT_CSV = argv.output || argv.out || INPUT_CSV;
const LIMIT = parseInt(argv.limit || "10000", 10);
const START = Math.max(0, parseInt(argv.start || "0", 10) || 0);
const REQUEST_DELAY_MS = Math.max(
    300,
    parseInt(argv.delayMs || "900", 10) || 900,
);
const USE_GOOGLE =
    argv.useGoogle === true || String(argv.useGoogle || "").toLowerCase() === "true";
const FORCE =
    argv.force === true || String(argv.force || "").toLowerCase() === "true";
// --retry-not-found: only re-resolve rows that previously came back not_found.
// Skips rows that already have a high/medium-confidence target_url. Useful for
// recovering rows we lost to Mojeek 403s on an earlier run.
const RETRY_NOT_FOUND =
    argv["retry-not-found"] === true ||
    String(argv["retry-not-found"] || argv.retryNotFound || "").toLowerCase() ===
        "true";
// --backfill-contacts: revisit already-resolved rows to fill email/phone from
// hitta (rows with a website but no email yet).
const BACKFILL_CONTACTS =
    argv["backfill-contacts"] === true ||
    String(argv["backfill-contacts"] || argv.backfillContacts || "").toLowerCase() ===
        "true";

const RESOLVE_COLUMNS = [
    "target_url",
    "target_url_source", // hitta_orgnr | hitta_name | hitta_contact_only | already_present | not_found
    "target_url_confidence", // high | medium | low
    "email", // email scraped from the hitta company page (orgno-scoped)
    "phone", // phone scraped from the hitta company page (orgno-scoped)
    "resolve_debug",
];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---- Generic HTTPS GET (follows redirects) ----
function httpGet(url, { timeout = 15000, maxRedirects = 5, host } = {}) {
    return new Promise((resolve, reject) => {
        const doReq = (u, redirectsLeft) => {
            const req = https.get(
                u,
                {
                    timeout,
                    headers: {
                        "User-Agent": UA,
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
                        res.resume();
                        reject(new Error(`HTTP ${code} for ${u}`));
                        return;
                    }
                    let data = "";
                    res.setEncoding("utf8");
                    res.on("data", (c) => {
                        data += c;
                        if (data.length > 6 * 1024 * 1024) {
                            req.destroy();
                            reject(new Error("Response too large"));
                        }
                    });
                    res.on("end", () => resolve({ finalUrl: u, body: data }));
                },
            );
            req.on("error", reject);
            req.on("timeout", () => {
                req.destroy(new Error("socket_timeout"));
                reject(new Error(`Timeout for ${u}`));
            });
        };
        doReq(url, maxRedirects);
    });
}

// ---- hitta.se: parse __NEXT_DATA__ ----
function parseHittaNextData(html) {
    const m = html.match(
        /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
}

// ---- Find homepage on a hitta company detail page ----
//
// Hitta company pages embed multiple companies' data as escaped JSON
// fragments (target + "similar companies"). Each company block contains
// `"orgno":"16XXXXXXXXXX"` followed by its own `link[]` array (which may
// or may not contain a `{text:"Url"}` entry pointing to the homepage).
//
// We segment the HTML by orgno boundaries: each segment runs from one
// orgno occurrence to the next. We pick ONLY the segment whose orgno
// matches expectedOrgnr, then look for a `text:"Url"` link within that
// segment. If none, the company genuinely has no website on hitta —
// return empty so the caller falls through to DDG/Google.
//
// This replaces an earlier "nearest URL to orgnr position" heuristic that
// silently picked sibling-company websites and confidently mislabeled
// them as the target's site.
function extractHomepageFromHittaCompanyHtml(html, { expectedOrgnr, expectedName }) {
    const out = { url: "", email: "", phone: "", matchedOrgnr: false, debug: [] };
    if (!html) return out;

    const orgnrDigits = (expectedOrgnr || "").replace(/\D/g, "");
    if (!orgnrDigits || orgnrDigits.length !== 10) {
        // Without an orgnr we can't safely segment — bail.
        out.debug.push("no_orgnr_for_segmentation");
        return out;
    }

    // Find every orgno occurrence in document order. Hitta prefixes orgnrs
    // with "16" for AB companies in the escaped JSON form `"orgno":"16XXXXXXXXXX"`.
    const orgRe = /\\"orgno\\":\\"(\d{10,14})\\"/g;
    const orgPositions = [];
    let m;
    while ((m = orgRe.exec(html))) {
        orgPositions.push({ orgno: m[1], pos: m.index });
    }

    if (!orgPositions.length) {
        out.debug.push("no_orgno_blocks");
        return out;
    }

    // Find the segment(s) whose orgno matches our target (with or without
    // leading "16"). If multiple matches, prefer the first.
    const targetSuffix = orgnrDigits;
    const matchIdx = orgPositions.findIndex(
        (o) => o.orgno === targetSuffix || o.orgno === `16${targetSuffix}`,
    );

    if (matchIdx === -1) {
        out.debug.push(`orgnr_not_in_blocks(${orgPositions.length}_blocks)`);
        return out;
    }

    out.matchedOrgnr = true;
    out.debug.push("orgnr_match");

    // Slice the segment: from this orgno's position up to the next orgno's
    // position (or end of doc for the last block).
    const start = orgPositions[matchIdx].pos;
    const end =
        matchIdx + 1 < orgPositions.length
            ? orgPositions[matchIdx + 1].pos
            : html.length;
    const segment = html.slice(start, end);

    // Within OUR segment only, look for a Url-labelled link.
    const urlRe =
        /\\"url\\":\\"(https?:[^\\"]+)\\",\\"text\\":\\"Url\\"/;
    const urlMatch = segment.match(urlRe);

    if (urlMatch) {
        out.url = urlMatch[1];
        out.debug.push("url_in_own_segment");
    } else {
        out.debug.push("no_url_in_segment");
    }

    // Within OUR segment only, also pull email + phone (hitta embeds both in
    // the same escaped-JSON company block as the Url link). Scoping to the
    // matched orgno segment avoids grabbing a sibling company's contact info.
    const emailMatch = segment.match(
        /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-z]{2,})/,
    );
    if (emailMatch && !/hitta\.se|sentry|w3\.org|example|@2x|\.(png|jpg|svg)/i.test(emailMatch[1])) {
        out.email = emailMatch[1];
        out.debug.push("email_in_segment");
    }
    // Phone: hitta uses "telephone":"+46..." (single) inside the block.
    const phoneMatch = segment.match(/\\"telephone\\":\\"(\+?[\d ]{6,})\\"/);
    if (phoneMatch) {
        out.phone = phoneMatch[1].trim();
        out.debug.push("phone_in_segment");
    }

    return out;
}

// ---- Look up company on hitta by query (orgnr or name) ----
async function hittaLookup(query, { expectedOrgnr, expectedName }) {
    const searchUrl = `https://www.hitta.se/s%C3%B6k?vad=${encodeURIComponent(
        query,
    )}`;
    let searchRes;
    try {
        searchRes = await httpGet(searchUrl);
    } catch (e) {
        return { url: "", confidence: "", debug: [`hitta_search_failed:${e.message}`] };
    }

    // The search page sometimes IS the company detail page (when query matches
    // an exact orgnr / name). Try extracting directly first.
    const direct = extractHomepageFromHittaCompanyHtml(searchRes.body, {
        expectedOrgnr,
        expectedName,
    });
    if (direct.url) {
        return {
            url: direct.url,
            email: direct.email,
            phone: direct.phone,
            confidence: direct.matchedOrgnr ? "high" : "medium",
            debug: ["hitta_direct", ...direct.debug],
        };
    }

    // Otherwise parse __NEXT_DATA__ and follow the canonical / top company
    const data = parseHittaNextData(searchRes.body);
    if (!data) return { url: "", confidence: "", debug: ["hitta_no_next_data"] };

    // Strategy A: canonical → fetch that page
    const meta = data?.props?.pageProps?.metaTags || [];
    const canon = meta.find((t) => t.rel === "canonical");
    const companies = data?.props?.pageProps?.result?.companies || [];

    const tryPages = [];
    if (canon?.href && /hitta\.se/.test(canon.href) && canon.href !== searchUrl) {
        tryPages.push(canon.href);
    }
    // Strategy B: take top company by score and build a detail URL
    for (const c of companies.slice(0, 3)) {
        if (!c.slug || !c.id) continue;
        const city = (c.address?.[0]?.city || "stockholm").toLowerCase();
        const detail = `https://www.hitta.se/${encodeURIComponent(c.slug)}/${encodeURIComponent(city)}/${c.id}`;
        if (!tryPages.includes(detail)) tryPages.push(detail);
    }

    for (const page of tryPages) {
        let pageRes;
        try {
            pageRes = await httpGet(page);
        } catch {
            continue;
        }
        const found = extractHomepageFromHittaCompanyHtml(pageRes.body, {
            expectedOrgnr,
            expectedName,
        });
        if (found.url) {
            return {
                url: found.url,
                email: found.email,
                phone: found.phone,
                confidence: found.matchedOrgnr ? "high" : "medium",
                debug: ["hitta_detail", page, ...found.debug],
            };
        }
    }

    return { url: "", confidence: "", debug: ["hitta_no_url_found"] };
}

// ---- Adaptive rate-limit state for search backends ----
//
// Each backend tracks (a) whether it's currently in a back-off window and
// (b) consecutive failure count. When a backend 403s or fails repeatedly, we
// stop calling it for a while instead of blasting it (which deepens the
// block). After a cool-down it re-enters circulation. Mojeek in particular
// flips between "happy" and "423 / 403 for 5 minutes" so a per-call retry
// just wastes time; this skips it cleanly until it likely recovers.
const rateLimitState = {
    mojeek: { blockedUntil: 0, consecutive403: 0 },
    brave: { blockedUntil: 0, consecutive403: 0 },
    ddg: { blockedUntil: 0, consecutive403: 0 },
};

function isBackendBlocked(name) {
    const s = rateLimitState[name];
    if (!s) return false;
    return Date.now() < s.blockedUntil;
}

function recordBackendFailure(name, err) {
    const s = rateLimitState[name];
    if (!s) return;
    const is403 = /HTTP 403|HTTP 429|HTTP 423|socket disconnected|socket hang up/i.test(
        err || "",
    );
    if (is403) {
        s.consecutive403++;
        // Exponential cool-down: 60s, 180s, 600s, 1800s, max 1800s
        const cooldownsSec = [60, 180, 600, 1800];
        const idx = Math.min(s.consecutive403 - 1, cooldownsSec.length - 1);
        s.blockedUntil = Date.now() + cooldownsSec[idx] * 1000;
    }
}

function recordBackendSuccess(name) {
    const s = rateLimitState[name];
    if (!s) return;
    s.consecutive403 = 0;
    s.blockedUntil = 0;
}

// ---- Mojeek HTML search (primary fallback) ----
// Mojeek serves real result links in static HTML without JS challenges, which
// DDG-HTML, DDG-Lite, Bing, and Google all currently refuse. Sometimes
// throttles for 5-30 minutes — the adaptive rate-limiter above skips it
// cleanly during those windows instead of wasting requests.
async function mojeekSearch(query, { expectedName }) {
    if (isBackendBlocked("mojeek")) {
        return {
            url: "",
            confidence: "",
            debug: [`mojeek_skipped_rate_limited`],
        };
    }
    const url = `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`;
    let res;
    try {
        res = await httpGet(url, { timeout: 15000 });
    } catch (e) {
        recordBackendFailure("mojeek", e.message);
        return { url: "", confidence: "", debug: [`mojeek_failed:${e.message}`] };
    }
    recordBackendSuccess("mojeek");
    const re = /href="(https?:\/\/[^"]{5,200})"/gi;
    const candidates = [];
    let m;
    while ((m = re.exec(res.body))) candidates.push(m[1]);
    return pickBestExternalResult(candidates, expectedName, "mojeek");
}

// ---- Brave Search HTML (secondary fallback) ----
// Brave's HTML response embeds real result <a href="..."> links and tolerates
// scraping more than Google/Bing. Used between Mojeek and DDG.
async function braveSearch(query, { expectedName }) {
    if (isBackendBlocked("brave")) {
        return {
            url: "",
            confidence: "",
            debug: [`brave_skipped_rate_limited`],
        };
    }
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    let res;
    try {
        res = await httpGet(url, { timeout: 15000 });
    } catch (e) {
        recordBackendFailure("brave", e.message);
        return { url: "", confidence: "", debug: [`brave_failed:${e.message}`] };
    }
    recordBackendSuccess("brave");
    const re = /href="(https?:\/\/[^"]{5,200})"/gi;
    const candidates = [];
    let m;
    while ((m = re.exec(res.body))) candidates.push(m[1]);
    return pickBestExternalResult(candidates, expectedName, "brave");
}

// ---- DuckDuckGo HTML search (tertiary fallback; often 403s) ----
async function ddgSearch(query, { expectedName }) {
    if (isBackendBlocked("ddg")) {
        return {
            url: "",
            confidence: "",
            debug: [`ddg_skipped_rate_limited`],
        };
    }
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
        query,
    )}`;
    let res;
    try {
        res = await httpGet(url, { timeout: 15000 });
    } catch (e) {
        recordBackendFailure("ddg", e.message);
        return { url: "", confidence: "", debug: [`ddg_failed:${e.message}`] };
    }
    recordBackendSuccess("ddg");
    const re = /<a [^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/gi;
    const candidates = [];
    let m;
    while ((m = re.exec(res.body))) {
        let href = m[1];
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) {
            try {
                href = decodeURIComponent(uddg[1]);
            } catch {}
        }
        candidates.push(href);
    }
    return pickBestExternalResult(candidates, expectedName, "ddg");
}

// ---- Google fallback (only if --useGoogle) ----
async function googleSearch(query, { expectedName }) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=sv`;
    let res;
    try {
        res = await httpGet(url, { timeout: 15000 });
    } catch (e) {
        return { url: "", confidence: "", debug: [`google_failed:${e.message}`] };
    }
    // Google's HTML results: <a href="/url?q=https://target...">
    const re = /<a [^>]*href="\/url\?q=(https?:\/\/[^&"]+)/gi;
    const candidates = [];
    let m;
    while ((m = re.exec(res.body))) {
        try {
            candidates.push(decodeURIComponent(m[1]));
        } catch {}
    }
    return pickBestExternalResult(candidates, expectedName, "google");
}

// ---- Pick best external result from a list of candidate URLs ----
const BLOCKLIST = [
    "hitta.se",
    "allabolag.se",
    "ratsit.se",
    "linkedin.com",
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "youtube.com",
    "wikipedia.org",
    "bing.com",
    "duckduckgo.com",
    "google.com",
    "yelp.",
    "merinfo.se",
    "eniro.se",
    "118100.se",
    "proff.se",
    "bolagsfakta.se",
    "kompass.com",
    "bolagsverket.se",
    "skatteverket.se",
    "rating.se",
    "reco.se",
    "schibsted",
    "dnb.com",
    "gulasidorna.se",
];

// Pick the best external candidate. We REQUIRE a clear name-token match in
// the hostname — otherwise we return empty rather than emit a low-confidence
// guess. False-positive outreach is worse than missing a row.
//
// Name-token derivation: take the company name minus "AB", strip non-letters,
// keep the first 4–12 chars, and require the hostname to contain it. Also
// allow partial matches if the FIRST word of the company name (≥4 chars) is
// in the hostname — handles cases like "Granngården AB" → "granngarden.se".
function pickBestExternalResult(candidates, expectedName, source) {
    const debug = [`${source}_candidates:${candidates.length}`];
    if (!candidates.length) return { url: "", confidence: "", debug };

    const nameClean = (expectedName || "")
        .toLowerCase()
        .replace(/\b(ab|aktiebolag|hb|kb)\b/g, "")
        .replace(/[åä]/g, "a")
        .replace(/ö/g, "o")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const fullToken = nameClean.replace(/\s+/g, "").slice(0, 16);
    const firstWord = nameClean.split(/\s+/)[0] || "";
    // Also try the stem without trailing possessive-s (Swedish genitive),
    // so "Elfströms" matches elfstrom.se.
    const firstWordToken = firstWord.length >= 4 ? firstWord : "";
    const firstWordStem =
        firstWordToken && firstWordToken.endsWith("s") && firstWordToken.length >= 5
            ? firstWordToken.slice(0, -1)
            : "";

    const ranked = [];
    for (const raw of candidates) {
        let u;
        try {
            u = new URL(raw);
        } catch {
            continue;
        }
        const host = u.hostname.toLowerCase().replace(/^www\./, "");
        if (BLOCKLIST.some((b) => host.includes(b))) continue;
        if (!/\.(se|com|nu|net|org|io|shop|online|store|eu)$/.test(host))
            continue;
        const flatHost = host
            .replace(/[åä]/g, "a")
            .replace(/ö/g, "o")
            .replace(/[^a-z0-9]/g, "");

        let score = 0;
        let strongMatch = false;
        if (fullToken && fullToken.length >= 4 && flatHost.includes(fullToken)) {
            score += 20;
            strongMatch = true;
        } else if (
            firstWordToken &&
            firstWordToken.length >= 4 &&
            flatHost.includes(firstWordToken)
        ) {
            score += 12;
            strongMatch = true;
        } else if (firstWordStem && flatHost.includes(firstWordStem)) {
            score += 10;
            strongMatch = true;
        }
        if (!strongMatch) continue; // hard requirement
        if (host.endsWith(".se")) score += 2;
        ranked.push({ host, score, url: u.origin });
    }
    if (!ranked.length) {
        debug.push(`${source}_no_name_match`);
        return { url: "", confidence: "", debug };
    }
    ranked.sort((a, b) => b.score - a.score);
    const best = ranked[0];
    // Strong match required to get here — emit medium confidence.
    const conf = best.score >= 20 ? "medium" : "low";
    debug.push(`${source}_picked:${best.host}(score=${best.score})`);
    return { url: best.url, confidence: conf, debug };
}

// ---- Main resolver per row ----
async function resolveRow(row) {
    const orgnr = (row.orgnr || "").replace(/[^0-9]/g, "");
    const name = row.company_name || row.legal_name || "";

    const debug = [];
    // Contact info (email/phone) is collected from the same hitta page as the
    // website — keep the best seen even if the URL itself is missing, so a
    // company with a hitta email but no listed website still yields contacts.
    let email = "";
    let phone = "";

    // 1. hitta by orgnr
    if (orgnr.length === 10) {
        const r = await hittaLookup(orgnr, {
            expectedOrgnr: orgnr,
            expectedName: name,
        });
        debug.push(...r.debug.map((d) => `hitta_orgnr:${d}`));
        if (r.email && !email) email = r.email;
        if (r.phone && !phone) phone = r.phone;
        if (r.url) {
            return {
                url: r.url,
                source: "hitta_orgnr",
                confidence: r.confidence,
                email,
                phone,
                debug,
            };
        }
        await delay(REQUEST_DELAY_MS);
    }

    // 2. hitta by name (fallback when orgnr search misses)
    if (name) {
        const r = await hittaLookup(name, {
            expectedOrgnr: orgnr,
            expectedName: name,
        });
        debug.push(...r.debug.map((d) => `hitta_name:${d}`));
        if (r.email && !email) email = r.email;
        if (r.phone && !phone) phone = r.phone;
        if (r.url) {
            return {
                url: r.url,
                source: "hitta_name",
                confidence: r.confidence,
                email,
                phone,
                debug,
            };
        }
    }

    // Search-engine fallbacks (Mojeek/Brave/DDG/Google) removed 2026-06-22:
    // slow, rate-limited/403-prone, and low-confidence. hitta-by-orgnr/name is
    // the fast, verified path; if hitta has no website, we mark not_found —
    // but still return any email/phone we picked up along the way.
    return {
        url: "",
        source: email || phone ? "hitta_contact_only" : "not_found",
        confidence: "",
        email,
        phone,
        debug,
    };
}

// ---- Main ----
(async () => {
    console.log("📋 Stage 2: Website resolver");
    console.log("====================================");
    console.log(`Input:  ${INPUT_CSV}`);
    console.log(`Output: ${OUTPUT_CSV}`);
    console.log(`Use Google fallback: ${USE_GOOGLE}`);
    console.log(`Force re-resolve: ${FORCE}`);
    console.log("====================================\n");

    if (!fs.existsSync(INPUT_CSV)) {
        console.error(`❌ Input not found: ${INPUT_CSV}`);
        process.exit(1);
    }

    const csv = fs.readFileSync(INPUT_CSV, "utf8");
    const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
    const rows = parsed.data;
    const headers = parsed.meta.fields || [];
    for (const c of RESOLVE_COLUMNS) if (!headers.includes(c)) headers.push(c);

    // Decide which rows need work for this run.
    //   FORCE = re-resolve everything
    //   RETRY_NOT_FOUND = only re-resolve rows previously marked not_found
    //   default = resolve rows that have no target_url at all
    const needsWork = (r) => {
        const has =
            (r.target_url && r.target_url.trim()) ||
            (r.homepage_from_allabolag && r.homepage_from_allabolag.trim());
        if (FORCE) return true;
        // --backfill-contacts: revisit rows that have no email yet so we can
        // fill email/phone from hitta on previously-resolved batches.
        if (BACKFILL_CONTACTS) return !(r.email || "").trim();
        if (RETRY_NOT_FOUND)
            return (
                !has ||
                (r.target_url_source || "").toLowerCase() === "not_found"
            );
        return !has;
    };

    let needWork = 0;
    for (const r of rows) if (needsWork(r)) needWork++;
    console.log(`Total rows: ${rows.length}   Need resolution: ${needWork}`);
    if (RETRY_NOT_FOUND) console.log("Mode: --retry-not-found");

    let processed = 0;
    let resolved = 0;
    let scanned = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        if (!needsWork(row)) {
            // Row is final from a prior run — backfill the source label
            // for rows that came in with an allabolag homepage but no source.
            if (!row.target_url && row.homepage_from_allabolag) {
                row.target_url = row.homepage_from_allabolag;
                row.target_url_source = "allabolag";
                row.target_url_confidence = "high";
            } else if (!row.target_url_source) {
                row.target_url_source = "already_present";
            }
            continue;
        }

        // Retry-mode housekeeping: clear stale not_found state so we don't
        // double-record old debug strings alongside fresh ones.
        if (
            RETRY_NOT_FOUND &&
            (row.target_url_source || "").toLowerCase() === "not_found"
        ) {
            row.target_url = "";
            row.target_url_source = "";
            row.target_url_confidence = "";
            row.resolve_debug = "";
        }

        scanned++;
        if (scanned <= START) continue;
        if (processed >= LIMIT) break;
        processed++;

        const label = row.company_name || row.orgnr || `row-${i}`;
        process.stdout.write(
            `[${processed}/${Math.min(needWork - START, LIMIT)}] ${label.slice(0, 60)} … `,
        );

        try {
            const r = await resolveRow(row);
            row.target_url = r.url || "";
            row.target_url_source = r.source;
            row.target_url_confidence = r.confidence || "";
            // Don't overwrite an existing email/phone with a blank; keep best.
            if (r.email && !(row.email || "").trim()) row.email = r.email;
            if (r.phone && !(row.phone || "").trim()) row.phone = r.phone;
            row.resolve_debug = (r.debug || []).join(" | ");
            if (r.url) {
                resolved++;
                const extra = [r.email && "✉", r.phone && "☎"].filter(Boolean).join("");
                console.log(`✓ ${r.url} (${r.source}/${r.confidence}) ${extra}`);
            } else if (r.email || r.phone) {
                console.log(`◐ contact-only ${r.email || ""} ${r.phone || ""}`);
            } else {
                console.log(`✗ not_found`);
            }
        } catch (e) {
            row.resolve_debug = `error:${e.message}`;
            console.log(`✗ error: ${e.message}`);
        }

        if (processed % 10 === 0) {
            const outCsv = Papa.unparse(rows, { columns: headers });
            fs.writeFileSync(OUTPUT_CSV, outCsv, "utf8");
        }
        await delay(REQUEST_DELAY_MS);
    }

    const outCsv = Papa.unparse(rows, { columns: headers });
    fs.writeFileSync(OUTPUT_CSV, outCsv, "utf8");
    console.log("\n====================================");
    console.log("✅ Stage 2 done");
    console.log(`Processed: ${processed}   Resolved: ${resolved}`);
    console.log(`Output: ${OUTPUT_CSV}`);
    console.log("====================================");
})().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
