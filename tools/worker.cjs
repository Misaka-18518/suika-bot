#!/usr/bin/env node
/*! 单局评估 worker：fork 出来跑一局，把得分以 JSON 打回父进程。 */
"use strict";
const fs = require("fs");
const { playGame, makeRng } = require("./tune.cjs");

const cfg = JSON.parse(process.argv[2]);
Math.random = makeRng(cfg.seed >>> 0);

// 可选：加载价值网络（自我训练产物）参与决策
let value = null;
if (cfg.valuePath && fs.existsSync(cfg.valuePath)) {
  value = require("../src/value.js").createNet(JSON.parse(fs.readFileSync(cfg.valuePath, "utf8")));
}

const r = playGame({
  levelCount: cfg.levelCount || 9,
  maxDrops: cfg.maxDrops || 250,
  settleSpeed: cfg.settleSpeed || 0.6,
  settleMaxMs: cfg.settleMaxMs || 2500,
  value,
  valueMode: cfg.valueMode,
  valueWeight: cfg.valueWeight,
  weights: cfg.weights,
  candidates: cfg.candidates,
  finalists: cfg.finalists,
  shortSteps: cfg.shortSteps,
  longSteps: cfg.longSteps,
  twoPly: cfg.twoPly,
});

process.stdout.write(JSON.stringify({ seed: cfg.seed, score: r.score, drops: r.drops, maxLevel: r.maxLevel, headroom: r.headroom, avgDecideMs: r.avgDecideMs }) + "\n");
