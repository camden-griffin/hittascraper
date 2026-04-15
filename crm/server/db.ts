import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '../data');
mkdirSync(dataDir, { recursive: true });

export const db = new Database(resolve(dataDir, 'crm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    email     TEXT NOT NULL UNIQUE,
    password  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    org_nr               TEXT PRIMARY KEY,
    name                 TEXT,
    email                TEXT,
    phone                TEXT,
    branch               TEXT,
    lender_keywords      TEXT,
    keyword_line_1       TEXT,
    recent_year_value    TEXT,
    previous_year_value  TEXT,
    keyword_line_2       TEXT,
    recent_year_value_2  TEXT,
    previous_year_value_2 TEXT,
    resolved             INTEGER NOT NULL DEFAULT 0,
    resolved_at          TEXT,
    notes                TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS leads_branch_idx   ON leads (branch);
  CREATE INDEX IF NOT EXISTS leads_resolved_idx ON leads (resolved);
  CREATE INDEX IF NOT EXISTS leads_name_idx     ON leads (name);
  CREATE INDEX IF NOT EXISTS leads_icp_idx      ON leads (icp_score);

  CREATE TRIGGER IF NOT EXISTS leads_updated_at
  AFTER UPDATE ON leads
  FOR EACH ROW
  BEGIN
    UPDATE leads SET updated_at = datetime('now') WHERE org_nr = NEW.org_nr;
  END;

  CREATE TRIGGER IF NOT EXISTS leads_resolved_at
  AFTER UPDATE OF resolved ON leads
  FOR EACH ROW
  BEGIN
    UPDATE leads
    SET resolved_at = CASE WHEN NEW.resolved = 1 THEN datetime('now') ELSE NULL END
    WHERE org_nr = NEW.org_nr;
  END;
`);

// Add new columns to existing DBs that were created before this schema version
const existingCols = (db.pragma('table_info(leads)') as { name: string }[]).map((c) => c.name);
const newCols: [string, string][] = [
  ['branch_segment', 'TEXT'],
  ['sni_code', 'TEXT'],
  ['icp_score', 'REAL'],
  ['icp_reasons', 'TEXT'],
  ['is_ab', 'INTEGER'],
  ['reg_year', 'INTEGER'],
  ['company_age', 'INTEGER'],
  ['employees', 'INTEGER'],
  ['omsattning_sek', 'REAL'],
  ['omsattning_year', 'INTEGER'],
  ['rorelseresultat_sek', 'REAL'],
  ['arets_resultat_sek', 'REAL'],
  ['kortfristiga_skulder_sek', 'REAL'],
  ['langfristiga_skulder_sek', 'REAL'],
];
for (const [col, type] of newCols) {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${type}`);
  }
}

export type Lead = {
  org_nr: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  branch: string | null;
  branch_segment: string | null;
  sni_code: string | null;
  icp_score: number | null;
  icp_reasons: string | null;
  is_ab: number | null;
  reg_year: number | null;
  company_age: number | null;
  employees: number | null;
  omsattning_sek: number | null;
  omsattning_year: number | null;
  rorelseresultat_sek: number | null;
  arets_resultat_sek: number | null;
  kortfristiga_skulder_sek: number | null;
  langfristiga_skulder_sek: number | null;
  lender_keywords: string | null;
  keyword_line_1: string | null;
  recent_year_value: string | null;
  previous_year_value: string | null;
  keyword_line_2: string | null;
  recent_year_value_2: string | null;
  previous_year_value_2: string | null;
  resolved: number;
  resolved_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
