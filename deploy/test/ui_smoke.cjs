// UI smoke test: registers a user, promotes it, then walks the main screens at phone,
// tablet and desktop widths. Fails on horizontal scroll, console errors or a missing heading.
//   cd deploy && NODE_PATH=<dir with playwright-core> node test/ui_smoke.cjs [screenshot dir]
const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
const path = require("path");

const BASE = process.env.BASE || "https://localhost";
const OUT = process.argv[2] || "/tmp/sc-shots";
const SIZES = { phone: [375, 812], tablet: [768, 1024], desktop: [1280, 800] };
const PAGES = ["/", "/requests", "/approvals", "/wallet", "/history", "/notifications", "/admin", "/profile", "/matches/new"];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => m.type() === "error" && !/401|403/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

  // Guest prompt first, then register through the real form.
  await page.goto(BASE + "/");
  await page.getByLabel("Nama panggilan").waitFor();
  await page.screenshot({ path: path.join(OUT, "guest-prompt.png") });
  const email = `ui-${Date.now()}@test.id`;
  await page.goto(BASE + "/register");
  await page.getByLabel("Nama lengkap").fill("Uji Tampilan");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill("password-123");
  await page.getByRole("button", { name: "Buat akun" }).click();
  await page.getByRole("heading", { name: /Siap turun/ }).waitFor();
  execFileSync("docker", ["compose", "exec", "-T", "api", "shuttlecircle", "create-superadmin", "--email", email]);
  await page.reload(); // a reload refreshes the session, which picks up the new role

  let checks = 0;
  for (const [name, [width, height]] of Object.entries(SIZES)) {
    await page.setViewportSize({ width, height });
    for (const p of PAGES) {
      await page.goto(BASE + p);
      await page.locator("h1").first().waitFor({ timeout: 15000 }).catch(() => problems.push(`${name} ${p}: no h1`));
      await page.waitForLoadState("networkidle").catch(() => {});
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`${name} ${p}: horizontal overflow ${overflow}px`);
      await page.screenshot({ path: path.join(OUT, `${name}${p === "/" ? "-calendar" : p.replace(/\//g, "-")}.png`), fullPage: true });
      checks++;
    }
    // Open the first match from the calendar.
    await page.goto(BASE + "/");
    const first = page.locator('a[href^="/matches/"]:not([href$="/new"]):visible').first();
    await first.waitFor({ timeout: 15000 }).catch(() => {});
    if (await first.count()) {
      await first.click();
      await page.locator("h1").first().waitFor();
      await page.waitForLoadState("networkidle").catch(() => {});
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`${name} match detail: horizontal overflow ${overflow}px`);
      await page.screenshot({ path: path.join(OUT, `${name}-match.png`), fullPage: true });
      checks++;
    } else problems.push(`${name}: no match link on calendar`);
  }
  await browser.close();
  console.log(`${checks} screens checked, ${problems.length} problems`);
  problems.forEach((p) => console.log("  PROBLEM:", p));
  process.exit(problems.length ? 1 : 0);
})();
