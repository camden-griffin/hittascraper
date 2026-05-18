"""Extract emails from one or more CSV/JSONL files into a text file.

Usage:
    python extract_emails.py                          # default: output/finance_table_data.jsonl -> output/emails.txt
    python extract_emails.py path/to/file.jsonl
    python extract_emails.py path/to/file.csv
    python extract_emails.py file1.jsonl file2.csv -o combined_emails.txt

For CSVs, any column whose name contains "email" (case-insensitive) is used;
if none is found, every cell is scanned with a regex as a fallback.
For JSONL, the top-level "email" field is used; falls back to regex scan of the line.

Output: one email per line, no quotes, UTF-8 (preserves åäö), deduplicated, lowercased.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parent
DEFAULT_SRC = ROOT / "output" / "finance_table_data.jsonl"
DEFAULT_DST = ROOT / "output" / "emails.txt"

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-åäöÅÄÖéÉüÜ]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def normalize(email: str) -> str | None:
    email = email.strip().strip('"\'<>').lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        return None
    return email


def from_jsonl(path: Path) -> Iterable[str]:
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                val = obj.get("email") if isinstance(obj, dict) else None
                if isinstance(val, str) and "@" in val:
                    yield val
                    continue
            except json.JSONDecodeError:
                pass
            for m in EMAIL_RE.findall(line):
                yield m


def from_csv(path: Path) -> Iterable[str]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            return
        email_cols = [i for i, h in enumerate(header) if "email" in h.lower()]
        for row in reader:
            if email_cols:
                for i in email_cols:
                    if i < len(row) and "@" in row[i]:
                        yield row[i]
            else:
                for cell in row:
                    if "@" in cell:
                        for m in EMAIL_RE.findall(cell):
                            yield m


def extract(paths: list[Path], dst: Path) -> tuple[int, int]:
    seen: set[str] = set()
    ordered: list[str] = []
    total_raw = 0

    for path in paths:
        if not path.exists():
            print(f"  ! skipping missing: {path}", file=sys.stderr)
            continue
        suffix = path.suffix.lower()
        if suffix == ".csv":
            source = from_csv(path)
        elif suffix in (".jsonl", ".ndjson", ".json"):
            source = from_jsonl(path)
        else:
            with path.open("r", encoding="utf-8", errors="ignore") as f:
                source = (m for line in f for m in EMAIL_RE.findall(line))

        before = len(ordered)
        for raw in source:
            total_raw += 1
            email = normalize(raw)
            if not email or email in seen:
                continue
            seen.add(email)
            ordered.append(email)
        print(f"  {path.name}: +{len(ordered) - before} new")

    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("w", encoding="utf-8", newline="\n") as f:
        for e in ordered:
            f.write(e + "\n")

    return total_raw, len(ordered)


def main() -> int:
    p = argparse.ArgumentParser(description="Extract emails from CSV/JSONL files.")
    p.add_argument("inputs", nargs="*", help="Input files (CSV or JSONL). Defaults to output/finance_table_data.jsonl")
    p.add_argument("-o", "--output", default=str(DEFAULT_DST), help=f"Output txt path (default: {DEFAULT_DST})")
    args = p.parse_args()

    paths = [Path(s) for s in args.inputs] if args.inputs else [DEFAULT_SRC]
    dst = Path(args.output)

    print(f"Extracting from {len(paths)} file(s):")
    raw, unique = extract(paths, dst)
    print(f"Saw {raw} email-like values; wrote {unique} unique emails to {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
