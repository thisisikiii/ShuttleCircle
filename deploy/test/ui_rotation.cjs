// UI check of the court rotation board (FR-19) as host and as a player, at phone and desktop widths.
// Fails on horizontal scroll, console errors, or a missing control.
//   cd deploy && NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_PATH=<dir with playwright-core> BASE=https://localhost:8443 node test/ui_rotation.cjs [screenshot dir]
const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
const path = require("path");

const BASE = process.env.BASE || "https://localhost";
const OUT = process.argv[2] || "/tmp/sc-rotation";
const RUN = Date.now();

async function call(token, method, p, body) {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json)}`);
  return json?.data;
}
const register = async (name) => {
  const email = `${name.toLowerCase().replace(/\W/g, "")}-${RUN}@test.id`;
  const d = await call(null, "POST", "/auth/register", { email, password: "password-123", full_name: name });
  return { name, email, token: d.access_token };
};

(async () => {
  // Data: a superadmin host, 8 confirmed players, 8 arrived, court 1 playing, court 2 with a next turn.
  const host = await register("Tuan Rumah");
  execFileSync("docker", ["compose", "exec", "-T", "api", "shuttlecircle", "create-superadmin", "--email", host.email]);
  host.token = (await call(null, "POST", "/auth/login", { email: host.email, password: "password-123" })).access_token;
  const names = ["Andi", "Budi", "Citra", "Dewi", "Eko", "Fajar", "Gita", "Hadi"];
  const players = [];
  for (const n of names) players.push(await register(n));
  const start = new Date(Date.now() + 86400000).toISOString();
  const m = (await call(host.token, "POST", "/matches", {
    title: "Rotasi UI", location_name: "GOR Test", location_maps_url: "https://maps.app.goo.gl/test", starts_at: start,
    duration_hours: 3, capacity: 12, match_type: "intermediate", racket_provided: false, shuttlecock_provided: true, price_idr: 0,
  })).id;
  for (const p of players) {
    const r = await call(p.token, "POST", `/matches/${m}/join-requests`, {});
    await call(host.token, "POST", `/join-requests/${r.id}/approve`);
  }
  const R = `/matches/${m}/rotation`;
  let b = await call(host.token, "GET", R);
  await call(host.token, "POST", `${R}/players`, { join_request_ids: b.players.map((p) => p.join_request_id), state: "waiting" });
  b = await call(host.token, "POST", `${R}/courts/1/next`);
  await call(host.token, "POST", `${R}/games/${b.games.find((g) => g.court === 1).id}/start`);
  await call(host.token, "POST", `${R}/courts/2/next`);

  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const problems = [];
  const open = async (who) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    page.on("console", (msg) => msg.type() === "error" && !/401|403/.test(msg.text()) && problems.push(`${who.name} console: ${msg.text()}`));
    page.on("pageerror", (e) => problems.push(`${who.name} pageerror: ${e.message}`));
    await page.goto(BASE + "/login", { waitUntil: "networkidle" }); // filled before hydration, the form would reset
    await page.getByLabel("Email").fill(who.email);
    await page.getByLabel(/^Password/).fill("password-123");
    await page.getByRole("button", { name: /Masuk/ }).last().click();
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), null, { timeout: 15000 });
    await page.goto(`${BASE}/matches/${m}`);
    await page.getByRole("heading", { name: "Rotasi lapangan" }).waitFor({ timeout: 15000 });
    return page;
  };
  const noScroll = async (page, label) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) problems.push(`${label}: horizontal scroll ${over}px`);
  };
  let checks = 0;
  const expect = (cond, msg) => (cond ? checks++ : problems.push(msg));

  const hp = await open(host);
  for (const [w, h, tag] of [[375, 812, "phone"], [1280, 800, "desktop"]]) {
    await hp.setViewportSize({ width: w, height: h });
    await hp.getByRole("heading", { name: "Rotasi lapangan" }).scrollIntoViewIfNeeded();
    await noScroll(hp, `host ${tag}`);
    await hp.screenshot({ path: path.join(OUT, `host-${tag}.png`), fullPage: true });
  }
  expect(await hp.getByRole("button", { name: "Selesai" }).count() === 1, "host: court 1 shows one running game with Selesai");
  expect(await hp.getByRole("button", { name: "Mulai" }).count() === 1, "host: court 2 next turn has Mulai");
  expect(await hp.getByRole("button", { name: "Pilihkan pemain" }).count() === 1, "host: court 1 can prepare its next turn while playing");
  // Live scoreboard: three rallies to team A, one undone.
  for (let i = 0; i < 3; i++) {
    await hp.getByRole("button", { name: "Tambah poin Tim A" }).click();
    await hp.getByRole("button", { name: "Tambah poin Tim A" }).and(hp.locator(":enabled")).waitFor();
  }
  await hp.getByRole("button", { name: "Batalkan poin Tim A" }).click();
  await hp.getByLabel("Tim A: 2").waitFor({ timeout: 10000 });
  // Finish court 1: the dialog starts from the live score.
  await hp.getByRole("button", { name: "Selesai" }).click();
  expect((await hp.getByLabel("Skor tim A").inputValue()) === "2", "host: finish dialog prefilled with the live score");
  await hp.getByLabel("Skor tim A").fill("21");
  await hp.getByLabel("Skor tim B").fill("17");
  await hp.screenshot({ path: path.join(OUT, "host-finish-dialog.png") });
  await hp.getByRole("dialog").getByRole("button", { name: "Selesai" }).click();
  await hp.getByText("21–17").first().waitFor({ timeout: 10000 });
  expect(await hp.getByRole("heading", { name: "Papan peringkat" }).count() === 1, "host: leaderboard shown");
  expect(await hp.getByRole("row").filter({ hasText: "+4" }).count() === 2, "host: both winners show +4");
  expect(await hp.getByText("1× main").count() >= 4, "host: four players show one game");
  // Pick court 1 again from the board.
  await hp.getByRole("button", { name: "Pilihkan pemain" }).first().click();
  await hp.waitForTimeout(1500);
  await hp.screenshot({ path: path.join(OUT, "host-after.png"), fullPage: true });

  const pp = await open(players[0]);
  await noScroll(pp, "player phone");
  await pp.getByRole("heading", { name: "Rotasi lapangan" }).scrollIntoViewIfNeeded();
  await pp.screenshot({ path: path.join(OUT, "player-phone.png"), fullPage: true });
  expect(await pp.getByRole("button", { name: /Pilihkan|Mulai|Selesai|Sudah datang/ }).count() === 0, "player: board is read-only");
  expect(await pp.getByText("21–17").count() >= 1, "player: sees the finished game");
  expect(await pp.getByRole("heading", { name: "Papan peringkat" }).count() === 1, "player: sees the leaderboard");

  await browser.close();
  console.log(`${checks} checks, ${problems.length} problems`);
  problems.forEach((p) => console.log("  " + p));
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
