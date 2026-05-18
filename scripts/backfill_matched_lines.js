const fs = require("fs");
const config = require("../src/config");

function splitGroupedNumberRun(run, preferredCount) {
  const cleaned = (run || "").replace(/[\u00A0\s]+/g, " ").trim();
  if (!cleaned) return [];
  const tokens = cleaned.split(" ").filter(Boolean);
  if (!tokens.length) return [];
  if (tokens.length === 1) return [cleaned];

  const stripSign = (s) => s.replace(/^[+-]/, "");

  const expandMergedDigitToken = (token) => {
    const t = (token || "").toString();
    const sign = t.startsWith("-") || t.startsWith("+") ? t[0] : "";
    const d = stripSign(t);
    if (!/^\d+$/.test(d)) return [t];
    if (d.length <= 3) return [t];
    if (d.length === 4 && /^20\d{2}$/.test(d)) return [t];
    if (d.length === 4) return [`${sign}${d.slice(0, 3)}`, d.slice(3)];
    if (d.length === 5) return [`${sign}${d.slice(0, 2)}`, d.slice(2)];
    if (d.length === 6) return [`${sign}${d.slice(0, 3)}`, d.slice(3)];
    return [t];
  };

  // OCR repair heuristic for merged 2-year pairs, e.g. "9 1330" -> ["9133", "0"].
  if (preferredCount === 2 && tokens.length === 2) {
    const a = stripSign(tokens[0] || "");
    const b = stripSign(tokens[1] || "");
    if (/^\d{1,3}$/.test(a) && /^\d{4,6}$/.test(b)) {
      const left = `${a}${b.slice(0, 3)}`;
      const right = b.slice(3);
      if (left && right) return [left, right];
    }
  }

  const workingTokens = [];
  for (const token of tokens) {
    const expanded =
      preferredCount > 0 ? expandMergedDigitToken(token) : [token];
    for (const p of expanded) {
      if (p) workingTokens.push(p);
    }
  }

  if (!workingTokens.length) return [];

  if (workingTokens.some((t) => !/^[+-]?\d+$/.test(t))) return [cleaned];
  if (workingTokens.some((t) => t.replace(/^[+-]/, "").length > 3)) {
    return workingTokens;
  }
  const segCost = (start, len) => {
    let cost = 0;
    if (len === 1) cost += 1.2;
    else if (len === 2) cost += 0;
    else if (len === 3) cost += 0.1;
    else if (len === 4) cost += 0.6;
    else cost += 2 + (len - 4) * 1.5;

    const first = stripSign(workingTokens[start] || "");
    if (!/^\d{1,3}$/.test(first)) cost += 4;
    if (/^0\d+$/.test(first) || first === "000") cost += 2;
    for (let i = 1; i < len; i++) {
      const part = stripSign(workingTokens[start + i] || "");
      if (!/^\d{3}$/.test(part)) cost += 4;
    }
    return cost;
  };

  const n = workingTokens.length;
  const dp = Array.from({ length: n + 1 }, () => null);
  dp[0] = { cost: 0, parts: [] };
  for (let i = 0; i < n; i++) {
    if (!dp[i]) continue;
    for (const len of [2, 3, 1, 4]) {
      const j = i + len;
      if (j > n) continue;
      const nextParts = dp[i].parts.length + 1;
      let nextCost = dp[i].cost + segCost(i, len);
      if (preferredCount > 0) {
        nextCost += Math.abs(nextParts - preferredCount) * 0.15;
      }
      if (!dp[j] || nextCost < dp[j].cost) {
        dp[j] = { cost: nextCost, parts: [...dp[i].parts, [i, j]] };
      }
    }
  }

  const best = dp[n];
  if (!best || !best.parts || !best.parts.length) return [cleaned];
  return best.parts.map(([a, b]) => workingTokens.slice(a, b).join(" "));
}

function extractNumbersFromLine(line, preferredCount = 2) {
  if (!line) return [];
  const s = line
    .toString()
    .replace(/[\u00A0]+/g, " ")
    .replace(/[−–—]/g, "-")
    .replace(/[\t]+/g, " ");

  const re = /[+-]?\d[\d ]*/g;
  const matches = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const run = (m[0] || "").replace(/[ ]+/g, " ").trim();
    if (!run) continue;
    const parts = splitGroupedNumberRun(run, preferredCount);
    for (const p of parts) {
      const v = (p || "").replace(/[ ]+/g, " ").trim();
      if (v) matches.push(v);
    }
  }
  return matches;
}

function stripNumbersFromLine(line) {
  if (!line) return "";
  const s = line
    .toString()
    .replace(/[\u00A0]+/g, " ")
    .replace(/[−–—]/g, "-")
    .replace(/[+-]?\d[\d ]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = s.replace(/[,:;\-]+$/g, "").trim();
  const dup = cleaned.match(/^(.{4,}?)\1$/u);
  if (dup && dup[1]) return dup[1].trim();
  return cleaned;
}

function normalizeMatchedArray(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr.map((it) => {
    if (!it || typeof it !== "object") return it;
    const rawLine = (it.line || "").toString();
    const lineHasDigits = /\d/.test(rawLine);
    let values = [];
    if (lineHasDigits) {
      values = extractNumbersFromLine(rawLine, 2);
    } else if (Array.isArray(it.values)) {
      const existing = it.values
        .map((v) => (v || "").toString().replace(/\s+/g, " ").trim())
        .filter((v) => v.length > 0);

      const looksCleanPair =
        existing.length === 2 &&
        existing.every((v) => /^[-+]?\d+(?: \d{3})*$/.test(v));

      if (looksCleanPair) {
        values = existing;
      } else {
        const repaired = extractNumbersFromLine(existing.join(" "), 2);
        values = repaired.length === 2 ? repaired : existing;
      }
    }
    const line = stripNumbersFromLine(rawLine) || rawLine;
    return { ...it, line, values };
  });
}

const fp = config.paths.financeJsonl;
if (!fs.existsSync(fp)) {
  console.error(`File not found: ${fp}`);
  process.exit(1);
}

const raw = fs.readFileSync(fp, "utf8");
const lines = raw.split(/\r?\n/).filter(Boolean);
const out = [];
let updated = 0;

for (const line of lines) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    out.push(line);
    continue;
  }

  const beforeA = JSON.stringify(obj.lenderKeywordLines || []);
  const beforeB = JSON.stringify(obj.loanLines || []);

  obj.lenderKeywordLines = normalizeMatchedArray(obj.lenderKeywordLines || []);
  obj.loanLines = normalizeMatchedArray(obj.loanLines || []);

  const afterA = JSON.stringify(obj.lenderKeywordLines || []);
  const afterB = JSON.stringify(obj.loanLines || []);
  if (beforeA !== afterA || beforeB !== afterB) updated++;

  out.push(JSON.stringify(obj));
}

const backup = `${fp}.bak`;
fs.writeFileSync(backup, raw, "utf8");
fs.writeFileSync(fp, `${out.join("\n")}\n`, "utf8");

console.log(`Backfill complete. Updated records: ${updated}`);
console.log(`Backup written: ${backup}`);
