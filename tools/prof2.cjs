// 单局计时：分清物理、决策、maxSpeed 各自的开销
const { SimGame, Matter, AI } = require("./sim-game.cjs");

function playOne(policy) {
  const g = new SimGame(9);
  let waited = 0, drops = 0, decideMs = 0;
  const t0 = Date.now();
  while (!g.over && drops < 600) {
    if (g.canDrop()) {
      const calm = g.maxSpeed() < 0.6;
      if (calm || waited >= 2500) {
        const a = Date.now();
        AI.chooseMove(Matter, {
          levelCount: 9, fruits: g.snapshot(), dropLevel: g.currentLevel, nextLevel: g.nextLevel,
          candidates: policy.candidates, finalists: policy.finalists,
          shortSteps: policy.shortSteps, longSteps: policy.longSteps, twoPly: policy.twoPly,
        });
        decideMs += Date.now() - a;
        g.drop(187);
        drops++; waited = 0;
      } else waited += 1000 / 60;
    }
    g.step();
  }
  return { score: g.score, drops, wall: Date.now() - t0, decideMs, over: g.over };
}

for (const [name, p] of [
  ["default(13/3/55/120)", { candidates: 13, finalists: 3, shortSteps: 55, longSteps: 120, twoPly: false }],
  ["fast(9/3/45/100)", { candidates: 9, finalists: 3, shortSteps: 45, longSteps: 100, twoPly: false }],
  ["tiny(7/2/35/70)", { candidates: 7, finalists: 2, shortSteps: 35, longSteps: 70, twoPly: false }],
]) {
  const r = playOne(p);
  console.log(name.padEnd(22), `score=${r.score} drops=${r.drops} wall=${(r.wall/1000).toFixed(1)}s 决策=${(r.decideMs/1000).toFixed(1)}s (${(100*r.decideMs/r.wall).toFixed(0)}%) over=${r.over}`);
}
