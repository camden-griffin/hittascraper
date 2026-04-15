// src/processor.js
const fs = require("fs-extra");
const { createObjectCsvWriter } = require("csv-writer");

const config = require("./config");
const { parseMoneyStringToInt, normalizeLabel } = require("./utils");
const { scanPdfLenderKeywords } = require("./pdfKeywordScan");

function classifyBranch(branch) {
    const s = (branch || "").toString();
    if (!s) return "";
    const icp = config.icp || {};
    const core = icp.coreBranchPatterns || [];
    const secondary = icp.secondaryBranchPatterns || [];
    for (const re of core) if (re.test(s)) return "core";
    for (const re of secondary) if (re.test(s)) return "secondary";
    return "other";
}

function pickLatestValueFromTables(tables, labelRegex) {
    if (!Array.isArray(tables) || !tables.length) return null;
    for (const t of tables) {
        const label = (t?.rawLabel || "").toString();
        if (!labelRegex.test(label)) continue;

        const years = Array.isArray(t.years) ? t.years : [];
        const values = Array.isArray(t.values) ? t.values : [];
        if (!years.length || !values.length) continue;
        if (values.length !== years.length) continue;

        for (let i = 0; i < values.length; i++) {
            const parsed = parseMoneyStringToInt(values[i]);
            if (parsed !== null) {
                return {
                    year: years[i],
                    // Hitta finance tables are reported in TKR; convert to SEK.
                    value: parsed * (config.multiplier || 1000),
                };
            }
        }
    }
    return null;
}

function computeIcpScore(row) {
    const icp = config.icp || {};
    let score = 0;
    const reasons = [];

    if (row.Is_AB) {
        score++;
        reasons.push("AB");
    }

    const rev = Number(row.Omsattning_SEK);
    if (Number.isFinite(rev) && rev > 0) {
        if (
            rev >= (icp.revenueMinSEK || 3_000_000) &&
            rev <= (icp.revenueMaxSEK || 8_000_000)
        ) {
            score += 2;
            reasons.push("revenue_core");
        } else if (rev <= (icp.revenueSoftMaxSEK || 15_000_000)) {
            score += 1;
            reasons.push("revenue_soft");
        }
    }

    const emp = Number(row.Employees);
    if (Number.isFinite(emp) && emp > 0) {
        if (
            emp >= (icp.employeesMin || 2) &&
            emp <= (icp.employeesMax || 4)
        ) {
            score += 2;
            reasons.push("employees_core");
        } else if (emp <= (icp.employeesSoftMax || 10)) {
            score += 1;
            reasons.push("employees_soft");
        }
    }

    const regYear = Number(row.Reg_Year);
    if (Number.isFinite(regYear) && regYear > 1900) {
        const age = new Date().getFullYear() - regYear;
        if (age >= (icp.preferredCompanyAgeYears || 10)) {
            score += 2;
            reasons.push("age_core");
        } else if (age >= (icp.minCompanyAgeYears || 8)) {
            score += 1;
            reasons.push("age_soft");
        }
    }

    const segment = row.Branch_Segment;
    if (segment === "core") {
        score += 2;
        reasons.push("branch_core");
    } else if (segment === "secondary") {
        score += 1;
        reasons.push("branch_secondary");
    }

    if (row.Pdf_Lender_Keywords) {
        score += 2;
        reasons.push("has_lender_debt");
    }

    return { score, reasons: reasons.join(",") };
}

function canonicalKey(s) {
    return (s || "")
        .toString()
        .trim()
        .replace(/\s+/g, "")
        .replace(/[^0-9A-Za-zÅÄÖåäö]/g, "");
}

function safeColKey(prefix, key) {
    const k = canonicalKey(key) || "Unknown";
    return `${prefix}_${k}`;
}

