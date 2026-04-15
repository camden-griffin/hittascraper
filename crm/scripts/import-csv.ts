import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '../data');
mkdirSync(dataDir, { recursive: true });

const db = new Database(resolve(dataDir, 'crm.db'));
db.pragma('journal_mode = WAL');

// Ensure schema exists
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    org_nr                TEXT PRIMARY KEY,
    name                  TEXT,
    email                 TEXT,
    phone                 TEXT,
    branch                TEXT,
    branch_segment        TEXT,
    sni_code              TEXT,
    icp_score             REAL,
    icp_reasons           TEXT,
    is_ab                 INTEGER,
    reg_year              INTEGER,
    company_age           INTEGER,
    employees             INTEGER,
    omsattning_sek        REAL,
    omsattning_year       INTEGER,
    rorelseresultat_sek   REAL,
    arets_resultat_sek    REAL,
    kortfristiga_skulder_sek  REAL,
    langfristiga_skulder_sek  REAL,
    lender_keywords       TEXT,
    keyword_line_1        TEXT,
    recent_year_value     TEXT,
    previous_year_value   TEXT,
    keyword_line_2        TEXT,
    recent_year_value_2   TEXT,
    previous_year_value_2 TEXT,
    resolved              INTEGER NOT NULL DEFAULT 0,
    resolved_at           TEXT,
    notes                 TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrate any old DBs missing new columns
