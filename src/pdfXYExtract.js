function normalizeText(s) {
    return (s || "")
        .toString()
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function looksNumericToken(s) {
    const t = normalizeText(s);
    if (!t) return false;
    if (!/\d/.test(t)) return false;
    return /^[+\-]?\d[\d .,:-]*$/.test(t);
}

function cleanNumberText(s) {
    return normalizeText(s)
        .replace(/[.,](?=\d{3}(?:\D|$))/g, " ")
        .replace(/[ ]+/g, " ");
}

function splitGroupedNumberRun(run, preferredCount) {
    const cleaned = normalizeText(run);
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
                dp[j] = {
                    cost: nextCost,
                    parts: [...dp[i].parts, [i, j]],
                };
            }
        }
    }

    const best = dp[n];
    if (!best || !best.parts || !best.parts.length) return [cleaned];
    return best.parts.map(([a, b]) => workingTokens.slice(a, b).join(" "));
}

function extractNumbersFromText(text, preferredCount) {
    const s = cleanNumberText(text).replace(/[−–—]/g, "-");
    const re = /[+-]?\d[\d ]*/g;
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
        const run = normalizeText(m[0]);
        if (!run) continue;
        const parts = splitGroupedNumberRun(run, preferredCount || 0);
        for (const p of parts) {
            const v = normalizeText(p);
            if (v) out.push(v);
        }
    }
    return out;
}

function clusterRows(tokens) {
    if (!tokens.length) return [];
    const sorted = [...tokens].sort((a, b) => b.y - a.y);
    const heights = sorted
        .map((t) => t.h)
        .filter((h) => Number.isFinite(h) && h > 0);
    const medianH = heights.length
        ? heights.slice().sort((a, b) => a - b)[Math.floor(heights.length / 2)]
        : 8;
    const yTol = Math.max(2.5, Math.min(10, medianH * 0.6));

    const rows = [];
    for (const t of sorted) {
        let best = null;
        let bestDy = Number.POSITIVE_INFINITY;
        for (const r of rows) {
            const dy = Math.abs(r.y - t.y);
            if (dy <= yTol && dy < bestDy) {
                best = r;
                bestDy = dy;
            }
        }
        if (!best) {
            rows.push({ y: t.y, tokens: [t] });
        } else {
            best.tokens.push(t);
            best.y = (best.y + t.y) / 2;
        }
    }

    for (const r of rows) {
        r.tokens.sort((a, b) => a.x - b.x);
        r.text = normalizeText(r.tokens.map((t) => t.text).join(" "));
    }
    rows.sort((a, b) => b.y - a.y);
    return rows;
}

function extractValuesByX(tokens, preferredCount) {
    let nums = tokens.filter((t) => looksNumericToken(t.text));
    if (!nums.length) return [];

    // Strip lone small-integer note-reference tokens (1–99) that appear to the
    // left of the value columns in Swedish annual reports ("Not" column).
    // Detect: a numeric token is a note ref if it's a 1-2 digit integer AND
    // there is at least one other numeric token significantly to its right (>60pt gap).
    if (nums.length > 1 && preferredCount > 0) {
        const sorted = nums.slice().sort((a, b) => a.x - b.x);
        const leftmost = sorted[0];
        const second = sorted[1];
        const gap = second.x - (leftmost.x + (leftmost.w || 0));
        if (gap > 60 && /^\d{1,2}$/.test(leftmost.text.trim())) {
            nums = nums.filter((t) => t !== leftmost);
        }
    }

    if (nums.length === 1) {
        return extractNumbersFromText(nums[0].text, preferredCount || 0);
    }

    // If a single numeric token seems to contain both years/columns, prefer splitting it directly.
    const directPairs = nums
        .map((t) => extractNumbersFromText(t.text, preferredCount || 0))
        .filter((arr) => arr.length === preferredCount);
    if (preferredCount > 0 && directPairs.length) {
        directPairs.sort((a, b) =>
            a.join("").length > b.join("").length ? -1 : 1,
        );
        return directPairs[0];
    }

    // Column-anchor strategy: derive right-most anchors and assign numeric tokens by nearest X.
    const centers = nums
        .map((t) => ({ x: t.x + (t.w || 0) / 2 }))
        .sort((a, b) => a.x - b.x);

    const clustered = [];
    const tol = 28;
    for (const c of centers) {
        const last = clustered[clustered.length - 1];
        if (!last || Math.abs(c.x - last.mean) > tol) {
            clustered.push({ mean: c.x, count: 1 });
        } else {
            last.mean = (last.mean * last.count + c.x) / (last.count + 1);
            last.count += 1;
        }
    }

    const anchorCount = Math.max(1, preferredCount || 2);
    const anchors = clustered
        .sort((a, b) => a.mean - b.mean)
        .slice(-anchorCount)
        .map((c) => c.mean)
        .sort((a, b) => a - b);

    const buckets = anchors.map(() => []);
    for (const t of nums) {
        const cx = t.x + (t.w || 0) / 2;
        let bestIdx = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < anchors.length; i++) {
            const d = Math.abs(cx - anchors[i]);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        buckets[bestIdx].push(t);
    }

    const bucketValues = buckets.map((bucket) => {
        if (!bucket.length) return "";
        bucket.sort((a, b) => a.x - b.x);
        const text = normalizeText(bucket.map((t) => t.text).join(" "));
        const n = extractNumbersFromText(text, 1);
        return n[0] || "";
    });

    const nonEmpty = bucketValues.filter(Boolean);
    if (preferredCount > 0 && nonEmpty.length === preferredCount) {
        return nonEmpty;
    }

    const gaps = [];
    for (let i = 0; i < nums.length - 1; i++) {
        const currRight = nums[i].x + (nums[i].w || 0);
        const gap = nums[i + 1].x - currRight;
        if (Number.isFinite(gap)) gaps.push(gap);
    }
    const sortedG = gaps.slice().sort((a, b) => a - b);
    const medianGap = sortedG.length
        ? sortedG[Math.floor(sortedG.length / 2)]
        : 0;
    const splitGap = Math.max(8, medianGap * 1.8);

    const groups = [];
    let cur = [nums[0]];
    for (let i = 1; i < nums.length; i++) {
        const prev = nums[i - 1];
        const next = nums[i];
        const gap = next.x - (prev.x + (prev.w || 0));
        if (gap > splitGap) {
            groups.push(cur);
            cur = [next];
        } else {
            cur.push(next);
        }
    }
    groups.push(cur);

    const values = [];
    for (const g of groups) {
        const text = normalizeText(g.map((t) => t.text).join(" "));
        const n = extractNumbersFromText(text, 1);
        if (n.length) values.push(n[0]);
    }

    if (preferredCount > 0 && values.length === 1) {
        const repair = extractNumbersFromText(values[0], preferredCount);
        if (repair.length === preferredCount) return repair;
    }

    // Final fallback from full row numeric text.
    const rowTextNums = extractNumbersFromText(
        normalizeText(nums.map((t) => t.text).join(" ")),
        preferredCount || 0,
    );
    if (preferredCount > 0 && rowTextNums.length >= preferredCount) {
        return rowTextNums.slice(0, preferredCount);
    }

    return values.length ? values : rowTextNums;
}