function extractNumericTokens(line, max) {
    const limit = Number(max || 4);
    const text = (line || "").toString().replace(/\u00A0/g, " ");
    // Prefer matching thousand-grouped numbers as a single token,
    // but do not let the regex span multiple distinct numbers.
    const matches =
        text.match(
            /-?\d{1,4}(?:[ \u00A0.]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g,
        ) || [];

    const out = [];
    for (const m of matches) {
        const cleaned = m
            .replace(/\s+/g, "")
            .replace(/\./g, "")
            .replace(/,/g, "");

        if (!cleaned || cleaned === "-" || cleaned === "+") continue;
        // Avoid absurdly long numbers from OCR noise
        if (cleaned.replace(/^-/, "").length > 18) continue;
        out.push(cleaned);
        if (out.length >= limit) break;
    }
    return out;
}

function buildStructuredLineColumns(prefix, items, keys, opts) {
    const options = opts || {};
    const maxLinesPerKey = Number(options.maxLinesPerKey || 10);
    const maxNumsPerLine = Number(options.maxNumsPerLine || 10);

    const out = {};
    const buckets = new Map();

    const add = (key, obj) => {
        const k = canonicalKey(key);
        if (!k) return;
        if (!buckets.has(k)) buckets.set(k, []);
        const arr = buckets.get(k);
        if (arr.length >= maxLinesPerKey) return;
        arr.push(obj);
    };

    for (const it of Array.isArray(items) ? items : []) {
        if (!it) continue;
        if (typeof it === "string") {
            // If we lost the key, put under Unknown
            add("Unknown", { key: "Unknown", line: it, lineIndex: null });
            continue;
        }
        const key = (it.key || it.keyword || "Unknown").toString();
        const line = (it.line || "").toString();
        if (!line.trim()) continue;
        add(key, {
            key,
            line,
            lineIndex: it.lineIndex || null,
            values: Array.isArray(it.values) ? it.values : it.values || null,
        });
    }

    const canonicalKeys = Array.from(
        new Set((keys || []).map((k) => canonicalKey(k)).filter(Boolean)),
    );

    for (const ck of canonicalKeys) {
        const arr = buckets.get(ck) || [];
        for (let i = 0; i < maxLinesPerKey; i++) {
            const row = arr[i] || null;
            const base = `${prefix}_${ck}_Line${i + 1}`;
            out[base] = row ? row.line : "";
            out[`${base}_Idx`] =
                row && row.lineIndex ? String(row.lineIndex) : "";

            let nums = [];
            if (row) {
                if (Array.isArray(row.values) && row.values.length) {
                    nums = row.values
                        .map((v) =>
                            (v || "")
                                .toString()
                                .replace(/\u00A0/g, " ")
                                .trim()
                                .replace(/\s+/g, "")
                                .replace(/\./g, "")
                                .replace(/,/g, ""),
                        )
                        .slice(0, maxNumsPerLine);
                } else {
                    nums = extractNumericTokens(row.line, maxNumsPerLine);
                }
            }
            for (let n = 0; n < maxNumsPerLine; n++) {
                out[`${base}_Num${n + 1}`] = nums[n] || "";
            }
        }
    }

    return out;
}

/**
 * Clamp PDF-extracted debt line numbers against the balance sheet totals.
 * If a _Num value is larger than total debt (kortfristiga + langfristiga),
 * it's an OCR artifact — clear it.
 * Also clears any value > 50_000_000 unconditionally (no small construction
 * company in this dataset has a single credit-institution debt line that large).
 */
function sanitizeDebtNums(row, structuredKeys) {
    const MAX_HARD = 50_000_000;
    const totalDebt =
        (Number(row.Kortfristiga_Skulder_SEK) || 0) +
        (Number(row.Langfristiga_Skulder_SEK) || 0);
    const ceiling = totalDebt > 0 ? Math.min(totalDebt * 1.05, MAX_HARD) : MAX_HARD;

    for (const ck of structuredKeys) {
        for (let line = 1; line <= 10; line++) {
            for (let num = 1; num <= 10; num++) {
                const key = `Pdf_Lender_${ck}_Line${line}_Num${num}`;
                if (!(key in row)) continue;
                const raw = (row[key] || "").toString().replace(/\s/g, "");
                if (!raw) continue;
                const n = Math.abs(parseInt(raw, 10));
                if (!Number.isFinite(n)) continue;
                if (n > ceiling) row[key] = "";
            }
        }
    }
}

function keywordsArrayToJoinedString(arr) {
    if (!Array.isArray(arr) || !arr.length) return "";
    return Array.from(new Set(arr))
        .map((x) => (x || "").toString().trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "sv"))
        .join(";");
}

