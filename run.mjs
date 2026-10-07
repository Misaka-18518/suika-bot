#!/usr/bin/env node
/*!
 * 用 Playwright 驱动真实浏览器，在真实游戏页面上自动游玩。
 *
 *   node run.mjs                          # 默认打 https://dxg.calyx.site/g/FgyFHY2p
 *   node run.mjs --headed                 # 显示浏览器窗口，可以看到它在玩
 *   node run.mjs --nickname 小明          # 结束后自动提交成绩上榜
 *   node run.mjs --games 3 --autoRestart  # 连打 3 局
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = {
    url: "https://dxg.calyx.site/g/FgyFHY2p",
    headed: false,
    nickname: null,
    games: 1,
    autoRestart: false,
    timeoutSec: 900,
    screenshot: "shots/result.png",
    slowMo: 0,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") o.url = argv[++i];
    else if (a === "--headed") o.headed = true;
    else if (a === "--nickname") o.nickname = argv[++i];
    else if (a === "--games") o.games = +argv[++i];
    else if (a === "--autoRestart") o.autoRestart = true;
    else if (a === "--timeout") o.timeoutSec = +argv[++i];
    else if (a === "--screenshot") o.screenshot = argv[++i];
    else if (a === "--slowMo") o.slowMo = +argv[++i];
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--candidates") o.candidates = +argv[++i];
    else if (a === "--weights") o.weights = JSON.parse(argv[++i]);
    else if (a === "--twoPly") o.twoPly = true;
    else if (a === "--noTwoPly") o.twoPly = false;
    else if (a === "--budget") o.timeBudgetMs = +argv[++i];
    else if (a === "--weightsFile") o.weightsFile = argv[++i];
    else if (a === "--profile") o.profile = argv[++i];
    else if (a === "--keepOpen") o.keepOpen = true;
    else if (a === "--value") o.value = argv[++i];
    else if (a === "--noValue") o.noValue = true;
  }
  return o;
}

/** 决策预算档位：与 tools/search.cjs 的 light/full 对应 */
const PROFILES = {
  light: { candidates: 17, finalists: 4, shortSteps: 60, longSteps: 130, twoPly: false, timeBudgetMs: 350 },
  full: { candidates: 29, finalists: 6, shortSteps: 78, longSteps: 190, twoPly: true, timeBudgetMs: 700 },
  strong: { candidates: 41, finalists: 8, shortSteps: 96, longSteps: 260, twoPly: true, timeBudgetMs: 1500 },
};

/** 找到可用的 Chrome：优先用仓库里自带的 Chrome for Testing，其次 Playwright 默认。 */
function resolveChrome() {
  const candidates = [
    path.join(ROOT, ".browsers/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    path.join(ROOT, ".browsers/chrome-linux64/chrome"),
    path.join(ROOT, ".browsers/chrome-linux/chrome"),
    path.join(ROOT, ".browsers/chrome-win64/chrome.exe"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return chromium.executablePath(); } catch { return undefined; }
}

/** 读取成品脚本；缺失或比源文件旧时自动重新打包 */
function loadBotScript() {
  const p = path.join(ROOT, "suika-bot.user.js");
  const sources = ["src/ai.js", "src/bot-core.js"].map((f) => path.join(ROOT, f));
  let stale = !fs.existsSync(p);
  if (!stale) {
    const built = fs.statSync(p).mtimeMs;
    stale = sources.some((f) => !fs.existsSync(f) || fs.statSync(f).mtimeMs > built);
  }
  if (stale) {
    console.log("→ 重新打包 suika-bot.user.js");
    execFileSync(process.execPath, [path.join(ROOT, "tools/build.cjs")], { stdio: "inherit" });
  }
  const src = fs.readFileSync(p, "utf8");
  const i = src.indexOf("// ==/UserScript==");
  return i >= 0 ? src.slice(src.indexOf("\n", i) + 1) : src;
}

const args = parseArgs(process.argv);
const botSrc = loadBotScript();

const botConfig = {
  autostart: true,
  overlay: true,
  autoRestart: args.autoRestart,
  maxGames: args.games,
  submitScore: args.nickname,
};
if (args.profile) {
  const p = PROFILES[args.profile];
  if (!p) throw new Error("未知档位: " + args.profile + "（可选 light / full / strong）");
  Object.assign(botConfig, p);
  console.log("→ 决策档位", args.profile, JSON.stringify(p));
}
// 价值网络：默认自动使用 models/value.json（自我训练的产物），没有就退回手工启发式
const valuePath = args.noValue ? null : (args.value || path.join(ROOT, "models/value.json"));
if (valuePath && fs.existsSync(valuePath)) {
  const doc = JSON.parse(fs.readFileSync(valuePath, "utf8"));
  botConfig.valueModel = doc;
  console.log("→ 使用价值网络 " + path.relative(ROOT, valuePath) +
    "（valMae " + (doc.valMae != null ? doc.valMae : "?") + " 分）");
} else if (!args.noValue) {
  console.log("→ 未找到价值网络模型，使用手工启发式（可用 --value <路径> 指定）");
}
if (args.candidates) botConfig.candidates = args.candidates;
if (args.weights) botConfig.weights = args.weights;
if (args.weightsFile) botConfig.weights = JSON.parse(fs.readFileSync(args.weightsFile, "utf8"));
if (args.twoPly !== undefined) botConfig.twoPly = args.twoPly;
if (args.timeBudgetMs) botConfig.timeBudgetMs = args.timeBudgetMs;

const browser = await chromium.launch({
  executablePath: resolveChrome(),
  headless: !args.headed,
  slowMo: args.slowMo,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 480, height: 960 }, deviceScaleFactor: 1 });
const page = await context.newPage();

page.on("pageerror", (e) => { if (!args.quiet) console.error("[page error]", e.message); });
page.on("console", (m) => {
  if (args.quiet) return;
  const t = m.text();
  if (t.indexOf("[suika-bot]") === 0) console.log("  " + t);
});

await page.addInitScript({ content: "window.__SUIKA_CONFIG__ = " + JSON.stringify(botConfig) + ";\n" });
await page.addInitScript({ content: botSrc });

/** 站点偶尔会瞬断，导航/就绪都做几次重试 */
async function withRetry(label, fn, attempts = 5) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      console.log("  … " + label + " 第 " + i + "/" + attempts + " 次失败：" + String(e.message).split("\n")[0]);
      await page.waitForTimeout(1500 * i);
    }
  }
  throw lastErr;
}