function lineWithoutNumbers(tokens) {
    const parts = tokens
        .filter((t) => !looksNumericToken(t.text))
        .map((t) => t.text);
    const cleaned = normalizeText(parts.join(" "));
    const dup = cleaned.match(/^(.{4,}?)\1$/u);
    if (dup && dup[1]) return dup[1].trim();
    return cleaned;
}

async function getPdfJsLib() {
    try {
        return await import("pdfjs-dist/legacy/build/pdf.mjs");
    } catch {
        return await import("pdfjs-dist/build/pdf.mjs");
    }
}

async function extractMatchedLinesFromPdfBufferXY(pdfBuffer, matchers, opts) {
    const options = opts || {};
    const maxLinesPerKey = Number(options.maxLinesPerKey || 10);
    const maxTotalLines = Number(options.maxTotalLines || 60);
    const maxPages = Math.max(1, Number(options.maxPages || 12));
    const preferredCount = Number(options.preferredCount || 2);

    if (!pdfBuffer || !matchers || !matchers.length) return [];

    const pdfjs = await getPdfJsLib();
    const task = pdfjs.getDocument({
        data: new Uint8Array(pdfBuffer),
        useWorkerFetch: false,
        isEvalSupported: false,
        useSystemFonts: true,
    });
    const doc = await task.promise;

    const out = [];
    const counts = new Map();
    const seen = new Set();
    let globalLine = 0;

    const pageCount = Math.min(doc.numPages, maxPages);
    for (let p = 1; p <= pageCount; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent({
            disableCombineTextItems: false,
            includeMarkedContent: false,
        });

        const tokens = [];
        for (const it of tc.items || []) {
            const text = normalizeText(it.str || "");
            if (!text) continue;
            const tr = Array.isArray(it.transform)
                ? it.transform
                : [1, 0, 0, 1, 0, 0];
            const x = Number(tr[4] || 0);
            const y = Number(tr[5] || 0);
            const w = Number(it.width || 0);
            const h = Number(it.height || Math.abs(tr[3] || 0) || 8);
            tokens.push({ text, x, y, w, h });
        }

        const rows = clusterRows(tokens);
        for (const row of rows) {
            globalLine++;
            const rowText = row.text || "";
            if (!rowText) continue;

            for (const m of matchers) {
                const key = (m.keyword || m.key || "").toString();
                if (!key || !m.re || !m.re.test(rowText)) continue;

                const cnt = counts.get(key) || 0;
                if (cnt >= maxLinesPerKey) continue;

                const values = extractValuesByX(row.tokens, preferredCount);
                const line = lineWithoutNumbers(row.tokens) || rowText;
                const dedupeKey = `${key}|${line}|${values.join("|")}`;
                if (seen.has(dedupeKey)) continue;

                out.push({
                    key,
                    line,
                    lineIndex: globalLine,
                    values,
                    source: "PDF_XY",
                });
                seen.add(dedupeKey);
                counts.set(key, cnt + 1);

                if (out.length >= maxTotalLines) {
                    try {
                        await doc.destroy();
                    } catch {}
                    return out;
                }
            }
        }
    }

    try {
        await doc.destroy();
    } catch {}
    return out;
}

module.exports = {
    extractMatchedLinesFromPdfBufferXY,
};
