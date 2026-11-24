// End-to-end smoke test: signs in with the real backend and opens every dashboard page in Edge/Chrome.
// Requires backend + frontend running. Usage (PowerShell):
//   $env:E2E_EMAIL="you@example.com"; $env:E2E_PASSWORD="…"; npm run test:e2e
//   optional: $env:E2E_BASE="http://localhost:3000"; $env:BROWSER_PATH="C:\...\msedge.exe"
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const base = process.env.E2E_BASE ?? "http://localhost:3000";
const email = process.env.E2E_EMAIL, password = process.env.E2E_PASSWORD;
if (!email || !password) { console.error("Set E2E_EMAIL and E2E_PASSWORD"); process.exit(2); }
const browserPath = process.env.BROWSER_PATH ?? [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

const PAGES = [
  ["/", "Overview"], ["/content", "Content Studio"], ["/references", "Reference Library"], ["/characters", "Character Studio"],
  ["/review", "Review Studio"], ["/publishing", "Publishing Center"], ["/analytics", "Analytics"], ["/settings", "Settings"],
];

const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--disable-gpu"], defaultViewport: { width: 1366, height: 860 } });
const page = await browser.newPage();
const crashes = [];
page.on("pageerror", (e) => crashes.push(e.message));
let failed = 0;
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#email", { timeout: 20_000 });
  await page.type("#email", email);
  await page.type("#password", password);
  await Promise.all([page.click("button[type=submit]"), page.waitForSelector("aside nav", { timeout: 20_000 })]);
  console.log("✔ signed in");
  for (const [path, heading] of PAGES) {
    crashes.length = 0;
    await page.goto(base + path, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction((h) => [...document.querySelectorAll("h1")].some((e) => e.textContent?.includes(h)), { timeout: 15_000 }, heading);
      await new Promise((r) => setTimeout(r, 1500));
      if (crashes.length) throw new Error(`page error: ${crashes.join(" | ")}`);
      console.log(`✔ ${path} (${heading})`);
    } catch (e) {
      failed++;
      console.log(`✖ ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} page(s) failed` : "all pages OK");
process.exit(failed ? 1 : 0);
