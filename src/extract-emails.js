#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const input = args[0] || path.join(__dirname, '..', 'output', 'finance_table_data.jsonl');
const output = args[1] || path.join(__dirname, '..', 'output', 'emails.txt');

const text = fs.readFileSync(input, 'utf8');
const seen = new Set();
let parsed = 0;
let skipped = 0;

for (const line of text.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const obj = JSON.parse(trimmed);
    parsed++;
    const email = obj.email;
    if (typeof email === 'string' && email.includes('@')) {
      seen.add(email.trim().toLowerCase());
    }
  } catch {
    skipped++;
  }
}

const emails = [...seen].sort();
fs.writeFileSync(output, emails.join('\n') + '\n', 'utf8');

console.log(`Parsed ${parsed} records (${skipped} skipped).`);
console.log(`Wrote ${emails.length} unique emails to ${output}`);