function linesArrayToJoinedString(arr) {
    if (!Array.isArray(arr) || !arr.length) return "";
    // Accept either strings or {key,line,lineIndex} objects.
    const parts = [];
    for (const item of arr) {
        if (!item) continue;
        if (typeof item === "string") {
            const s = item.trim();
            if (s) parts.push(s);
            continue;
        }
        const key = (item.key || item.keyword || "").toString().trim();
        const line = (item.line || "").toString().trim();
        if (!line) continue;
        parts.push(key ? `${key}: ${line}` : line);
    }
    return Array.from(new Set(parts)).join(" || ");
}

function computeBestKeywordsByOrgFromJsonl(pdfKeywordMap) {
    const out = new Map(); // orgNr -> joined string
    if (!fs.existsSync(config.paths.financeJsonl)) return out;

    const lines = fs
        .readFileSync(config.paths.financeJsonl, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);

    for (const line of lines) {
        let obj;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }

        const orgNr = obj.org;
        if (!orgNr) continue;

        const fromJsonl = keywordsArrayToJoinedString(obj.lenderKeywords);
        const prev = out.get(orgNr) || "";

        if (fromJsonl) {
            // Union: preserve any previous hits, but prefer the JSONL union overall.
            const merged = keywordsArrayToJoinedString(
                `${prev};${fromJsonl}`
                    .split(";")
                    .map((s) => s.trim())
                    .filter(Boolean),
            );
            out.set(orgNr, merged);
            continue;
        }

        // Fallback: if JSONL has no lenderKeywords, use PDF dir scan.
        if (!prev) {
            const set = pdfKeywordMap.get(orgNr);
            if (set && set.size) {
                out.set(
                    orgNr,
                    Array.from(set)
                        .sort((a, b) => a.localeCompare(b, "sv"))
                        .join(";"),
                );
            }
        }
    }

    return out;
}

