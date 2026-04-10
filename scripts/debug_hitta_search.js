const puppeteer = require("puppeteer-extra");
const Stealth = require("puppeteer-extra-plugin-stealth");

puppeteer.use(Stealth());

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function tryAcceptCookies(page) {
    const selectors = [
        "#modalConfirmBtn",
        "#onetrust-accept-btn-handler",
        "#gravitoTCFCPM-layer1-accept-all",
        "#gravitoTCFCPM-layer1-accept",
        "#gravitoCMP-accept-all",
        '[id^="gravito"][id$="accept-all"]',
    ];

    for (const sel of selectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                await el.click();
                await sleep(250);
                return true;
            }
        } catch {}
    }

    // Generic text-based accept
    try {
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button"));
            const re =
                /(accept all|accept|agree|godkän(n)? alla|godkänn|tillåt|ok)/i;
            for (const b of buttons) {
                const t = (b.textContent || "").trim();
                if (re.test(t)) {
                    try {
                        b.click();
                        return true;
                    } catch {}
                }
            }
            return false;
        });
    } catch {}

    return false;
}

(async () => {
    const q = (process.argv.slice(2).join(" ") || "").trim();
    if (!q) {
        console.error("Usage: node scripts/debug_hitta_search.js <query>");
        process.exit(2);
    }

    const headless = process.env.HEADLESS
        ? !/^0|false$/i.test(process.env.HEADLESS)
        : true;
    const browser = await puppeteer.launch({ headless });
    const page = await browser.newPage();

    const url = `https://www.hitta.se/sok?vad=${encodeURIComponent(q)}`;
    console.log("query:", q);
    console.log("url:", url);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await tryAcceptCookies(page);

    // Give client-side rendering a chance.
    await sleep(2500);

    try {
        await page.waitForSelector('a[href*="information/"]', {
            timeout: 8000,
        });
    } catch {
        await sleep(1500);
    }

    console.log("final url:", page.url());

    try {
        const title = await page.title();
        console.log("title:", title);
    } catch {}

    try {
        const info = await page.evaluate(() => {
            const text = (
                document.body && document.body.innerText
                    ? document.body.innerText
                    : ""
            )
                .toString()
                .replace(/\s+/g, " ")
                .trim();

            return {
                anchorCount: document.querySelectorAll("a").length,
                infoAnchorCount: document.querySelectorAll(
                    'a[href*="information/"]',
                ).length,
                textSnippet: text.slice(0, 400),
            };
        });
        console.log("dom:", JSON.stringify(info));
    } catch {}

    const anchors = await page.evaluate(() => {
        const out = [];
        const as = Array.from(document.querySelectorAll("a"));
        for (const a of as) {
            const href = (a.getAttribute("href") || a.href || "").toString();
            const text = (a.textContent || "")
                .toString()
                .trim()
                .replace(/\s+/g, " ");
            if (/information\//i.test(href))
                out.push({ href, text: text.slice(0, 120) });
        }
        return out.slice(0, 40);
    });

    console.log("anchors (first 40 with information/):");
    for (const a of anchors) console.log("-", JSON.stringify(a));

    const likely = await page.evaluate((needle) => {
        const out = [];
        const n = (needle || "").toString().toLowerCase();
        const as = Array.from(document.querySelectorAll("a"));
        for (const a of as) {
            const href = (a.getAttribute("href") || a.href || "").toString();
            const text = (a.textContent || "")
                .toString()
                .trim()
                .replace(/\s+/g, " ");
            if (!href) continue;
            const t = text.toLowerCase();
            if (n && t.includes(n)) {
                out.push({ href, text: text.slice(0, 140) });
            }
        }
        return out.slice(0, 25);
    }, q);

    console.log("anchors (text contains query; first 25):");
    for (const a of likely) console.log("-", JSON.stringify(a));

    const first = Array.isArray(likely) && likely.length ? likely[0] : null;
    if (first && first.href) {
        const abs = first.href.startsWith("http")
            ? first.href
            : `https://www.hitta.se${first.href}`;
        console.log("\nFollow first result:", abs);
        try {
            await page.goto(abs, {
                waitUntil: "domcontentloaded",
                timeout: 45000,
            });
            await tryAcceptCookies(page);
            await sleep(2000);
            console.log("result url:", page.url());
            console.log("result title:", await page.title());

            const info2 = await page.evaluate(() => {
                const text = (
                    document.body && document.body.innerText
                        ? document.body.innerText
                        : ""
                )
                    .toString()
                    .replace(/\s+/g, " ")
                    .trim();
                const hrefs = Array.from(document.querySelectorAll("a"))
                    .map((a) =>
                        (a.getAttribute("href") || a.href || "").toString(),
                    )
                    .filter(Boolean);
                const infoLinks = hrefs.filter((h) => /information\//i.test(h));
                return {
                    anchorCount: hrefs.length,
                    infoLinks: infoLinks.slice(0, 10),
                    textSnippet: text.slice(0, 400),
                };
            });
            console.log("result dom:", JSON.stringify(info2));

            const html2 = await page.content();
            const orgDash = html2.match(/\b\d{6}-\d{4}\b/);
            const org10 = html2.match(/\b\d{10}\b/);
            console.log(
                "result html orgnr-like token (dash):",
                orgDash ? orgDash[0] : "(none)",
            );
            console.log(
                "result html orgnr-like token (10d):",
                org10 ? org10[0] : "(none)",
            );
            const mInfo = html2.match(/företagsinformation\/(\d{6}-?\d{4})/);
            const mInfoEnc = html2.match(
                /f%C3%B6retagsinformation\/(\d{6}-?\d{4})/,
            );
            const mInfoAscii = html2.match(
                /foretagsinformation\/(\d{6}-?\d{4})/,
            );
            console.log(
                "result match företagsinformation:",
                mInfo ? mInfo[0] : "(none)",
            );
            console.log(
                "result match f%C3%B6retagsinformation:",
                mInfoEnc ? mInfoEnc[0] : "(none)",
            );
            console.log(
                "result match foret...information:",
                mInfoAscii ? mInfoAscii[0] : "(none)",
            );
        } catch (e) {
            console.log(
                "follow error:",
                e && e.message ? e.message : String(e),
            );
        }
    }

    const html = await page.content();
    const orgLike = html.match(/\b\d{6}-\d{4}\b/);
    console.log("html orgnr-like token:", orgLike ? orgLike[0] : "(none)");
    const patterns = [
        /företagsinformation\/(\d{6}-?\d{4})/g,
        /foretagsinformation\/(\d{6}-?\d{4})/g,
        /f%C3%B6retagsinformation\/(\d{6}-?\d{4})/g,
    ];
    for (const re of patterns) {
        const m = re.exec(html);
        console.log("html match", re.toString(), m ? m[0] : "(none)");
    }

    await browser.close();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
