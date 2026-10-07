#!/usr/bin/env node
/*!
 * 离线基准 / 调参：用无头复刻引擎跑完整对局，统计得分。
 *
 *   node tools/tune.cjs --games 20
 *   node tools/tune.cjs --games 20 --weights '{"gain":60,"peak":1.2}'
 *   node tools/tune.cjs --grid            # 权重网格搜索
 */
"use strict";

const { SimGame, Matter, AI, STEP_MS } = require("./sim-game.cjs");

function parseArgs(argv) {
  const out = { games: 10, levelCount: 9, maxDrops: 400, verbose: false, settleSpeed: 0.6, settleMaxMs: 2500 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--games") out.games = +argv[++i];
    else if (a === "--levelCount") out.levelCount = +argv[++i];
    else if (a === "--maxDrops") out.maxDrops = +argv[++i];
    else if (a === "--candidates") out.candidates = +argv[++i];
    else if (a === "--longSteps") out.longSteps = +argv[++i];
    else if (a === "--shortSteps") out.shortSteps = +argv[++i];
    else if (a === "--finalists") out.finalists = +argv[++i];
    else if (a === "--noPly") out.twoPly = false;
    else if (a === "--grid") out.grid = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--weights") out.weights = JSON.parse(argv[++i]);
    else if (a === "--seed") out.seed = +argv[++i];
  }
  return out;
}

/** mulberry32 —— 可复现的 PRNG，替代 Math.random */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playGame(opts) {
  const g = new SimGame(opts.levelCount);
  let waited = 0;
  let decideMs = 0;
  let decisions = 0;
  let drops = 0;
  let maxCombo = 0;

  while (!g.over && drops < opts.maxDrops) {
    if (g.canDrop()) {
      const calm = g.maxSpeed() < opts.settleSpeed;
      if (calm || waited >= opts.settleMaxMs) {
        const t0 = Date.now();
        const move = AI.chooseMove(Matter, {
          levelCount: opts.levelCount,
          fruits: g.snapshot(),
          dropLevel: g.currentLevel,
          nextLevel: g.nextLevel,
          value: opts.value || undefined,
          valueMode: opts.valueMode,
          valueWeight: opts.valueWeight,
          weights: opts.weights,
          candidates: opts.candidates,
          finalists: opts.finalists,
          shortSteps: opts.shortSteps,
          longSteps: opts.longSteps,
          twoPly: opts.twoPly,
        });
        decideMs += Date.now() - t0;
        decisions++;
        g.drop(move.x);
        drops++;
        waited = 0;
      } else {
        waited += STEP_MS;
      }
    }
    g.step();
  }
  if (g.maxLevel > maxCombo) maxCombo = g.maxLevel;
  return {
    score: g.score,
    drops: g.dropCount,
    maxLevel: g.maxLevel,
    vanished: g.vanished,
    headroom: Math.round(g.headroom()),
    seconds: +(g.now / 1000).toFixed(1),
    avgDecideMs: decisions ? +(decideMs / decisions).toFixed(1) : 0,
    dropsPerSec: +(g.dropCount / (g.now / 1000)).toFixed(2),
  };
}

function stats(list) {
  const s = list.slice().sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, mean: +mean.toFixed(1), median, min: s[0], max: s[s.length - 1] };
}

function runBatch(opts, seedBase) {
  const results = [];
  for (let i = 0; i < opts.games; i++) {
    if (opts.seed != null) Math.random = makeRng(opts.seed + i * 7919);
    results.push(playGame(opts));
    if (opts.verbose) console.log("  game", i + 1, JSON.stringify(results[results.length - 1]));
  }
  return results;
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  const t0 = Date.now();
  const results = runBatch(opts, opts.seed || 1);
  const st = stats(results.map((r) => r.score));
  console.log(JSON.stringify({
    score: st,
    maxLevel: stats(results.map((r) => r.maxLevel)),
    drops: stats(results.map((r) => r.drops)),
    avgDecideMs: +(results.reduce((a, r) => a + r.avgDecideMs, 0) / results.length).toFixed(1),
    wallSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    perGameSeconds: +((Date.now() - t0) / 1000 / results.length).toFixed(2),
  }, null, 2));
}

module.exports = { playGame, stats, runBatch, makeRng, parseArgs };
