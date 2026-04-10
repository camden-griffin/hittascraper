function pickArgValue(argv, names) {
    const args = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < args.length; i++) {
        const a = (args[i] || "").toString();
        if (names.includes(a)) {
            const next = args[i + 1];
            if (next && !next.toString().startsWith("-")) return next;
        }
        for (const n of names) {
            if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
        }
    }
    return "";
}

// Allow selecting a different input CSV:
// - node src/cli-scrape.js --input input/only_AB_or_Orgnr.csv
// - npm run scrape -- --input input/only_AB_or_Orgnr.csv
const argv = process.argv.slice(2);
let inputArg = pickArgValue(argv, ["--input", "-i"]);

// npm can swallow unknown flags like --input and leave only the value as a
// positional argument. If we see a positional .csv, treat it as input.
if (!inputArg) {
    const positionalCsv = argv.find(
        (a) => a && !a.toString().startsWith("-") && /\.csv$/i.test(a),
    );
    if (positionalCsv) inputArg = positionalCsv.toString();
}

if (inputArg) process.env.INPUT_CSV = inputArg;

const scraper = require("./scraper");

let terminating = false;
let restartRequested = false;
let lastFatal = null;

async function cleanupBrowserOnly() {
    try {
        if (typeof scraper.requestAbort === "function") scraper.requestAbort();
    } catch {}
    try {
        if (typeof scraper.shutdown === "function") await scraper.shutdown();
    } catch {}
}

async function shutdown(code) {
    if (terminating) return;
    terminating = true;
    try {
        await cleanupBrowserOnly();
    } catch {}
    process.exitCode = code;
}

async function requestRestart(err) {
    if (terminating) return;
    restartRequested = true;
    lastFatal = err || new Error("Unknown fatal error");
    try {
        await cleanupBrowserOnly();
    } catch {}
}

process.on("SIGINT", () => {
    // Ctrl+C: request abort, close browser, exit with 130.
    shutdown(130);
});

process.on("SIGTERM", () => {
    shutdown(143);
});

process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
    requestRestart(err);
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    requestRestart(err);
});

(async () => {
    const EXIT_ON_ERROR = /^1|true$/i.test(
        (process.env.EXIT_ON_ERROR || "").toString(),
    );

    let backoffMs = 2000;
    const backoffMaxMs = 60000;

    while (!terminating) {
        restartRequested = false;
        lastFatal = null;

        try {
            await scraper();
            if (!restartRequested) {
                process.exitCode = 0;
                return;
            }
            // An unhandled error triggered a restart request, and the scraper
            // likely exited early due to abort. Restart instead of exiting.
            console.error(
                "Run ended after a restart request; restarting scraper...",
            );
        } catch (err) {
            console.error("Scraper crashed:", err);
            await requestRestart(err);
        }

        if (terminating) return;
        if (EXIT_ON_ERROR) {
            await shutdown(1);
            return;
        }

        if (!restartRequested) {
            // Defensive: if we get here without a restart request, exit.
            await shutdown(1);
            return;
        }

        const msg =
            lastFatal && lastFatal.message
                ? lastFatal.message
                : String(lastFatal);
        console.error(
            `Restarting after fatal error in ${Math.round(backoffMs / 1000)}s: ${msg}`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMaxMs, Math.floor(backoffMs * 1.6));
    }
})();