async function writeContactsCsvFromJsonl(pdfKeywordMap) {
    if (!fs.existsSync(config.paths.financeJsonl)) {
        console.log(`No finance JSONL found at: ${config.paths.financeJsonl}`);
        return;
    }

    const lines = fs
        .readFileSync(config.paths.financeJsonl, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);

    const byOrg = new Map();

    const lenderKeysCanonical = Array.from(
        new Set(
            (config.pdfLenderKeywords || [])
                .map((k) => canonicalKey(k))
                .filter(Boolean),
        ),
    );

    // We only structure numeric line extraction for Kreditinstitut debts.
    const structuredKeysCanonical = [canonicalKey("Kreditinstitut")].filter(
        Boolean,
    );

    for (const line of lines) {
        let obj;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }

        const orgNr = obj.org;
        if (!orgNr) continue;

        const jsonlKeywords = Array.isArray(obj.lenderKeywords)
            ? obj.lenderKeywords
            : null;

        const jsonlKeywordLines = Array.isArray(obj.lenderKeywordLines)
            ? obj.lenderKeywordLines
            : null;
        const jsonlKreditinstitutSkulderLines = Array.isArray(
            obj.kreditinstitutSkulderLines,
        )
            ? obj.kreditinstitutSkulderLines
            : null;

        const derivedKreditinstitutSkulderLines =
            jsonlKreditinstitutSkulderLines ||
            (Array.isArray(jsonlKeywordLines)
                ? jsonlKeywordLines.filter((it) => {
                      try {
                          const key = (it?.key || it?.keyword || "")
                              .toString()
                              .toLowerCase();
                          if (key !== "kreditinstitut") return false;
                          const line = (it?.line || "").toString();
                          return /skuld/i.test(line);
                      } catch {
                          return false;
                      }
                  })
                : null);

        const tables = Array.isArray(obj.tables) ? obj.tables : [];
        const omsattningPick = pickLatestValueFromTables(
            tables,
            /^(nettoomsättning|omsättning|rörelsens intäkter)/i,
        );
        const rorelseresultatPick = pickLatestValueFromTables(
            tables,
            /^rörelseresultat/i,
        );
        const aretsResultatPick = pickLatestValueFromTables(
            tables,
            /^(årets resultat|resultat efter skatt)/i,
        );
        const kortfristigaPick = pickLatestValueFromTables(
            tables,
            /^kortfristiga skulder/i,
        );
        const langfristigaPick = pickLatestValueFromTables(
            tables,
            /^långfristiga skulder/i,
        );
        const branchSegment = classifyBranch(obj.branch);

        if (!byOrg.has(orgNr)) {
            let pdfLenderKeywords = "";
            if (jsonlKeywords && jsonlKeywords.length) {
                pdfLenderKeywords = Array.from(new Set(jsonlKeywords))
                    .sort((a, b) => a.localeCompare(b, "sv"))
                    .join(";");
            } else {
                const pdfKeywordsFound = pdfKeywordMap.get(orgNr);
                pdfLenderKeywords =
                    pdfKeywordsFound && pdfKeywordsFound.size
                        ? Array.from(pdfKeywordsFound)
                              .sort((a, b) => a.localeCompare(b, "sv"))
                              .join(";")
                        : "";
            }

            byOrg.set(orgNr, {
                OrgNr: orgNr,
                Name: obj.name || "Unknown",
                Email: obj.email || "",
                Phone: obj.phone || "",
                Is_AB: Boolean(obj.isAB),
                Reg_Year: obj.regYear || "",
                Company_Age:
                    obj.regYear &&
                    Number.isFinite(Number(obj.regYear))
                        ? new Date().getFullYear() - Number(obj.regYear)
                        : "",
                Employees: Number.isFinite(Number(obj.employees))
                    ? Number(obj.employees)
                    : "",
                Branch: obj.branch || "",
                Branch_Segment: branchSegment,
                SNI_Code: obj.sniCode || "",
                Omsattning_SEK: omsattningPick ? omsattningPick.value : "",
                Omsattning_Year: omsattningPick ? omsattningPick.year : "",
                Rorelseresultat_SEK: rorelseresultatPick
                    ? rorelseresultatPick.value
                    : "",
                Arets_Resultat_SEK: aretsResultatPick
                    ? aretsResultatPick.value
                    : "",
                Kortfristiga_Skulder_SEK: kortfristigaPick
                    ? kortfristigaPick.value
                    : "",
                Langfristiga_Skulder_SEK: langfristigaPick
                    ? langfristigaPick.value
                    : "",
                Pdf_Lender_Keywords: pdfLenderKeywords,
                Pdf_Lender_Keyword_Lines:
                    linesArrayToJoinedString(jsonlKeywordLines),
                Kreditinstitut_Skulder_Lines: linesArrayToJoinedString(
                    derivedKreditinstitutSkulderLines,
                ),
                ...buildStructuredLineColumns(
                    "Pdf_Lender",
                    jsonlKeywordLines,
                    structuredKeysCanonical,
                    { maxLinesPerKey: 10, maxNumsPerLine: 10 },
                ),
            });
            sanitizeDebtNums(byOrg.get(orgNr), structuredKeysCanonical);
            continue;
        }

        const row = byOrg.get(orgNr);
        if ((!row.Name || row.Name === "Unknown") && obj.name)
            row.Name = obj.name;
        if (!row.Email && obj.email) row.Email = obj.email;
        if (!row.Phone && obj.phone) row.Phone = obj.phone;
        if (!row.Is_AB && obj.isAB) row.Is_AB = true;
        if (!row.Reg_Year && obj.regYear) {
            row.Reg_Year = obj.regYear;
            row.Company_Age =
                new Date().getFullYear() - Number(obj.regYear);
        }
        if (
            (row.Employees === "" || row.Employees == null) &&
            Number.isFinite(Number(obj.employees))
        ) {
            row.Employees = Number(obj.employees);
        }
        if (!row.Branch && obj.branch) {
            row.Branch = obj.branch;
            row.Branch_Segment = branchSegment;
        }
        if (!row.SNI_Code && obj.sniCode) row.SNI_Code = obj.sniCode;
        if (row.Omsattning_SEK === "" && omsattningPick) {
            row.Omsattning_SEK = omsattningPick.value;
            row.Omsattning_Year = omsattningPick.year;
        }
        if (row.Rorelseresultat_SEK === "" && rorelseresultatPick) {
            row.Rorelseresultat_SEK = rorelseresultatPick.value;
        }
        if (row.Arets_Resultat_SEK === "" && aretsResultatPick) {
            row.Arets_Resultat_SEK = aretsResultatPick.value;
        }
        if (row.Kortfristiga_Skulder_SEK === "" && kortfristigaPick) {
            row.Kortfristiga_Skulder_SEK = kortfristigaPick.value;
        }
        if (row.Langfristiga_Skulder_SEK === "" && langfristigaPick) {
            row.Langfristiga_Skulder_SEK = langfristigaPick.value;
        }

        // Merge keywords across multiple JSONL entries.
        const fromJsonl = keywordsArrayToJoinedString(jsonlKeywords);
        if (fromJsonl) {
            row.Pdf_Lender_Keywords = keywordsArrayToJoinedString(
                `${row.Pdf_Lender_Keywords || ""};${fromJsonl}`
                    .split(";")
                    .map((s) => s.trim())
                    .filter(Boolean),
            );
        } else if (!row.Pdf_Lender_Keywords) {
            const set = pdfKeywordMap.get(orgNr);
            if (set && set.size) {
                row.Pdf_Lender_Keywords = Array.from(set)
                    .sort((a, b) => a.localeCompare(b, "sv"))
                    .join(";");
            }
        }

        const kwLines = linesArrayToJoinedString(jsonlKeywordLines);
        if (kwLines) {
            row.Pdf_Lender_Keyword_Lines = Array.from(
                new Set(
                    `${row.Pdf_Lender_Keyword_Lines || ""} || ${kwLines}`
                        .split(" || ")
                        .map((s) => s.trim())
                        .filter(Boolean),
                ),
            ).join(" || ");
        }

        const lenderStruct = buildStructuredLineColumns(
            "Pdf_Lender",
            jsonlKeywordLines,
            structuredKeysCanonical,
            { maxLinesPerKey: 10, maxNumsPerLine: 10 },
        );
        for (const [k, v] of Object.entries(lenderStruct)) {
            if (!row[k] && v) row[k] = v;
        }
        sanitizeDebtNums(row, structuredKeysCanonical);

        const kreditLines = linesArrayToJoinedString(
            derivedKreditinstitutSkulderLines,
        );
        if (kreditLines) {
            row.Kreditinstitut_Skulder_Lines = Array.from(
                new Set(
                    `${row.Kreditinstitut_Skulder_Lines || ""} || ${kreditLines}`
                        .split(" || ")
                        .map((s) => s.trim())
                        .filter(Boolean),
                ),
            ).join(" || ");
        }
    }

    const contactsWriter = createObjectCsvWriter({
        path: config.paths.contactsCsv,
        header: [
            { id: "ICP_Score", title: "ICP_Score" },
            { id: "ICP_Reasons", title: "ICP_Reasons" },
            { id: "OrgNr", title: "OrgNr" },
            { id: "Name", title: "Name" },
            { id: "Email", title: "Email" },
            { id: "Phone", title: "Phone" },
            { id: "Is_AB", title: "Is_AB" },
            { id: "Reg_Year", title: "Reg_Year" },
            { id: "Company_Age", title: "Company_Age" },
            { id: "Employees", title: "Employees" },
            { id: "Branch", title: "Branch" },
            { id: "Branch_Segment", title: "Branch_Segment" },
            { id: "SNI_Code", title: "SNI_Code" },
            { id: "Omsattning_SEK", title: "Omsattning_SEK" },
            { id: "Omsattning_Year", title: "Omsattning_Year" },
            { id: "Rorelseresultat_SEK", title: "Rorelseresultat_SEK" },
            { id: "Arets_Resultat_SEK", title: "Arets_Resultat_SEK" },
            {
                id: "Kortfristiga_Skulder_SEK",
                title: "Kortfristiga_Skulder_SEK",
            },
            {
                id: "Langfristiga_Skulder_SEK",
                title: "Langfristiga_Skulder_SEK",
            },
            { id: "Pdf_Lender_Keywords", title: "Lender_Keywords" },
            // Structured: produce two keyword-line groups with two values each.
            // IDs remain unique; titles match your requested short names.
            {
                id: `Pdf_Lender_${structuredKeysCanonical[0]}_Line1`,
                title: "Keyword_Line_1",
            },
            {
                id: `Pdf_Lender_${structuredKeysCanonical[0]}_Line1_Num1`,
                title: "Recent_Year_Value",
            },
            {
                id: `Pdf_Lender_${structuredKeysCanonical[0]}_Line1_Num2`,
                title: "Previous_Year_Value",
            },

            {
                id: `Pdf_Lender_${structuredKeysCanonical[0]}_Line2`,
                title: "Keyword_Line_2",
            },
            {
                id: `Pdf_Lender_${structuredKeysCanonical[0]}_Line2_Num1`,
                title: "Recent_Year_Value",
            },
            {
                id: `Pdf_Lender_${structuredKeysCanonical[0]}_Line2_Num2`,
                title: "Previous_Year_Value",
            },
        ],
    });

    const rows = Array.from(byOrg.values()).map((r) => {
        const { score, reasons } = computeIcpScore(r);
        return { ...r, ICP_Score: score, ICP_Reasons: reasons };
    });
    rows.sort((a, b) => (b.ICP_Score || 0) - (a.ICP_Score || 0));

    await contactsWriter.writeRecords(rows);
    console.log("Saved", rows.length, "rows to", config.paths.contactsCsv);

    const coreHits = rows.filter((r) => (r.ICP_Score || 0) >= 6).length;
    const warmHits = rows.filter(
        (r) => (r.ICP_Score || 0) >= 3 && (r.ICP_Score || 0) < 6,
    ).length;
    console.log(
        `ICP breakdown: ${coreHits} strong (score>=6), ${warmHits} warm (3-5), ${rows.length - coreHits - warmHits} weak`,
    );
}

