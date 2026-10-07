#!/usr/bin/env node
/*!
 * 并行自我对弈，生成价值网络训练数据。
 *
 *   node tools/gen-data.cjs --games 400 --out data/v1              # 第 1 轮（启发式策略）
 *   node tools/gen-data.cjs --games 400 --out data/v2 --model models/value.json   # 第 2 轮（用上一轮的值函数）
 *
 * 产物：data/v1/shard-0.bin ... 每个 shard 自带 header，Python 端直接 memmap。
 */
"use strict";
const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const o = {
    games: 200,
    out: "data/v1",
    conc: Math.max(2, require("os").cpus().length - 1),
    seed: 1,
    levelCount: 9,
    maxDrops: 600,
    sampleEvery: 2,
    exploreEps: 0.12,
    model: null,
    policy: null,
    gamesPerShard: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--games") o.games = +argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--conc") o.conc = +argv[++i];
    else if (a === "--seed") o.seed = +argv[++i];
    else if (a === "--levelCount") o.levelCount = +argv[++i];
    else if (a === "--maxDrops") o.maxDrops = +argv[++i];
    else if (a === "--sampleEvery") o.sampleEvery = +argv[++i];
    else if (a === "--explore") o.exploreEps = +argv[++i];
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--policy") o.policy = JSON.parse(argv[++i]);
    else if (a === "--fast") o.policy = { candidates: 9, finalists: 3, shortSteps: 45, longSteps: 100, twoPly: false };
    else if (a === "--strong") o.policy = { candidates: 21, finalists: 5, shortSteps: 70, longSteps: 170, twoPly: true };
  }
  return o;
}

const args = parseArgs(process.argv);
const outDir = path.resolve(args.out);
fs.mkdirSync(outDir, { recursive: true });
const worker = path.join(__dirname, "gen-worker.cjs");

const nShards = Math.min(args.conc, Math.max(1, args.games));
const perShard = Math.ceil(args.games / nShards);

console.log(`→ 生成 ${args.games} 局，分 ${nShards} 个分片，输出到 ${args.out}/`);
const t0 = Date.now();
let done = 0;
let totalSamples = 0;
let totalScore = 0;
let playedGames = 0;

const jobs = [];
for (let i = 0; i < nShards; i++) {
  const games = Math.min(perShard, args.games - i * perShard);
  if (games <= 0) break;
  jobs.push({ i, games });
}

function launch(job) {
  return new Promise((resolve) => {
    const cfg = {
      shardIndex: job.i,
      outPath: path.join(outDir, `shard-${job.i}.bin`),
      games: job.games,
      seed: args.seed * 1000003 + job.i * 7919,
      levelCount: args.levelCount,
      maxDrops: args.maxDrops,
      sampleEvery: args.sampleEvery,
      exploreEps: args.exploreEps,
      modelPath: args.model ? path.resolve(args.model) : null,
      policy: args.policy,
    };
    const child = fork(worker, [JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.on("close", () => {
      try {
        const j = JSON.parse(buf.trim().split("\n").pop());
        totalSamples += j.samples;
        totalScore += j.meanScore * j.games;
        playedGames += j.games;
      } catch (e) { /* 忽略坏分片 */ }
      done++;
      const pct = ((done / jobs.length) * 100).toFixed(0);
      process.stdout.write(`\r  分片 ${done}/${jobs.length} (${pct}%)  样本 ${totalSamples}`);
      resolve();
    });
  });
}

(async function main() {
  // 简易并发池
  const queue = jobs.slice();
  const runners = [];
  const nRun = Math.min(args.conc, queue.length);
  for (let k = 0; k < nRun; k++) {
    runners.push((async () => {
      while (queue.length) await launch(queue.shift());
    })());
  }
  await Promise.all(runners);

  const secs = (Date.now() - t0) / 1000;
  const bytes = fs.readdirSync(outDir).filter((f) => f.endsWith(".bin"))
    .reduce((a, f) => a + fs.statSync(path.join(outDir, f)).size, 0);
  console.log("\n✔ 完成");
  console.log(JSON.stringify({
    games: playedGames,
    samples: totalSamples,
    meanScore: playedGames ? +(totalScore / playedGames).toFixed(1) : 0,
    dir: args.out,
    megabytes: +(bytes / 1048576).toFixed(1),
    seconds: +secs.toFixed(1),
    gamesPerSec: +(playedGames / secs).toFixed(3),
  }, null, 2));
  process.exit(0);
})();
