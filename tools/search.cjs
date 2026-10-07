#!/usr/bin/env node
/*!
 * 并行坐标下降调参：用固定随机种子（common random numbers）公平比较不同权重。
 *
 *   node tools/search.cjs --games 6 --passes 2
 *   node tools/search.cjs --quick
 */
"use strict";
const { fork } = require("child_process");
const path = require("path");

const WORKER = path.join(__dirname, "worker.cjs");
const AI = require("../src/ai.js");

function parseArgs(argv) {
  const o = {
    games: 6,
    passes: 2,
    conc: Math.min(8, Math.max(2, require("os").cpus().length - 2)),
    seedBase: 100000,
    maxDrops: 250,
    profile: "light",
    keys: null,
    out: "tools/best-weights.json",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--games") o.games = +argv[++i];
    else if (a === "--passes") o.passes = +argv[++i];
    else if (a === "--conc") o.conc = +argv[++i];
    else if (a === "--seedBase") o.seedBase = +argv[++i];
    else if (a === "--maxDrops") o.maxDrops = +argv[++i];
    else if (a === "--profile") o.profile = argv[++i];
    else if (a === "--keys") o.keys = argv[++i].split(",");
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--quick") { o.games = 4; o.passes = 1; o.maxDrops = 200; }
  }
  return o;
}

const PROFILES = {
  // 搜索用的廉价配置（决策 ~100ms），权重结论再拿到强配置上复核
  light: { candidates: 17, finalists: 4, shortSteps: 60, longSteps: 130, twoPly: false },
  full: { candidates: 29, finalists: 6, shortSteps: 78, longSteps: 190, twoPly: true },
};

const args = parseArgs(process.argv);
const profile = PROFILES[args.profile] || PROFILES.light;

/** 跑一批对局，返回平均分。每个 seed 起一个子进程，并发 conc。 */
function evalWeights(weights, games, seedBase, label) {
  return new Promise((resolve) => {
    const scores = [];
    let next = 0, running = 0, failed = 0;
    const t0 = Date.now();
    const launch = () => {
      while (running < args.conc && next < games) {
        const i = next++;
        running++;
        const cfg = Object.assign({}, profile, {
          weights,
          seed: seedBase + i,
          maxDrops: args.maxDrops,
          levelCount: 9,
        });
        const child = fork(WORKER, [JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
        let buf = "";
        child.stdout.on("data", (d) => { buf += d; });
        child.on("close", () => {
          try {
            const j = JSON.parse(buf.trim().split("\n").pop());
            scores.push(j.score);
          } catch (e) { failed++; }
          running--;
          launch();
        });
      }
      if (running === 0 && next >= games) {
        const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        const srt = scores.slice().sort((a, b) => a - b);
        resolve({
          label,
          mean: +mean.toFixed(1),
          median: srt.length ? srt[Math.floor(srt.length / 2)] : 0,
          min: srt[0] || 0,
          max: srt[srt.length - 1] || 0,
          n: scores.length,
          failed,
          ms: Date.now() - t0,
        });
      }
    };
    launch();
  });
}

const MULTS = [0.4, 0.7, 1.6, 2.8];
const KEYS = args.keys || ["gain", "peak", "peakKnee", "peakQuad", "aboveLine", "aboveSoft", "mass", "bigLow", "pair", "pairLevel"];

(async function main() {
  let best = AI.mergeWeights(null);
  let bestRes = await evalWeights(best, args.games, args.seedBase, "baseline");
  console.log("baseline", JSON.stringify(bestRes));

  for (let pass = 0; pass < args.passes; pass++) {
    for (const key of KEYS) {
      const base = best[key];
      let localBest = null;
      for (const m of MULTS) {
        if (m === 1.0) continue;
        const cand = Object.assign({}, best);
        cand[key] = +(base * m).toFixed(4);
        const res = await evalWeights(cand, args.games, args.seedBase, key + "×" + m);
        const better = !localBest || res.mean > localBest.res.mean;
        console.log(`  pass${pass} ${key}=${cand[key]}  mean=${res.mean} med=${res.median} max=${res.max}  ${better ? "<= best so far" : ""}`);
        if (better) localBest = { w: cand, res };
      }
      if (localBest && localBest.res.mean > bestRes.mean) {
        best = localBest.w;
        bestRes = localBest.res;
        console.log(`  ✔ 采纳 ${key} -> ${best[key]}  (mean ${bestRes.mean})`);
      }
    }
    console.log("pass", pass, "done. mean =", bestRes.mean, JSON.stringify(best));
  }

  require("fs").writeFileSync(path.join(__dirname, "..", args.out), JSON.stringify(best, null, 2));
  console.log("\n最终权重:", JSON.stringify(best, null, 2));
  console.log("最终成绩:", JSON.stringify(bestRes));
  process.exit(0);
})();
