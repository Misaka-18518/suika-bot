#!/usr/bin/env node
/*!
 * 把 src/ai.js + src/bot-core.js 打包成单文件用户脚本 suika-bot.user.js
 * 同一份产物既是油猴脚本，也是 run.mjs 注入浏览器时用的脚本（会剥掉元数据头）。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const ai = fs.readFileSync(path.join(root, "src/ai.js"), "utf8");
const value = fs.readFileSync(path.join(root, "src/value.js"), "utf8");
const core = fs.readFileSync(path.join(root, "src/bot-core.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// 可选：把训练好的价值网络内嵌进脚本（油猴用不了本地文件，只能内嵌）
const wantModel = !process.argv.includes("--no-model");
const modelPath = path.join(root, "models/value.json");
let modelBlock = "";
if (wantModel && fs.existsSync(modelPath)) {
  const doc = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  modelBlock = "\nwindow.__SUIKA_VALUE_MODEL__ = " + JSON.stringify(doc) + ";\n";
  console.log("内嵌价值网络 models/value.json（valMae " + (doc.valMae != null ? doc.valMae : "?") +
    "，约 " + Math.round(modelBlock.length / 1024) + " KB）");
} else if (wantModel) {
  console.log("（没有 models/value.json，脚本将使用手工启发式）");
}

const header = "// ==UserScript==\n" +
  "// @name         合成大西瓜 · AI 自动游玩\n" +
  "// @namespace    suika-bot\n" +
  "// @version      " + pkg.version + "\n" +
  "// @description  自动游玩 dxg.calyx.site 上的合成大西瓜：读取真实物理状态 → Matter.js 前向模拟候选落点 → 选最优位置投放\n" +
  "// @author       suika-bot\n" +
  "// @match        *://dxg.calyx.site/g/*\n" +
  "// @match        *://*/g/*\n" +
  "// @run-at       document-start\n" +
  "// @grant        none\n" +
  "// ==/UserScript==\n" +
  "\n" +
  "// 可选运行参数（在油猴脚本管理器的“设置/编辑”里，或在页面 <head> 前注入）：\n" +
  "//   window.__SUIKA_CONFIG__ = { autostart: true, submitScore: \"我的昵称\", autoRestart: true };\n";

const banner = "\n/* ------------------------------------------------------------------\n" +
  " * 由 tools/build.cjs 自动生成，请勿直接编辑。\n" +
  " *   src/ai.js        → 决策核心（物理前向模拟 + 棋盘评估）\n" +
  " *   src/value.js     → 价值网络 V(board)：栅格化 + 纯 JS 推理\n" +
  " *   src/bot-core.js  → 浏览器胶水（状态钩子 + 指针事件 + 主循环）\n" +
  " * ------------------------------------------------------------------ */\n";

const out = header + banner + "\n" + ai + "\n\n" + value + modelBlock + "\n" + core + "\n";
fs.writeFileSync(path.join(root, "suika-bot.user.js"), out);
console.log("suika-bot.user.js", out.length, "bytes");