const existingCols = (db.pragma('table_info(leads)') as { name: string }[]).map((c) => c.name);
const newCols: [string, string][] = [
  ['branch_segment', 'TEXT'], ['sni_code', 'TEXT'], ['icp_score', 'REAL'],
  ['icp_reasons', 'TEXT'], ['is_ab', 'INTEGER'], ['reg_year', 'INTEGER'],
  ['company_age', 'INTEGER'], ['employees', 'INTEGER'], ['omsattning_sek', 'REAL'],
  ['omsattning_year', 'INTEGER'], ['rorelseresultat_sek', 'REAL'],
  ['arets_resultat_sek', 'REAL'], ['kortfristiga_skulder_sek', 'REAL'],
  ['langfristiga_skulder_sek', 'REAL'],
];
for (const [col, type] of newCols) {
  if (!existingCols.includes(col)) db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${type}`);
}

const csvPath = process.argv[2] ?? resolve(__dirname, '../../output/financial_data_atomic.csv');
console.log(`Importing from: ${csvPath}`);

const raw = readFileSync(csvPath, 'utf8');

// Named parse for most columns
const namedRows = parse(raw, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
}) as Record<string, string>[];

// Positional parse to handle duplicate column names (Recent_Year_Value / Previous_Year_Value x2)
const positional = parse(raw, {
  columns: false,
  skip_empty_lines: true,
  relax_column_count: true,
}) as string[][];

const header = positional[0];
const body = positional.slice(1);

function nthIndex(name: string, nth: number): number {
  let seen = 0;
  for (let i = 0; i < header.length; i++) {
    if (header[i] === name && ++seen === nth) return i;
  }
  return -1;
}

const iRY2 = nthIndex('Recent_Year_Value', 2);
const iPY2 = nthIndex('Previous_Year_Value', 2);

const positionalMap = new Map<string, { ry2?: string; py2?: string }>();
for (const row of body) {
  const org = row[header.indexOf('OrgNr')]?.trim();
  if (!org) continue;
  positionalMap.set(org, {
    ry2: row[iRY2]?.trim() || undefined,
    py2: row[iPY2]?.trim() || undefined,
  });
}

function num(v: string | undefined): number | null {
  if (!v || v.trim() === '') return null;
  const n = Number(v.trim());
  return isNaN(n) ? null : n;
}
function str(v: string | undefined): string | null {
  return v?.trim() || null;
}

const upsert = db.prepare(`
  INSERT INTO leads (
    org_nr, name, email, phone,
    branch, branch_segment, sni_code,
    icp_score, icp_reasons, is_ab,
    reg_year, company_age, employees,
    omsattning_sek, omsattning_year,
    rorelseresultat_sek, arets_resultat_sek,
    kortfristiga_skulder_sek, langfristiga_skulder_sek,
    lender_keywords, keyword_line_1, recent_year_value, previous_year_value,
    keyword_line_2, recent_year_value_2, previous_year_value_2
  ) VALUES (
    @org_nr, @name, @email, @phone,
    @branch, @branch_segment, @sni_code,
    @icp_score, @icp_reasons, @is_ab,
    @reg_year, @company_age, @employees,
    @omsattning_sek, @omsattning_year,
    @rorelseresultat_sek, @arets_resultat_sek,
    @kortfristiga_skulder_sek, @langfristiga_skulder_sek,
    @lender_keywords, @keyword_line_1, @recent_year_value, @previous_year_value,
    @keyword_line_2, @recent_year_value_2, @previous_year_value_2
  )
  ON CONFLICT(org_nr) DO UPDATE SET
    name                     = excluded.name,
    email                    = excluded.email,
    phone                    = excluded.phone,
    branch                   = excluded.branch,
    branch_segment           = excluded.branch_segment,
    sni_code                 = excluded.sni_code,
    icp_score                = excluded.icp_score,
    icp_reasons              = excluded.icp_reasons,
    is_ab                    = excluded.is_ab,
    reg_year                 = excluded.reg_year,
    company_age              = excluded.company_age,
    employees                = excluded.employees,
    omsattning_sek           = excluded.omsattning_sek,
    omsattning_year          = excluded.omsattning_year,
    rorelseresultat_sek      = excluded.rorelseresultat_sek,
    arets_resultat_sek       = excluded.arets_resultat_sek,
    kortfristiga_skulder_sek = excluded.kortfristiga_skulder_sek,
    langfristiga_skulder_sek = excluded.langfristiga_skulder_sek,
    lender_keywords          = excluded.lender_keywords,
    keyword_line_1           = excluded.keyword_line_1,
    recent_year_value        = excluded.recent_year_value,
    previous_year_value      = excluded.previous_year_value,
    keyword_line_2           = excluded.keyword_line_2,
    recent_year_value_2      = excluded.recent_year_value_2,
    previous_year_value_2    = excluded.previous_year_value_2
`);

const importAll = db.transaction(() => {
  let count = 0;
  for (const r of namedRows) {
    const org_nr = r.OrgNr?.trim();
    if (!org_nr) continue;
    const pos = positionalMap.get(org_nr);
    upsert.run({
      org_nr,
      name: str(r.Name),
      email: str(r.Email),
      phone: str(r.Phone),
      branch: str(r.Branch),
      branch_segment: str(r.Branch_Segment),
      sni_code: str(r.SNI_Code),
      icp_score: num(r.ICP_Score),
      icp_reasons: str(r.ICP_Reasons),
      is_ab: r.Is_AB?.trim().toLowerCase() === 'true' ? 1 : 0,
      reg_year: num(r.Reg_Year),
      company_age: num(r.Company_Age),
      employees: num(r.Employees),
      omsattning_sek: num(r.Omsattning_SEK),
      omsattning_year: num(r.Omsattning_Year),
      rorelseresultat_sek: num(r.Rorelseresultat_SEK),
      arets_resultat_sek: num(r.Arets_Resultat_SEK),
      kortfristiga_skulder_sek: num(r.Kortfristiga_Skulder_SEK),
      langfristiga_skulder_sek: num(r.Langfristiga_Skulder_SEK),
      lender_keywords: str(r.Lender_Keywords),
      keyword_line_1: str(r.Keyword_Line_1),
      recent_year_value: str(r.Recent_Year_Value),
      previous_year_value: str(r.Previous_Year_Value),
      keyword_line_2: str(r.Keyword_Line_2),
      recent_year_value_2: pos?.ry2 ?? null,
      previous_year_value_2: pos?.py2 ?? null,
    });
    count++;
  }
  return count;
});

const count = importAll();
console.log(`Done. Upserted ${count} leads.`);
db.close();
