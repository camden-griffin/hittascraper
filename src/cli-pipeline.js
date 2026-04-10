const { spawnSync } = require("child_process");

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

function hasFlag(argv, names) {
    const args = Array.isArray(argv) ? argv : [];
    return args.some((a) => names.includes((a || "").toString()));
}

function runNode(scriptPath, args, env) {
    const res = spawnSync(process.execPath, [scriptPath, ...(args || [])], {
        stdio: "inherit",
        env: env || process.env,
    });
    if (typeof res.status === "number") return res.status;
    return 1;
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
    const offline = hasFlag(argv, ["--offline"]);

    const childEnv = { ...process.env };
    if (inputArg) childEnv.INPUT_CSV = inputArg;

    // Preflight
    const preflightArgs = [offline ? "offline" : "online"];
    if (inputArg) preflightArgs.push("--input", inputArg);
    let code = runNode("src/cli-preflight.js", preflightArgs, childEnv);
    if (code) process.exit(code);

    // Scrape (skip in offline)
    if (!offline) {
        const scrapeArgs = [];
        if (inputArg) scrapeArgs.push("--input", inputArg);
        code = runNode("src/cli-scrape.js", scrapeArgs, childEnv);
        if (code) process.exit(code);
    }

    // Process + wide report
    code = runNode("src/cli-process.js", [], childEnv);
    if (code) process.exit(code);

    code = runNode("src/wide_report.js", [], childEnv);
    process.exit(code || 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
