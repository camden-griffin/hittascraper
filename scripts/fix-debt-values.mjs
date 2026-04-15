/**
 * One-time fix: clear Recent_Year_Value / Previous_Year_Value entries that are
 * obviously wrong OCR artifacts (larger than total balance-sheet debt or > 50M).
 *
 * Usage: node scripts/fix-debt-values.mjs
 * Overwrites output/financial_data_atomic.csv in place (backs up original first).
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = resolve(__dirname, "../output/financial_data_atomic.csv");
const backupPath = csvPath + ".bak";

const MAX_HARD = 50_000_000;

// ── Minimal CSV parser (handles quoted fields with commas/newlines) ───────────
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuote = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (inQuote) {
            if (ch === '"' && next === '"') { field += '"'; i++; }
            else if (ch === '"') { inQuote = false; }
            else { field += ch; }
        } else {
            if (ch === '"') { inQuote = true; }
            else if (ch === ',') { row.push(field); field = ""; }
            else if (ch === '\r' && next === '\n') { row.push(field); field = ""; rows.push(row); row = []; i++; }
            else if (ch === '\n') { row.push(field); field = ""; rows.push(row); row = []; }
            else { field += ch; }
        }
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function stringifyCsv(rows) {
    return rows.map(row =>
        row.map(cell => {
            const s = (cell == null ? "" : String(cell));
            return (s.includes(",") || s.includes('"') || s.includes("\n"))
                ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(",")
    ).join("\r\n") + "\r\n";
}

// ── Load ──────────────────────────────────────────────────────────────────────
copyFileSync(csvPath, backupPath);
console.log("Backed up to", backupPath);

const raw = readFileSync(csvPath, "utf8");
const rows = parseCsv(raw).filter(r => r.length > 1);
const header = rows[0];
const body = rows.slice(1);

const idx = (name, nth = 1) => {
    let seen = 0;
    for (let i = 0; i < header.length; i++) {
        if (header[i] === name && ++seen === nth) return i;
    }
    return -1;
};

const iKort = idx("Kortfristiga_Skulder_SEK");
const iLang = idx("Langfristiga_Skulder_SEK");
const iRY1  = idx("Recent_Year_Value", 1);
const iPY1  = idx("Previous_Year_Value", 1);
const iRY2  = idx("Recent_Year_Value", 2);
const iPY2  = idx("Previous_Year_Value", 2);

console.log(`Columns — Kortfristiga:${iKort} Langfristiga:${iLang} RY1:${iRY1} PY1:${iPY1} RY2:${iRY2} PY2:${iPY2}`);

let cleared = 0;

for (const row of body) {
    const kort = Math.abs(Number((row[iKort] || "").replace(/\s/g, "")) || 0);
    const lang = Math.abs(Number((row[iLang] || "").replace(/\s/g, "")) || 0);
    const totalDebt = kort + lang;
    const ceiling = totalDebt > 0 ? Math.min(totalDebt * 1.05, MAX_HARD) : MAX_HARD;

    for (const i of [iRY1, iPY1, iRY2, iPY2]) {
        if (i < 0 || i >= row.length) continue;
        const v = (row[i] || "").toString().replace(/\s/g, "").replace(/^0+(\d)/, "$1");
        if (!v) continue;
        const n = Math.abs(parseInt(v, 10));
        if (!Number.isFinite(n) || n === 0) continue;
        if (n > ceiling) {
            row[i] = "";
            cleared++;
        }
    }
}

writeFileSync(csvPath, stringifyCsv([header, ...body]), "utf8");
console.log(`Done. Cleared ${cleared} bad values.`);
console.log(`Now run:  cd crm && npm run import-csv -- ../output/financial_data_atomic.csv`);
