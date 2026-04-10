const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const file = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(process.cwd(), "input", "only_AB_or_Orgnr.csv");

let total = 0;
let missing = 0;
const samples = [];

fs.createReadStream(file)
    .pipe(csv())
    .on("data", (row) => {
        total++;
        const org = (row.orgnr || row.OrgNr || row.org || "").toString().trim();
        if (!org) {
            missing++;
            if (samples.length < 30) {
                samples.push({
                    url: (row.url || row.URL || "").toString().trim(),
                    company: (row.company || row.name || row.ab || row.AB || "")
                        .toString()
                        .trim(),
                    email: (row.email || "").toString().trim(),
                });
            }
        }
    })
    .on("end", () => {
        console.log(`file: ${file}`);
        console.log(`total rows: ${total}`);
        console.log(`missing orgnr: ${missing}`);
        console.log("samples:");
        for (const s of samples) console.log("-", JSON.stringify(s));
    })
    .on("error", (err) => {
        console.error(err);
        process.exit(1);
    });
