const { SimGame, Matter, AI } = require("./sim-game.cjs");
const g = new SimGame(9);
for (let i = 0; i < 40 && !g.over; i++) {
  let guard = 0;
  while (!g.canDrop() && !g.over && guard++ < 200) g.step();
  g.drop(60 + Math.random() * 255);
  for (let k = 0; k < 30 && !g.over; k++) g.step();
}
console.log("board fruits:", g.snapshot().length, "score:", g.score);
const snap = g.snapshot();

const w = AI.createWorld(Matter, 9);
w.reset(snap);
let t = Date.now();
for (let i = 0; i < 2000; i++) w.step();
const stepMs = (Date.now() - t) / 2000;
console.log("2000 sim steps:", Date.now() - t, "ms  =>", stepMs.toFixed(3), "ms/step");

for (const cfg of [
  { name: "默认(33/6/78/190/2ply)", o: {} },
  { name: "一阶段(29/1/78)", o: { finalists: 1, twoPly: false, candidates: 29 } },
  { name: "轻量(17/4/60/140/1ply)", o: { candidates: 17, finalists: 4, shortSteps: 60, longSteps: 140, twoPly: false } },
  { name: "轻量+2ply(17/4/60/140/2ply)", o: { candidates: 17, finalists: 4, shortSteps: 60, longSteps: 140, twoPly: true, plyProbes: 2, plyXs: 7 } },
]) {
  const o = Object.assign({ levelCount: 9, fruits: snap, dropLevel: g.currentLevel, nextLevel: g.nextLevel }, cfg.o);
  const t0 = Date.now();
  const mv = AI.chooseMove(Matter, o);
  console.log(cfg.name, "=>", Date.now() - t0, "ms, ev=", mv.ev.toFixed(1), "x=", mv.x.toFixed(1), "evaluated=", mv.evaluated);
}
