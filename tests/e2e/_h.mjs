import { chromium } from "@playwright/test";
const b = await chromium.launch({
    headless: false,
    executablePath: process.argv[2],
    logger: { isEnabled: () => true, log: (n, s, m) => console.log(n, m) },
});
const p = await b.newPage();
await p.goto("about:blank");
await new Promise((r) => setTimeout(r, 3000));
await b.close();