/**
 * Winner-takes-all per (OrgNr, Label), with tie-breaks:
 * 1) Higher score wins (HTML_TABLE > PDF_TEXT > OCR)
 * 2) If same score, newer Year wins
 * 3) If same score & same Year, keep the first (stable)
 */
function upsertBest(db, rec, score) {
    const key = `${rec.OrgNr}|${rec.Label}`;
    const ex = db.get(key);

    if (!ex) {
        db.set(key, { ...rec, score });
        return;
    }

    if (score > ex.score) {
        db.set(key, { ...rec, score });
        return;
    }

    if (score === ex.score && Number(rec.Year) > Number(ex.Year)) {
        db.set(key, { ...rec, score });
        return;
    }

    // Even if we keep the existing numeric winner, allow later lines to enrich
    // missing metadata (email/phone/keywords/name).
    if ((!ex.Name || ex.Name === "Unknown") && rec.Name) ex.Name = rec.Name;
    if (!ex.Email && rec.Email) ex.Email = rec.Email;
    if (!ex.Phone && rec.Phone) ex.Phone = rec.Phone;
    if (!ex.Pdf_Lender_Keywords && rec.Pdf_Lender_Keywords)
        ex.Pdf_Lender_Keywords = rec.Pdf_Lender_Keywords;
}

