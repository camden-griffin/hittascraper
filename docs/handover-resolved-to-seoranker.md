# Handover: Build `seoranker` from resolved website links

You are building a new standalone VS Code project called `seoranker`. It takes the resolved company website links produced by the `hittascraper` pipeline and ranks each site's SEO. Start in an empty project root. Everything below describes what to build and the exact input it consumes.

---

## What it is

A batch SEO auditor for Swedish company websites. It:
- Reads a resolved leads CSV (the `target_url` column is the website to audit)
- Fetches each site (static HTML first, headless browser fallback for JS-heavy pages)
- Scores on-page + technical SEO signals into a 0–100 `seo_score` with a letter grade
- Writes an enriched CSV (same rows + new SEO columns) and resumes idempotently per domain
- Runs in batches with a polite delay, the same way the scraper does — never hammers a host

It mirrors the `hittascraper` design: CommonJS Node scripts, CSV in / CSV out, dedupe-by-domain, resumable, batch-friendly.

---

## Input it consumes

The upstream pipeline writes `*_resolved.csv` files (e.g. `batch_retail_1_resolved.csv`). Copy or point at one of those. Relevant columns:

| Column | Use |
|---|---|
| `target_url` | The website to audit (skip rows where this is empty) |
| `target_url_confidence` | `high`/`medium`/`low` — optionally only audit `high`+`medium` |
| `orgnr`, `company_name` | Carried through to output for joining back |
| `sni_branch_keyword` | Industry, carried through |

Rows with an empty `target_url` are skipped (not every company resolved to a site).

---

## File structure

```
seoranker/
├── src/
│   ├── rank_seo.js        — Main entry: read CSV, dedupe by domain, audit, write CSV
│   ├── fetch_page.js      — Static fetch (https) + puppeteer fallback, redirect-following
│   ├── audit.js           — Pure scoring: takes parsed HTML, returns {score, grade, signals}
│   ├── signals.js         — Individual SEO checks (title, meta, headings, https, etc.)
│   └── track_progress.js  — Read-only live dashboard over *_seo.csv (copy from hittascraper)
├── input/                 — Drop resolved CSVs here
├── output/                — Audited CSVs + run logs
├── package.json
└── docs/
    └── README.md
```

Keep it flat and dependency-light — match hittascraper's style (no framework, no build step).

---

## Key technical details

**Fetch strategy** (same ladder as `resolve_websites.js`)
- `https.get` with a desktop Chrome `User-Agent` and `Accept-Language: sv-SE`, follow up to 5 redirects, 15s timeout, cap body at ~6MB
- If static HTML is empty/JS-rendered (no `<title>`, near-empty `<body>`), fall back to `puppeteer` (already a hittascraper dep) and read the rendered DOM
- Treat parked-domain / placeholder pages as a fail signal, not a crash

**Dedupe + resume** (copy the pattern from `extract_domains_contacts_and_webshop.js`)
- Canonicalize each `target_url` to an origin key (protocol+host, strip `www.`) and audit each domain once
- A row is "processed" only if its OWN output columns (`seo_score`, `seo_debug`) are non-empty — do NOT count carried-through input columns like `company_name`, or every row looks done (this exact bug bit the contact extractor)
- `--fresh true` re-audits everything; default resumes from the existing output

**Scoring** (`audit.js` → 0–100, weights are a starting point — tune freely)
- Title tag present + 30–60 chars (15)
- Meta description present + 50–160 chars (10)
- Exactly one `<h1>`, sensible `<h2>` structure (10)
- HTTPS + valid cert, HTTP→HTTPS redirect (15)
- Mobile viewport meta tag (10)
- Canonical link + `lang` attribute (5)
- Open Graph / structured data (JSON-LD) present (10)
- Image `alt` coverage ratio (5)
- Page weight / response time bucket (10)
- Internal link count + sitemap.xml / robots.txt reachable (10)
- Grade from score: A ≥85, B ≥70, C ≥55, D ≥40, F otherwise

**Batching**
- `--limit N` (default 4000) and `--start N` for chunking, like the other scrapers
- `--delayMs` between domains (default ~800ms) to stay polite
- Write output every ~10 rows so a crash never loses a run

---

## Output columns (added per row)

| Column | Description |
|---|---|
| `seo_score` | 0–100 composite |
| `seo_grade` | A–F letter |
| `title` / `title_len` | `<title>` text + length |
| `meta_description_len` | Length of meta description (0 if missing) |
| `h1_count` | Number of `<h1>` tags |
| `has_viewport` | yes/no mobile viewport |
| `has_canonical` | yes/no |
| `has_structured_data` | yes/no JSON-LD / OG |
| `https` | yes/no served over HTTPS |
| `img_alt_ratio` | Fraction of `<img>` with alt text |
| `response_ms` | Fetch time bucket |
| `seo_signals` | Compact list of which checks passed/failed |
| `seo_debug` | Errors / unreachable / parked-domain notes |

---

## npm scripts

| Command | What it does |
|---|---|
| `npm run rank` | `node src/rank_seo.js` — audit a CSV |
| `npm run rank -- --input input/batch_retail_1_resolved.csv --limit 1000` | Audit a specific file/slice |
| `npm run rank -- --input <csv> --fresh true` | Re-audit, ignore existing output |
| `npm run track` | One-shot progress dashboard |
| `npm run track:watch` | Live dashboard (refreshes every 15s, Ctrl-C to stop) |

---

## First-time setup

```powershell
npm install puppeteer papaparse minimist
# copy a resolved CSV in:
cp ../hittascraper/input/batch_retail_1_resolved.csv input/
npm run rank -- --input input/batch_retail_1_resolved.csv --limit 1000
# watch it run in another terminal:
npm run track:watch
```

---

## Notes / gotchas carried over from hittascraper

- **Idempotency is by domain, not row** — multiple companies can share a site; audit the origin once and reuse the result.
- **`--fresh` only ignores the output file**, it does not override the per-row "processed" check — keep that check scoped to `seo_*` output columns only (see Key technical details).
- **Don't audit all 817k at once.** Run resolved batches as they land (`batch_*_resolved.csv` / `retail_*_resolved.csv`), in chunks, with a delay — same reasoning as the scraper: rate limits and IP bans.
- Output naming convention: `<input>_seo.csv` next to the input (e.g. `batch_retail_1_resolved_seo.csv`), so `track_progress.js` can glob `*_seo.csv`.
- `puppeteer` is already a dependency in hittascraper if you want to copy its install rather than re-download Chromium.
