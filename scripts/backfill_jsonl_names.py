#!/usr/bin/env python3
"""Backfill empty `name` fields in finance_table_data.jsonl from candidate CSVs.

The scraper used to drop the company name when the input column was named
`company_name`/`legal_name` (now fixed in src/scraper.js), leaving rows with
"name":"" in the JSONL. This fills those names in place by matching orgnr
(dash-stripped), using the candidate CSVs as the source of truth.

Usage:
  python scripts/backfill_jsonl_names.py [jsonl_path]
Default jsonl_path = output/finance_table_data.jsonl

Writes a one-time .bak alongside the JSONL before modifying it. Re-runnable.
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

JSONL = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "output" / "finance_table_data.jsonl"

# Source CSVs in priority order: track2_final first, then broader fallbacks.
# An orgnr's name is taken from the first CSV that has a non-empty name for it.
CSV_SOURCES = [
    ROOT / "input" / "candidates_track2_final.csv",
    ROOT / "input" / "candidates_track2_resolved.csv",
    ROOT / "input" / "candidates_new_resolved.csv",
    ROOT / "input" / "candidates_track2.csv",
    ROOT / "input" / "candidates_new.csv",
    ROOT / "input" / "candidates.csv",
]

NAME_FIELDS = ("company_name", "legal_name", "name", "company", "Company", "Name")
ORG_FIELDS = ("orgnr", "OrgNr", "org")


def norm_org(raw):
    return re.sub(r"\D", "", (raw or "").strip())


def pick(row, fields):
    for f in fields:
        v = (row.get(f) or "").strip()
        if v:
            return v
    return ""


# Build orgnr -> name, first non-empty wins (CSV priority order).
names = {}
for path in CSV_SOURCES:
    if not path.exists():
        continue
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            org = norm_org(pick(row, ORG_FIELDS))
            if not org or org in names:
                continue
            name = pick(row, NAME_FIELDS)
            if name:
                names[org] = name

print(f"Loaded {len(names)} orgnr->name pairs from {sum(p.exists() for p in CSV_SOURCES)} CSV(s)")

if not JSONL.exists():
    print(f"! JSONL not found: {JSONL}")
    sys.exit(1)

lines = JSONL.read_text(encoding="utf-8").split("\n")

filled = 0
empty_no_match = 0
out_lines = []
for line in lines:
    if not line.strip():
        out_lines.append(line)
        continue
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        out_lines.append(line)
        continue

    if isinstance(obj, dict) and not (obj.get("name") or "").strip():
        org = norm_org(obj.get("org"))
        name = names.get(org)
        if name:
            obj["name"] = name
            filled += 1
            out_lines.append(json.dumps(obj, ensure_ascii=False))
            continue
        else:
            empty_no_match += 1
    out_lines.append(line)

if filled:
    bak = JSONL.with_suffix(JSONL.suffix + ".bak")
    if not bak.exists():
        bak.write_text("\n".join(lines), encoding="utf-8")
        print(f"Backup written: {bak}")
    JSONL.write_text("\n".join(out_lines), encoding="utf-8")

print(f"Filled name on {filled} rows")
print(f"Still-empty names with no CSV match: {empty_no_match}")
print(f"Wrote {JSONL}" if filled else "No changes needed")