/**
 * Pick the most recent NON-null value.
 * NOTE: Hitta years are typically newest -> oldest, e.g. [2025, 2024, 2023]
 * So iterate from index 0 upward.
 */
function pickLatestNonNull(years, rawValues) {
    if (!Array.isArray(years) || years.length < 1) return null;
    if (!Array.isArray(rawValues) || rawValues.length !== years.length)
        return null;

    const parsed = rawValues.map((v) => parseMoneyStringToInt(v));

    for (let i = 0; i < years.length; i++) {
        const val = parsed[i];
        if (val !== null) {
            return {
                year: years[i],
                value: val,
                rawJoined: rawValues.join(" | "),
            };
        }
    }

    return null;
}

function parseFinanceJsonl(db) {
    return parseFinanceJsonlWithExtras(db, new Map());
}

function parseFinanceJsonlWithExtras(db, pdfKeywordMap) {
    if (!fs.existsSync(config.paths.financeJsonl)) {
        console.log(`No finance JSONL found at: ${config.paths.financeJsonl}`);
        return;
    }

    const lines = fs
        .readFileSync(config.paths.financeJsonl, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);

    for (const line of lines) {
        let obj;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }

        const orgNr = obj.org;
        const name = obj.name || "Unknown";
        const email = obj.email || null;
        const phone = obj.phone || null;

        const jsonlKeywords = Array.isArray(obj.lenderKeywords)
            ? obj.lenderKeywords
            : null;

        let pdfLenderKeywords = "";
        if (jsonlKeywords && jsonlKeywords.length) {
            pdfLenderKeywords = Array.from(new Set(jsonlKeywords))
                .sort((a, b) => a.localeCompare(b, "sv"))
                .join(";");
        } else {
            const pdfKeywordsFound = pdfKeywordMap.get(orgNr);
            pdfLenderKeywords =
                pdfKeywordsFound && pdfKeywordsFound.size
                    ? Array.from(pdfKeywordsFound)
                          .sort((a, b) => a.localeCompare(b, "sv"))
                          .join(";")
                    : "";
        }

        for (const t of obj.tables || []) {
            const label = normalizeLabel(t.rawLabel);
            if (!label) continue;

            const years = t.years;
            const rawValues = t.values || [];

            if (!Array.isArray(years) || !Array.isArray(rawValues)) continue;
            if (rawValues.length !== years.length) continue;

            const picked = pickLatestNonNull(years, rawValues);
            if (!picked) continue;

            upsertBest(
                db,
                {
                    OrgNr: orgNr,
                    Name: name,
                    Email: email,
                    Phone: phone,
                    Pdf_Lender_Keywords: pdfLenderKeywords,
                    Source_Type: "HTML_TABLE",
                    Label: label,
                    Year: picked.year,
                    Value: picked.value * config.multiplier, // TKR -> SEK
                    Raw_Line: `${t.rawLabel} | ${picked.rawJoined}`,
                },
                config.sources.HTML_TABLE,
            );
        }
    }

    // Newer JSONL format may store numeric values under `lenderKeywordLines`
    // (from PDF extraction) rather than `tables`.  Accept those values as
    // PDF_TEXT sources so they are included in the atomic/wide outputs.
    if (Array.isArray(obj.lenderKeywordLines)) {
        for (const it of obj.lenderKeywordLines) {
            try {
                const rawLine = (it?.line || "").toString();
                const rawValues = Array.isArray(it.values) ? it.values : null;
                if (!rawLine || !rawValues || !rawValues.length) continue;

                // Prefer normalized label when possible, else fall back to raw line
                const lbl = normalizeLabel(rawLine) || rawLine.trim();
                if (!lbl) continue;

                // Pick the first non-null parsed money value (values are
                // typically newest -> oldest in these arrays).
                const parsed = rawValues.map((v) => parseMoneyStringToInt(v));
                let pickedVal = null;
                for (let i = 0; i < parsed.length; i++) {
                    if (parsed[i] !== null) {
                        pickedVal = {
                            year: "",
                            value: parsed[i],
                            rawJoined: rawValues.join(" | "),
                        };
                        break;
                    }
                }
                if (!pickedVal) continue;

                upsertBest(
                    db,
                    {
                        OrgNr: orgNr,
                        Name: name,
                        Email: email,
                        Phone: phone,
                        Pdf_Lender_Keywords: pdfLenderKeywords,
                        Source_Type: "PDF_TEXT",
                        Label: lbl,
                        Year: pickedVal.year,
                        Value: pickedVal.value * config.multiplier,
                        Raw_Line: `${rawLine} | ${pickedVal.rawJoined}`,
                    },
                    config.sources.PDF_TEXT,
                );
            } catch {
                continue;
            }
        }
    }
}