console.log("→ 打开", args.url);
await withRetry("打开页面", () => page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 60000 }));
await withRetry("等待就绪", () =>
  page.waitForFunction(() => window.__SUIKA_BOT__ && window.__SUIKA_BOT__.levelCount > 0, null, { timeout: 60000 })
);

const hooked = await page.evaluate(() => ({
  matter: window.Matter && window.Matter.version,
  bot: window.__SUIKA_BOT__.version,
  levels: window.__SUIKA_BOT__.levelCount,
  title: document.title,
}));
console.log("→ 页面就绪", JSON.stringify(hooked));

const deadline = Date.now() + args.timeoutSec * 1000;
let lastLine = "";
let gamesReported = 0;
const scores = [];
let final = { score: 0, drops: 0, status: "" };

while (Date.now() < deadline) {
  const st = await page.evaluate(() => {
    const b = window.__SUIKA_BOT__;
    const s = b.state;
    return {
      running: s.running,
      drops: s.drops,
      overHandled: !!s.overHandled,
      score: document.getElementById("hud-score") ? +document.getElementById("hud-score").textContent : 0,
      headroom: b._internals.headroom(),
      err: s.lastError,
    };
  });
  const line = "  分数 " + String(st.score).padStart(5) + "  投放 " + String(st.drops).padStart(3) + "  离警戒线 " + Math.round(st.headroom) + "px";
  if (line !== lastLine) { console.log(line); lastLine = line; }
  if (st.err && !args.quiet) console.error("  [bot error]", st.err);

  if (st.overHandled || (!st.running && st.drops > 0)) {
    scores.push(st.score);
    gamesReported++;
    console.log("✔ 第 " + gamesReported + " 局结束，得分 " + st.score);
    if (gamesReported >= args.games) break;
    await page.waitForFunction(() => window.__SUIKA_BOT__.state.running, null, { timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(1000);
}

await page.waitForTimeout(600);
final = await page.evaluate(() => ({
  score: +document.getElementById("hud-score").textContent,
  drops: window.__SUIKA_BOT__.state.drops,
  status: window.__SUIKA_BOT__.status(),
}));
console.log("\n===== 结束 =====");
console.log(final.status);
console.log("最终得分:", final.score, "总投放:", final.drops);

if (args.screenshot) {
  fs.mkdirSync(path.dirname(path.resolve(args.screenshot)), { recursive: true });
  await page.screenshot({ path: args.screenshot, fullPage: false });
  console.log("截图:", args.screenshot);
}

if (args.nickname) {
  await page.waitForTimeout(1800);
  const rank = await page.evaluate(() => {
    const el = document.getElementById("rank-line");
    return el && !el.hidden ? el.textContent : null;
  });
  if (rank) console.log("排行榜:", rank);
}

if (!args.headed || !args.keepOpen) {
  await browser.close();
} else {
  console.log("（--keepOpen：浏览器保持打开，按 Ctrl+C 结束）");
  await new Promise(() => {});
}

console.log(JSON.stringify({ scores, final: final.score }));
