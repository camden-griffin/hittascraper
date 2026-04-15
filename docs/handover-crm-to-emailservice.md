# Handover: Move CRM to `emailservice` project

You are helping move a working CRM system from a subdirectory into a standalone project called `emailservice`. Copy the contents of the `crm/` folder into the new project root. Everything below describes the system as-is.

---

## What it is

A minimal internal CRM for reviewing sales leads. It has:
- A React + TypeScript frontend (Vite, Tailwind, TanStack Table)
- An Express API server (TypeScript, port 3001)
- A SQLite database (`data/crm.db`, managed by better-sqlite3)
- JWT authentication (shared login — multiple people use one account)
- A CSV import script to load lead data

---

## File structure

```
emailservice/
├── server/
│   ├── index.ts        — Express API (routes: /api/login, /api/leads, /api/branches)
│   ├── auth.ts         — JWT sign/verify, bcrypt, requireAuth middleware, seedDefaultUser
│   └── db.ts           — SQLite schema, migration block, Lead type export
├── scripts/
│   └── import-csv.ts   — Imports output/financial_data_atomic.csv into crm.db
├── src/
│   ├── App.tsx         — Root component, holds useAuth() state, passes props down
│   ├── main.tsx
│   ├── index.css       — html/body/#root { height: 100%; overflow: hidden }
│   ├── components/
│   │   ├── LeadsTable.tsx   — Main table view (sorting, filtering, pagination, inline edit)
│   │   └── Login.tsx        — Login form
│   ├── hooks/
│   │   └── useAuth.ts       — Auth state (loggedIn, login, logout)
│   └── lib/
│       └── api.ts           — fetch wrapper + Lead type + api object
├── data/               — Created automatically; holds crm.db (gitignored)
├── .env                — JWT_SECRET, DEFAULT_EMAIL, DEFAULT_PASSWORD
├── .env.example
├── vite.config.ts      — Proxies /api → http://localhost:3001
├── tailwind.config.js
├── postcss.config.js
├── tsconfig.json
├── index.html
└── package.json
```

---

## Key technical details

**Auth flow**
- `seedDefaultUser()` runs on server start — creates a user from `DEFAULT_EMAIL`/`DEFAULT_PASSWORD` env vars if the `users` table is empty
- Login returns a JWT (7d expiry), stored in `localStorage` under key `crm_token`
- `requireAuth` middleware reads `Authorization: Bearer <token>` on all `/api/leads` and `/api/branches` routes
- On 401 the frontend clears the token and reloads

**Database**
- `db.ts` runs `CREATE TABLE IF NOT EXISTS` on startup, then an `ALTER TABLE` migration loop to add any columns missing from older DBs
- The `leads` table has `updated_at` and `resolved_at` triggers
- `import-csv.ts` does a dual parse of the CSV: named columns for most fields, positional for the two duplicate `Recent_Year_Value` / `Previous_Year_Value` column pairs

**Frontend table**
- `useAuth()` is called once in `App.tsx` — auth state is passed as props to `Login` and `LeadsTable` (not called again in child components)
- TanStack Table v8 with 100 rows/page pagination, client-side sort/filter
- `EditableCell` component: `<input>` by default, `<textarea>` when `multiline` prop is set (used for Branch)
- Resolved rows shown at `opacity-50`
- Revenue formatted as `4,9 Mkr` / `123 tkr` / `kr`
- Debt values formatted with `sv-SE` locale + ` kr` suffix

---

## Environment variables (`.env`)

```
JWT_SECRET=<long random string>
DEFAULT_EMAIL=admin@crm.local
DEFAULT_PASSWORD=changeme
```

Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts Express server (tsx watch) + Vite dev server concurrently |
| `npm run import-csv` | Imports `../output/financial_data_atomic.csv` into `data/crm.db` |
| `npm run import-csv -- /path/to/file.csv` | Import a specific CSV |
| `npm run build` | TypeScript check + Vite build to `dist/` |
| `npm start` | Run compiled server (serves `dist/` as static files) |

---

## First-time setup

```powershell
npm install
cp .env.example .env   # then edit .env with real values
npm run dev
# In a separate terminal once you have a CSV:
npm run import-csv -- ../output/financial_data_atomic.csv
```

---

## Lead data shape (`Lead` type)

The main fields visible in the table:

| Field | Description |
|---|---|
| `org_nr` | Swedish org number (primary key) |
| `name` | Company name |
| `email` / `phone` | Contact info |
| `branch` | Industry branch (editable inline) |
| `icp_score` | ICP fit score (colored badge: green ≥10, blue ≥7, grey otherwise) |
| `employees` | Headcount |
| `omsattning_sek` | Revenue in SEK |
| `keyword_line_1/2` | Debt type label from PDF |
| `recent_year_value` / `previous_year_value` | Debt amounts (×2 for two debt lines) |
| `resolved` | 0/1 checkbox — marks lead as handled |
| `notes` | Free-text notes (editable inline) |
