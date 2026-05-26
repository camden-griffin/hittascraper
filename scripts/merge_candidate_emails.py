#!/usr/bin/env python3
"""Merge scraped emails/phones into the candidate CSV.

Keeps every candidate row from the input CSV and fills `email`/`phone` from all
available scrape sources (jsonl + contacts.csv), keyed by orgnr (dash-stripped).

Usage:
  python scripts/merge_candidate_emails.py [input_csv] [output_csv]
Defaults:
  input  = input/candidates_new_resolved.csv
  output = output/candidates_new_with_emails.csv
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

INPUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "input" / "candidates_new_resolved.csv"
OUTPUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "output" / "candidates_new_with_emails.csv"

JSONL_SOURCES = [
    ROOT / "output" / "finance_table_data.jsonl",
    ROOT / "output3" / "finance_table_data.jsonl",
]
CONTACTS_SOURCES = [
    ROOT / "output" / "contacts.csv",
    ROOT / "output3" / "contacts.csv",
]

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def norm_org(raw):
    return re.sub(r"\D", "", (raw or "").strip())


def valid_email(e):
    e = (e or "").strip()
    return e if EMAIL_RE.match(e) else ""


# orgnr -> {"email": str, "phone": str}
scraped = {}


def record(org, email, phone):
    org = norm_org(org)
    if not org:
        return
    slot = scraped.setdefault(org, {"email": "", "phone": ""})
    email = valid_email(email)
    if email and not slot["email"]:
        slot["email"] = email
    phone = (phone or "").strip()
    if phone and not slot["phone"]:
        slot["phone"] = phone


for path in JSONL_SOURCES:
    if not path.exists():
        continue
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            record(obj.get("org"), obj.get("email"), obj.get("phone"))

for path in CONTACTS_SOURCES:
    if not path.exists():
        continue
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            record(row.get("OrgNr"), row.get("Email"), row.get("Phone"))

# Merge into candidates, preserving all original columns + rows.
with open(INPUT, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    fieldnames = list(reader.fieldnames)
    rows = list(reader)

# Email column: reuse email_from_allabolag if present, else add `email`.
email_col = "email_from_allabolag" if "email_from_allabolag" in fieldnames else "email"
if email_col not in fieldnames:
    fieldnames.append(email_col)
if "phone" not in fieldnames:
    fieldnames.append("phone")

filled_email = 0
filled_phone = 0
total = 0
with_email = 0
for row in rows:
    total += 1
    org = norm_org(row.get("orgnr") or row.get("OrgNr"))
    s = scraped.get(org)
    if s:
        if s["email"] and not valid_email(row.get(email_col)):
            row[email_col] = s["email"]
            filled_email += 1
        if s["phone"] and not (row.get("phone") or "").strip():
            row["phone"] = s["phone"]
            filled_phone += 1
    if valid_email(row.get(email_col)):
        with_email += 1

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with open(OUTPUT, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)

print(f"Candidates: {total}")
print(f"Scrape sources covered {len(scraped)} distinct orgnrs")
print(f"Filled email on {filled_email} rows, phone on {filled_phone} rows")
print(f"Candidates with a valid email in output: {with_email} ({100*with_email/total:.1f}%)")
print(f"Wrote {OUTPUT}")
