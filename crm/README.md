# Hittascraper CRM

Minimal CRM to browse, filter, sort, and resolve leads. No external services — SQLite database stored as a local file, Express API, Vite+React frontend, JWT auth.

## Stack

| Layer | Tech |
|---|---|
| DB | SQLite via better-sqlite3 |
| API | Express + JWT |
| Frontend | Vite + React + TanStack Table + Tailwind |

## Setup

### 1. Install deps

```bash
cd crm
npm install
```

### 2. Configure env

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```
JWT_SECRET=<long random string>
DEFAULT_EMAIL=yourteam@example.com
DEFAULT_PASSWORD=yourpassword
```

Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

The `DEFAULT_EMAIL` / `DEFAULT_PASSWORD` user is created automatically on first server start if the users table is empty. After that, changing these values in `.env` has no effect — the user already exists.

### 3. Import the CSV

```bash
npm run import-csv
# or point to a different file:
npm run import-csv -- ../output2/financial_data_wide_1year.csv
```

Safe to rerun — upserts by `OrgNr`. Existing `branch`, `resolved`, and `notes` values are preserved.

### 4. Run it

```bash
npm run dev
```

Opens the Vite dev server (default http://localhost:5173). API runs on port 3001. Sign in with the credentials you set in `.env`.

## Features

- **Sort** any column — click the header (click again to reverse, third click clears)
- **Filter by branch** — dropdown, populated from values you've typed in
- **Global search** — name, org nr, email, phone, keywords
- **Hide resolved** — checkbox toggle above the table
- **Mark resolved** — checkbox in the first column (auto-stamps resolved_at in the DB)
- **Edit branch / notes** — click any cell in those columns, type, then Tab / Enter / click away to save. Escape cancels.
- Resolved rows are greyed out

## Production build

```bash
npm run build        # builds frontend into dist/
node server/index.js # serves API + static files on port 3001
```

Set `PORT=80` (or whatever) in `.env` for production. One process, one port.

## Data

The SQLite file lives at `data/crm.db` (gitignored). Back it up by copying that file.

## Adding columns

1. Add the column to the `CREATE TABLE` statement in [server/db.ts](server/db.ts) and run an `ALTER TABLE` against your existing `data/crm.db` if you already have data.
2. Add the field to the `Lead` type in both [server/db.ts](server/db.ts) and [src/lib/api.ts](src/lib/api.ts).
3. Add the field to the `allowed` array in the `PATCH /api/leads/:org_nr` handler in [server/index.ts](server/index.ts).
4. Add a `col.accessor(...)` entry in [src/components/LeadsTable.tsx](src/components/LeadsTable.tsx).
