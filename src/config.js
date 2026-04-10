// config.js
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "output");

function resolveMaybeRelativePath(rootDir, maybePath) {
    const p = (maybePath || "").toString().trim();
    if (!p) return "";
    const lower = p.toLowerCase();
    // npm can set unknown flags as npm_config_*="true".
    // Treat those as unset so we don't try to open a file named "true".
    if (lower === "true" || lower === "false") return "";

    // If it's not obviously a path or a CSV file, ignore it.
    const looksPathLike = /[\\/]/.test(p) || /\./.test(p) || /\.csv$/i.test(p);
    if (!looksPathLike) return "";
    return path.isAbsolute(p) ? p : path.join(rootDir, p);
}

module.exports = {
    paths: {
        inputCsv:
            resolveMaybeRelativePath(
                ROOT,
                process.env.INPUT_CSV ||
                    process.env.npm_config_input_csv ||
                    process.env.npm_config_input,
            ) || path.join(ROOT, "input", "input.csv"),
        outputDir: OUTPUT,
        pdfDir: path.join(OUTPUT, "PDFs"),
        outputCsv: path.join(OUTPUT, "financial_data_atomic.csv"),
        contactsCsv: path.join(OUTPUT, "contacts.csv"),
        financeJsonl: path.join(OUTPUT, "finance_table_data.jsonl"),
        wideReportCsv: path.join(OUTPUT, "wide_report.csv"),
    },

    sources: {
        HTML_TABLE: 40,
        PDF_TEXT: 25,
        OCR: 10,
    },

    labelMap: [
        {
            pattern: /^kortfristiga skulder/i,
            label: "Summa Kortfristiga Skulder",
        },
        {
            pattern: /^långfristiga skulder/i,
            label: "Summa Långfristiga Skulder",
        },
        {
            pattern: /^(nettoomsättning|omsättning|rörelsens intäkter)/i,
            label: "Omsättning",
        },
        {
            pattern: /^rörelseresultat/i,
            label: "Rörelseresultat",
        },
        {
            pattern: /^(årets resultat|resultat efter skatt)/i,
            label: "Årets Resultat",
        },
        {
            pattern: /^balansomslutning|^summa tillgångar/i,
            label: "Balansomslutning",
        },
    ],

    multiplier: 1000,
    ocrThresholdChars: 120,
    maxPdfPagesForOcr: 10,
    sanityLimit: 5_000_000_000,

    // Keywords to search for inside PDF text extractions (case-insensitive).
    // Used to flag potential credit providers / lenders mentioned in notes.
    pdfLenderKeywords: [
        "Kreditinstitut",
        "Qred",
        "Froda",
        "CapitalBox",
        "Capital Box",
        "Svea",
        "OPR",
        "Capcito",
        "Almi",
        "Nordea Finans",
        "Handelsbanken Finans",
        "SEB Finans",
        "Swedbank Finans",
        "Resurs Bank",
        "Marginalen",
        "Collector",
        "DBT",
        "Treyd",
        "Corpia",
        "Fakturino",
    ],

    // Ideal Customer Profile — Brifin
    // Used by the processor to score and flag leads.
    icp: {
        revenueMinSEK: 3_000_000,
        revenueMaxSEK: 8_000_000,
        revenueSoftMaxSEK: 15_000_000,
        employeesMin: 2,
        employeesMax: 4,
        employeesSoftMax: 10,
        minCompanyAgeYears: 8,
        preferredCompanyAgeYears: 10,
        coreBranchPatterns: [
            /\bbygg/i,
            /\bkonstruktion/i,
            /\bhandel/i,
            /\bfordon/i,
            /\bbilverk/i,
            /\bbilservice/i,
            /\bjuridik/i,
            /\badvokat/i,
            /\bekonomi/i,
            /\bredovisning/i,
            /\brevision/i,
            /\bkonsult/i,
        ],
        secondaryBranchPatterns: [
            /\btransport/i,
            /\båkeri/i,
            /\blogistik/i,
            /\bhotell/i,
            /\brestaurang/i,
            /\bcafé/i,
            /\bkafé/i,
            /\blivsmedel/i,
            /\btillverk/i,
            /\bindustri/i,
            /\bsnickeri/i,
            /\bvvs/i,
            /\bel-?install/i,
            /\bmåleri/i,
        ],
    },
};
