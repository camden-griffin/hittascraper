const fs = require("fs-extra");
const path = require("path");

function pickArgValue(argv, names) {
    const args = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < args.length; i++) {
        const a = (args[i] || "").toString();
        if (names.includes(a)) {
            const next = args[i + 1];
            if (next && !next.toString().startsWith("-")) return next;
        }
        // Allow --input=path
        for (const n of names) {
            if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
        }
    }
    return "";
}

function firstPositional(argv) {
    const args = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < args.length; i++) {
        const a = (args[i] || "").toString();
        if (!a) continue;
        if (a.startsWith("-")) {
            // skip flag and its value
            if (["--input", "-i"].includes(a)) i++;
            continue;
        }
        // If this is a CSV path, it's an input argument, not the mode.
        if (/\.csv$/i.test(a)) continue;
        return a;
    }
    return "";
}

function looksHeaderLike(line) {
    const s = (line || "").toString().trim().toLowerCase();
    if (!s) return false;
    if (/^https?:\/\//.test(s)) return false;
    // any mention of orgnr/name/company indicates headerful
    if (/\borgnr\b/.test(s)) return true;
    if (/\bname\b/.test(s)) return true;
    if (/\bcompany\b/.test(s)) return true;
    return false;
}

function getCsvHeaderColumns(csvPath) {
    const raw = fs.readFileSync(csvPath, "utf8");
    const firstLine = raw.split(/\r?\n/)[0] || "";
    return firstLine
        .split(",")
        .map((c) => c.trim().replace(/^\uFEFF/, ""))
        .filter(Boolean);
}

function hasColumn(cols, name) {
    const target = name.toLowerCase();
    return cols.some((c) => c.toLowerCase() === target);
}

(async () => {
    const argv = process.argv.slice(2);

    let inputArg = pickArgValue(argv, ["--input", "-i"]);
    if (!inputArg) {
        const positionalCsv = argv.find(
            (a) => a && !a.toString().startsWith("-") && /\.csv$/i.test(a),
        );
        if (positionalCsv) inputArg = positionalCsv.toString();
    }
    if (inputArg) process.env.INPUT_CSV = inputArg;

    const mode = (firstPositional(argv) || "online").toLowerCase();

    const config = require("./config");

    // Input CSV checks
    if (!fs.existsSync(config.paths.inputCsv)) {
        console.error(`Missing input CSV: ${config.paths.inputCsv}`);
        process.exit(2);
    }

    const cols = getCsvHeaderColumns(config.paths.inputCsv);
    const firstLine = (
        fs
            .readFileSync(config.paths.inputCsv, "utf8")
            .split(/\r?\n/)
            .find((l) => (l || "").trim().length) || ""
    )
        .toString()
        .replace(/^\uFEFF/, "")
        .trim();

    const headerful = looksHeaderLike(firstLine);
    if (headerful) {
        if (!cols.length) {
            console.error(
                `Input CSV has no header row: ${config.paths.inputCsv}`,
            );
            process.exit(2);
        }

        if (
            !hasColumn(cols, "orgnr") &&
            !hasColumn(cols, "OrgNr") &&
            !hasColumn(cols, "org")
        ) {
            console.error(
                `Input CSV header must include 'orgnr' (or 'OrgNr'/'org'). Found: ${cols.join(", ")}`,
            );
            process.exit(2);
        }

        if (
            !hasColumn(cols, "name") &&
            !hasColumn(cols, "Name") &&
            !hasColumn(cols, "company") &&
            !hasColumn(cols, "Company")
        ) {
            console.error(
                `Input CSV header must include 'name'/'company' (case-insensitive). Found: ${cols.join(", ")}`,
            );
            process.exit(2);
        }
    } else {
        // Headerless format is accepted by the scraper (url, company, orgnr, email)
        // so preflight should not fail hard here.
        const parts = firstLine.split(",");
        if (parts.length < 3) {
            console.error(
                `Input CSV doesn't look like a supported headerless format. First line: ${firstLine}`,
            );
            process.exit(2);
        }
    }

    // Offline build requires JSONL already present
    if (mode === "offline") {
        if (!fs.existsSync(config.paths.financeJsonl)) {
            console.error(
                `Missing finance JSONL: ${config.paths.financeJsonl}\n` +
                    `Run: npm run scrape (or npm run pipeline) to generate it first.`,
            );
            process.exit(3);
        }

        const stat = fs.statSync(config.paths.financeJsonl);
        if (!stat.size) {
            console.error(
                `Finance JSONL is empty: ${config.paths.financeJsonl}\n` +
                    `Run: npm run scrape to populate it.`,
            );
            process.exit(3);
        }
    }

    // Success
    const rel = (p) => path.relative(process.cwd(), p);
    console.log("Preflight OK:");
    console.log("- input:", rel(config.paths.inputCsv));
    if (mode === "offline")
        console.log("- financeJsonl:", rel(config.paths.financeJsonl));
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
