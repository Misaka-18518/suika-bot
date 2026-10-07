#!/usr/bin/env node
/*!
 * A/B 对照：两套权重用完全相同的随机种子各跑 N 局，做配对比较。
 *
 *   node tools/ab.cjs --games 10 --a '{...}' --b '{...}'
 *   node tools/ab.cjs --games 10 --b tools/best-weights.json     # 文件形式
 */
"use strict";
const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");
const AI = require("../src/ai.js");

const WORKER = path.join(__dirname, "worker.cjs");

function parseArgs(argv) {
  const o = { games: 10, conc: Math.min(8, Math.max(2, require("os").cpus().length - 2)), seedBase: 200000, maxDrops: 250, profile: "light", a: null, b: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--games") o.games = +argv[++i];
    else if (k === "--conc") o.conc = +argv[++i];
    else if (k === "--seedBase") o.seedBase = +argv[++i];
    else if (k === "--maxDrops") o.maxDrops = +argv[++i];
    else if (k === "--profile") o.profile = argv[++i];
    else if (k === "--profileA") o.profileA = argv[++i];
    else if (k === "--profileB") o.profileB = argv[++i];
    else if (k === "--a") o.a = argv[++i];
    else if (k === "--b") o.b = argv[++i];
    else if (k === "--valueA") o.valueA = argv[++i];
    else if (k === "--valueB") o.valueB = argv[++i];
    else if (k === "--valueMode") o.valueMode = argv[++i];
    else if (k === "--valueWeight") o.valueWeight = +argv[++i];
  }
  return o;
}

const PROFILES = {
  light: { candidates: 17, finalists: 4, shortSteps: 60, longSteps: 130, twoPly: false },
  full: { candidates: 29, finalists: 6, shortSteps: 78, longSteps: 190, twoPly: true },
};

function loadWeights(spec) {
  if (!spec) return AI.mergeWeights(null);
  if (fs.existsSync(spec)) return AI.mergeWeights(JSON.parse(fs.readFileSync(spec, "utf8")));
  return AI.mergeWeights(JSON.parse(spec));
}

const args = parseArgs(process.argv);
const profile = PROFILES[args.profile] || PROFILES.light;

function runOne(weights, seed, prof, valuePath) {
  return new Promise((resolve) => {
    const cfg = Object.assign({}, prof || profile, {
      weights, seed, maxDrops: args.maxDrops, levelCount: 9,
      valuePath: valuePath ? path.resolve(valuePath) : null,
      valueMode: args.valueMode, valueWeight: args.valueWeight,
    });
    const child = fork(WORKER, [JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.on("close", () => {
      try { resolve(JSON.parse(buf.trim().split("\n").pop())); }
      catch (e) { resolve({ seed, score: 0, failed: true }); }
    });
  });
}

async function runBatch(weights, seedBase, prof, valuePath) {
  const out = [];
  let next = 0;
  const workers = [];
  const worker = async () => {
    while (next < args.games) {
      const i = next++;
      out[i] = await runOne(weights, seedBase + i, prof, valuePath);
    }
  };
  for (let k = 0; k < Math.min(args.conc, args.games); k++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

(async function main() {
  const wa = loadWeights(args.a);
  const wb = loadWeights(args.b);
  console.log("A =", JSON.stringify(wa));
  console.log("B =", JSON.stringify(wb));

  const t0 = Date.now();
  console.log("A value =", args.valueA || "(无)", " | B value =", args.valueB || "(无)");
  const ra = await runBatch(wa, args.seedBase, PROFILES[args.profileA] || profile, args.valueA);
  const rb = await runBatch(wb, args.seedBase, PROFILES[args.profileB] || profile, args.valueB);
  console.log("profileA =", JSON.stringify(PROFILES[args.profileA] || profile));
  console.log("profileB =", JSON.stringify(PROFILES[args.profileB] || profile));

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sa = ra.map((r) => r.score);
  const sb = rb.map((r) => r.score);
  const diffs = sa.map((v, i) => sb[i] - v);
  const md = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - md) * (d - md), 0) / Math.max(1, diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);

  console.log("A 每局:", sa.join(" "));
  console.log("B 每局:", sb.join(" "));
  console.log("A mean =", mean(sa).toFixed(1), " median =", sa.slice().sort((x, y) => x - y)[Math.floor(sa.length / 2)]);
  console.log("B mean =", mean(sb).toFixed(1), " median =", sb.slice().sort((x, y) => x - y)[Math.floor(sb.length / 2)]);
  console.log("配对差 B-A: mean =", md.toFixed(1), " sd =", sd.toFixed(1), " se =", se.toFixed(1), " t =", (md / (se || 1)).toFixed(2));
  console.log("用时", ((Date.now() - t0) / 1000).toFixed(0), "s");
  process.exit(0);
})();
