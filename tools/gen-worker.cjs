#!/usr/bin/env node
/*!
 * 自我对弈数据生成 worker：玩若干局，把每个决策点的 (棋盘, 当前/下一个水果, 之后的得分)
 * 写成一个 shard 文件。父进程 tools/gen-data.cjs 负责并行调度。
 *
 * 记录格式（小端）：
 *   header 32B: "SKD1" | ver | gridW | gridH | channels | levelCount | recordBytes | count
 *   record   : float32[4] = (scoreNow, scoreToGo, dropLevel, nextLevel) + uint8[channels*gridH*gridW]
 */
"use strict";

const fs = require("fs");
const { SimGame, Matter, AI } = require("./sim-game.cjs");
const V = require("../src/value.js");

const cfg = JSON.parse(process.argv[2]);
const LEVELS = cfg.levelCount || 9;

// 可复现
Math.random = (function (seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})(cfg.seed >>> 0);

// 可选的、由上一轮训练得到的价值网络（用于「策略迭代」）
let vnet = null;
if (cfg.modelPath && fs.existsSync(cfg.modelPath)) {
  vnet = V.createNet(JSON.parse(fs.readFileSync(cfg.modelPath, "utf8")));
}

const GRID_BYTES = V.CHANNELS * V.GRID_H * V.GRID_W;
const RECORD_BYTES = 16 + GRID_BYTES;
const BATCH_RECORDS = 512;

const fd = fs.openSync(cfg.outPath, "w");
fs.writeSync(fd, Buffer.alloc(32));
let pending = [];
let written = 0;
const grid = new Uint8Array(GRID_BYTES);
const rec = Buffer.allocUnsafe(RECORD_BYTES);

const headerBuf = Buffer.alloc(32);
headerBuf.write("SKD1", 0, "ascii");
headerBuf.writeUInt32LE(1, 4);
headerBuf.writeUInt32LE(V.GRID_W, 8);
headerBuf.writeUInt32LE(V.GRID_H, 12);
headerBuf.writeUInt32LE(V.CHANNELS, 16);
headerBuf.writeUInt32LE(LEVELS, 20);
headerBuf.writeUInt32LE(RECORD_BYTES, 24);

/** 每次落盘都把样本数写回 header：中途 Ctrl-C 也留下一个能直接训练的分片 */
function writeHeader() {
  headerBuf.writeUInt32LE(written, 28);
  fs.writeSync(fd, headerBuf, 0, 32, 0);   // 带 position 的写不会移动文件偏移
}

function flush() {
  if (!pending.length) return;
  const buf = Buffer.concat(pending, pending.length * RECORD_BYTES);
  fs.writeSync(fd, buf);
  written += pending.length;
  pending = [];
  writeHeader();
}

function pushSample(fruits, dropLevel, nextLevel, scoreNow, scoreToGo) {
  V.rasterize(fruits, LEVELS, grid);
  rec.writeFloatLE(scoreNow, 0);
  rec.writeFloatLE(scoreToGo, 4);
  rec.writeFloatLE(dropLevel, 8);
  rec.writeFloatLE(nextLevel, 12);
  Buffer.from(grid.buffer, grid.byteOffset, GRID_BYTES).copy(rec, 16);
  pending.push(Buffer.from(rec));
  if (pending.length >= BATCH_RECORDS) flush();
}

const policy = Object.assign(
  { candidates: 13, finalists: 3, shortSteps: 55, longSteps: 120, twoPly: false },
  cfg.policy || {}
);
const exploreEps = cfg.exploreEps == null ? 0.12 : cfg.exploreEps;
const sampleEvery = cfg.sampleEvery || 2;
const maxDrops = cfg.maxDrops || 600;

let gamesDone = 0, totalSamples = 0, totalScore = 0, maxScore = 0;

for (let g = 0; g < cfg.games; g++) {
  const game = new SimGame(LEVELS);
  const buffer = [];            // 本局决策点，结束后回填 scoreToGo
  let decisionIdx = 0;
  let waited = 0;
  let drops = 0;

  while (!game.over && drops < maxDrops) {
    if (game.canDrop()) {
      const calm = game.maxSpeed() < 0.6;
      if (calm || waited >= 2500) {
        const fruits = game.snapshot();
        const dropLevel = game.currentLevel;
        const nextLevel = game.nextLevel;
        const scoreNow = game.score;

        const keep = decisionIdx % sampleEvery === 0;
        if (keep) buffer.push({ scoreNow, dropLevel, nextLevel, fruits });

        const move = AI.chooseMove(Matter, {
          levelCount: LEVELS,
          fruits,
          dropLevel,
          nextLevel,
          candidates: policy.candidates,
          finalists: policy.finalists,
          shortSteps: policy.shortSteps,
          longSteps: policy.longSteps,
          twoPly: policy.twoPly,
          value: vnet || undefined,
        });

        let x = move.x;
        if (exploreEps > 0 && Math.random() < exploreEps && move.ranked && move.ranked.length > 1) {
          const k = 1 + Math.floor(Math.random() * Math.min(3, move.ranked.length - 1));
          x = move.ranked[k].x;      // 有意偏离最优，扩大状态覆盖
        }
        game.drop(x);
        drops++;
        decisionIdx++;
        waited = 0;
      } else {
        waited += 1000 / 60;
      }
    }
    game.step();
  }

  for (const s of buffer) pushSample(s.fruits, s.dropLevel, s.nextLevel, s.scoreNow, Math.max(0, game.score - s.scoreNow));
  totalSamples += buffer.length;
  totalScore += game.score;
  if (game.score > maxScore) maxScore = game.score;
  gamesDone++;
}
flush();
writeHeader();
fs.closeSync(fd);

process.stdout.write(JSON.stringify({
  shard: cfg.outPath,
  games: gamesDone,
  samples: written,
  meanScore: +(totalScore / Math.max(1, gamesDone)).toFixed(1),
  maxScore,
}) + "\n");
