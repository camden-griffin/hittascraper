import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { db, type Lead } from './db.js';
import { checkPassword, requireAuth, seedDefaultUser, signToken } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(compression());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json());

seedDefaultUser();

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: 'email and password required' });
    return;
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
    | { id: number; email: string; password: string }
    | undefined;
  if (!user || !checkPassword(password, user.password)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  res.json({ token: signToken(user.id, user.email), email: user.email });
});

app.post('/api/logout', (_req, res) => {
  // Tokens are stateless — client just drops it. Endpoint exists for symmetry.
  res.json({ ok: true });
});

// ── Leads ─────────────────────────────────────────────────────────────────────

app.get('/api/leads', requireAuth, (_req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY name ASC').all() as Lead[];
  res.json(leads);
});

app.patch('/api/leads/:org_nr', requireAuth, (req, res) => {
  const { org_nr } = req.params;
  const allowed = [
    'name', 'email', 'phone', 'branch', 'branch_segment', 'sni_code',
    'icp_score', 'icp_reasons', 'is_ab', 'reg_year', 'company_age', 'employees',
    'omsattning_sek', 'omsattning_year', 'rorelseresultat_sek', 'arets_resultat_sek',
    'kortfristiga_skulder_sek', 'langfristiga_skulder_sek',
    'lender_keywords', 'keyword_line_1', 'recent_year_value', 'previous_year_value',
    'keyword_line_2', 'recent_year_value_2', 'previous_year_value_2',
    'resolved', 'notes',
  ] as const;

  const patch = req.body as Partial<Lead>;
  const fields = (Object.keys(patch) as string[]).filter((k) => (allowed as readonly string[]).includes(k));
  if (fields.length === 0) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }

  const sets = fields.map((f) => `${f} = ?`).join(', ');
  const values = fields.map((f) => (patch as any)[f]);
  db.prepare(`UPDATE leads SET ${sets} WHERE org_nr = ?`).run(...values, org_nr);

  const updated = db.prepare('SELECT * FROM leads WHERE org_nr = ?').get(org_nr) as Lead;
  if (!updated) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  res.json(updated);
});

// ── Branches (distinct values for the filter dropdown) ───────────────────────

app.get('/api/branches', requireAuth, (_req, res) => {
  const rows = db
    .prepare("SELECT DISTINCT branch FROM leads WHERE branch IS NOT NULL AND branch != '' ORDER BY branch ASC")
    .all() as { branch: string }[];
  res.json(rows.map((r) => r.branch));
});

// ── Serve built frontend in production ───────────────────────────────────────

const distDir = resolve(__dirname, '../dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(resolve(distDir, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
});