/**
 * Wide report = pivot of the atomic winners.
 * 1-year variant: each Label -> two columns:
 *   - <Label>
 *   - År   (header title repeats, but CSV ids remain unique via <Label>__År)
 *
 * Keeps only companies that exist in atomic output (no empty rows).
 */
async function writeWideReportFromAtomic(atomicRows) {
    // Prefer label order from config.labelMap (so it matches expected template),
    // then append any extra labels found (sorted).
    const presentLabels = new Set(
        atomicRows.map((r) => r.Label).filter(Boolean),
    );
    const preferred = (config.labelMap || [])
        .map((x) => x.label)
        .filter((lab) => presentLabels.has(lab));

    const extras = Array.from(presentLabels)
        .filter((lab) => !preferred.includes(lab))
        .sort();

    const labels = [...preferred, ...extras];

    // Group rows by OrgNr (keep name)
    const byOrg = new Map();
    for (const r of atomicRows) {
        const key = r.OrgNr;
        if (!byOrg.has(key)) {
            byOrg.set(key, {
                OrgNr: r.OrgNr,
                Name: r.Name,
                Email: r.Email || "",
                Phone: r.Phone || "",
                Pdf_Lender_Keywords: r.Pdf_Lender_Keywords || "",
            });
        }
        const row = byOrg.get(key);

        if (!row.Email && r.Email) row.Email = r.Email;
        if (!row.Phone && r.Phone) row.Phone = r.Phone;
        if (!row.Pdf_Lender_Keywords && r.Pdf_Lender_Keywords)
            row.Pdf_Lender_Keywords = r.Pdf_Lender_Keywords;

        // Value column
        row[r.Label] = r.Value;

        // Year column (unique key in data object, but header title will be "År")
        row[`${r.Label}__År`] = r.Year;
    }

    const wideRows = Array.from(byOrg.values());

    const header = [
        { id: "OrgNr", title: "OrgNr" },
        { id: "Name", title: "Name" },
        { id: "Email", title: "Email" },
        { id: "Phone", title: "Phone" },
        { id: "Pdf_Lender_Keywords", title: "Pdf_Lender_Keywords" },
        ...labels.flatMap((lab) => [
            { id: lab, title: lab },
            { id: `${lab}__År`, title: "År" },
        ]),
    ];

    const writer = createObjectCsvWriter({
        path: config.paths.wideReportCsv,
        header,
    });

    await writer.writeRecords(wideRows);
    console.log(
        "Saved",
        wideRows.length,
        "rows to",
        config.paths.wideReportCsv,
    );
}

