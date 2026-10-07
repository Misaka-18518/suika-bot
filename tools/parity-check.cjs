#!/usr/bin/env node
/*! 比较纯 JS 推理与 PyTorch 的输出是否一致：node tools/parity-check.cjs /tmp/parity.json */
"use strict";
const fs = require("fs");
const V = require("../src/value.js");

const file = process.argv[2] || "/tmp/parity.json";
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const model = JSON.parse(fs.readFileSync(doc.model, "utf8"));
const net = V.createNet(model);

let worst = 0;
const rows = [];
for (const c of doc.cases) {
  const grid = new Uint8Array(Buffer.from(c.grid, "base64"));
  const got = net.predictGrid(grid, c.drop, c.next);
  const err = Math.abs(got - c.expect);
  if (err > worst) worst = err;
  rows.push({ expect: +c.expect.toFixed(3), got: +got.toFixed(3), err: +err.toFixed(4) });
}
console.log(JSON.stringify(rows.slice(0, 6), null, 1));
console.log("最大绝对误差:", worst.toFixed(5), "分");
if (worst > 1.0) {
  console.error("✘ JS 与 PyTorch 推理不一致（>1 分），检查卷积/全连接实现");
  process.exit(1);
}
console.log("✔ 数值对齐通过");