async function processAll() {
    fs.ensureDirSync(config.paths.outputDir);

    if (!fs.existsSync(config.paths.financeJsonl)) {
        throw new Error(
            `Missing finance JSONL: ${config.paths.financeJsonl}. Run: npm run scrape (or npm run pipeline) first.`,
        );
    }

    // Optional enrichment: scan PDFs for lender keywords
    let pdfKeywordMap = new Map();
    try {
        pdfKeywordMap = await scanPdfLenderKeywords();
    } catch {
        pdfKeywordMap = new Map();
    }

    // Exports focused output for your use case.
    // 1) contacts.csv
    await writeContactsCsvFromJsonl(pdfKeywordMap);

    // 2) wide_report.csv (kept for pipeline compatibility; same schema as contacts)
    try {
        fs.copyFileSync(config.paths.contactsCsv, config.paths.wideReportCsv);
        console.log(
            "Saved",
            "wide report to",
            config.paths.wideReportCsv,
            "(copied from contacts export)",
        );
    } catch (e) {
        console.log("Failed to write wide report:", e && e.message);
    }

    // 3) financial_data_atomic.csv (kept for pipeline compatibility; same schema as contacts)
    try {
        fs.copyFileSync(config.paths.contactsCsv, config.paths.outputCsv);
        console.log(
            "Saved",
            "atomic output to",
            config.paths.outputCsv,
            "(copied from contacts export)",
        );
    } catch (e) {
        console.log("Failed to write atomic output:", e && e.message);
    }
}

module.exports = processAll;
