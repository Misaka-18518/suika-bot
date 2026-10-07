/*!
 * SuikaAI — 合成大西瓜 落点决策核心
 *
 * 纯计算模块，不依赖 DOM：给定棋盘快照 + 待投放水果等级，用 Matter.js
 * （与页面完全相同的 0.19.0 构建）做前向物理模拟，对每个候选落点打分，
 * 返回最优落点。
 *
 * UMD：浏览器里挂到 window.SuikaAI，Node 里 module.exports。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SuikaAI = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- 与站点 static/js/constants.js 完全一致的几何常量 ----
  var WORLD_W = 375;
  var WORLD_H = 600;
  var DANGER_Y = 110;
  var DROP_Y = 50;
  var MIN_R = 15;
  var MAX_R = 78;
  var STEP_MS = 1000 / 60;

  function radiusForLevel(level, levelCount) {
    if (levelCount <= 1) return MAX_R;
    return MIN_R * Math.pow(MAX_R / MIN_R, level / (levelCount - 1));
  }

  // ---- 打分权重 ----
  // 约定：所有“高度”都以世界坐标像素为单位，数值越大越差，故取负号。
  var DEFAULT_WEIGHTS = {
    gain: 46,          // 模拟过程中每得 1 分
    vanish: 40,        // 满级果实双双消失的额外奖励
    peak: 0.50,        // 最高堆积高度（顶部离地面高度）的线性惩罚
    peakKnee: 380,     // 超过这个高度开始二次惩罚
    peakQuad: 0.02,
    aboveLine: 9.0,    // 果实顶部越过警戒线的高度（像素）惩罚 —— 判定负的直接来源
    aboveSoft: 1.0,    // 接近警戒线的软惩罚
    softMargin: 90,
    stack: 0.50,       // Σ 堆积余高：果实高出“贴地时的高度”的部分
    stackLevel: 0.06,  // 大果实每高一像素的额外代价（鼓励大果沉底）
    mass: 0.0,         // 旧版：Σ 绝对堆积高度（默认关闭，保留以便对照）
    order: 14,         // 逆序惩罚：大果实压在小果实上面
    pair: 5.0,         // 同级别相邻（潜在合成机会）
    pairLevel: 0.55,
    bigLow: 0.0,       // 旧版：Σ level·y/600（量级太小，默认关闭）
    unsettled: 3.0,    // 结束时仍在明显运动的惩罚

    // ---- 只有加载了价值网络 V(board) 时才生效 ----
    // 有了 V 之后评估变成：ev = 本步得分 + V(落定后的棋盘) - 少量安全兜底项
    valueGuard: 4.0,   // 兜底：越过警戒线的像素惩罚（防止早期 V 不靠谱时送命）
    valuePeak: 0.10,   // 兜底：堆积高度的弱惩罚
  };

  function mergeWeights(w) {
    var out = {}, k;
    for (k in DEFAULT_WEIGHTS) out[k] = DEFAULT_WEIGHTS[k];
    if (w) for (k in w) if (w[k] != null) out[k] = w[k];
    return out;
  }

  var DEFAULT_OPTS = {
    candidates: 33,
    finalists: 6,
    shortSteps: 84,
    longSteps: 200,
    twoPly: true,
    plyProbes: 3,
    plyXs: 9,
    timeBudgetMs: 1e9,
    valueFinalists: 10,  // 有 V 时入围数（V 很便宜，多放几个进来精排）
    valueMode: "blend",  // blend（默认，z 分数融合）| replace（完全用 V 取代启发式）
    valueWeight: 0.5,    // blend 模式下 V 的权重
    settleEps: 0.6,      // 判定「已落定」的速度阈值，必须与 gen-data 收样本时的口径一致
    settleFrames: 12,    // 连续多少步低于阈值算落定
  };

  // ---- 一个可复用的模拟世界（与页面 engine.js 行为一致）----
  function createWorld(Matter, levelCount) {
    var Engine = Matter.Engine, Bodies = Matter.Bodies, Body = Matter.Body;
    var World = Matter.World, Composite = Matter.Composite, Events = Matter.Events;

    var engine = Engine.create();
    engine.gravity.y = 1;

    var t = 200;
    var walls = [
      Bodies.rectangle(WORLD_W / 2, WORLD_H + t / 2, WORLD_W + t * 2, t, { isStatic: true }),
      Bodies.rectangle(-t / 2, WORLD_H / 2, t, WORLD_H * 3, { isStatic: true }),
      Bodies.rectangle(WORLD_W + t / 2, WORLD_H / 2, t, WORLD_H * 3, { isStatic: true }),
    ];

    var consumed = new Set();
    var queue = [];
    var totals = { gained: 0, vanish: 0, maxLevel: 0 };

    // 对应 engine.js 的 _bindEvents
    Events.on(engine, "collisionStart", function (evt) {
      for (var i = 0; i < evt.pairs.length; i++) {
        var pair = evt.pairs[i];
        var a = pair.bodyA, b = pair.bodyB;
        if (a.label !== "fruit" || b.label !== "fruit") continue;
        if (a.plugin.level !== b.plugin.level) continue;
        if (consumed.has(a.id) || consumed.has(b.id)) continue;
        if (a.plugin.dead || b.plugin.dead) continue;
        consumed.add(a.id);
        consumed.add(b.id);
        a.plugin.dead = true;
        b.plugin.dead = true;
        queue.push({ a: a, b: b, level: a.plugin.level });
      }
    });

    function makeFruit(level, x, y) {
      var body = Bodies.circle(x, y, radiusForLevel(level, levelCount), {
        label: "fruit",
        restitution: 0.2,
        friction: 0.5,
        frictionStatic: 0.6,
        density: 0.001,
      });
      body.plugin = { kind: "fruit", level: level, dead: false, removed: false };
      World.add(engine.world, body);
      return body;
    }

    // 对应 engine.js 的 _processMerges
    function processMerges() {
      for (var i = 0; i < queue.length; i++) {
        var a = queue[i].a, b = queue[i].b, level = queue[i].level;
        if (a.plugin.removed || b.plugin.removed) continue;
        World.remove(engine.world, a);
        World.remove(engine.world, b);
        a.plugin.removed = true;
        b.plugin.removed = true;
        var mx = (a.position.x + b.position.x) / 2;
        var my = (a.position.y + b.position.y) / 2;
        if (level >= levelCount - 1) {
          totals.gained += levelCount * 2;
          totals.vanish += 1;
          continue;
        }
        var newLevel = level + 1;
        var body = makeFruit(newLevel, mx, my);
        Body.setVelocity(body, {
          x: (a.velocity.x + b.velocity.x) * 0.5,
          y: (a.velocity.y + b.velocity.y) * 0.5,
        });
        totals.gained += newLevel + 1;
        if (newLevel > totals.maxLevel) totals.maxLevel = newLevel;
      }
      queue.length = 0;
      if (consumed.size > 500) consumed.clear();
    }

    function reset(fruits) {
      Composite.clear(engine.world, false, true);
      World.add(engine.world, walls);
      consumed.clear();
      queue.length = 0;
      totals.gained = 0;
      totals.vanish = 0;
      totals.maxLevel = 0;
      for (var i = 0; i < fruits.length; i++) {
        var f = fruits[i];
        var b = makeFruit(f.level, f.x, f.y);
        if (f.angle) Body.setAngle(b, f.angle);
        Body.setVelocity(b, { x: f.vx || 0, y: f.vy || 0 });
        if (f.av) Body.setAngularVelocity(b, f.av);
      }
    }

    function addFruit(level, x, y) {
      return makeFruit(level, x === undefined ? WORLD_W / 2 : x, y === undefined ? DROP_Y : y);
    }

    function step() {
      Engine.update(engine, STEP_MS);
      processMerges();
      return totals.gained;
    }

    function fruits() {
      var bodies = Composite.allBodies(engine.world);
      var out = [];
      for (var i = 0; i < bodies.length; i++) {
        var b = bodies[i];
        if (b.label !== "fruit" || b.plugin.removed || b.plugin.dead) continue;
        out.push({
          level: b.plugin.level,
          x: b.position.x,
          y: b.position.y,
          r: b.circleRadius,
          vx: b.velocity.x,
          vy: b.velocity.y,
          av: b.angularVelocity,
          angle: b.angle,
        });
      }
      return out;
    }

    function maxSpeed() {
      var bodies = Composite.allBodies(engine.world);
      var m = 0;
      for (var i = 0; i < bodies.length; i++) {
        var b = bodies[i];
        if (b.label !== "fruit" || b.plugin.removed || b.plugin.dead) continue;
        var s = Math.abs(b.velocity.x) + Math.abs(b.velocity.y);
        if (s > m) m = s;
      }
      return m;
    }

    return {
      engine: engine,
      reset: reset,
      addFruit: addFruit,
      step: step,
      fruits: fruits,
      maxSpeed: maxSpeed,
      totals: totals,
    };
  }

  /** 只算几何量，供启发式与「价值网络兜底项」共用 */
  function boardStats(fruits) {
    var peak = 0, aboveLine = 0;
    for (var i = 0; i < fruits.length; i++) {
      var top = fruits[i].y - fruits[i].r;
      var h = WORLD_H - top;
      if (h > peak) peak = h;
      if (top < DANGER_Y) aboveLine += DANGER_Y - top;
    }
    return { peak: peak, aboveLine: aboveLine };
  }

  // ---- 棋盘评估：分数越高越好 ----
  function evaluateBoard(fruits, w, gained, vanished, residualSpeed) {
    var peak = 0, mass = 0, stack = 0, stackLevel = 0, aboveLine = 0, aboveSoft = 0, bigLow = 0;
    var i, j, f, top, h, excess;

    for (i = 0; i < fruits.length; i++) {
      f = fruits[i];
      top = f.y - f.r;               // 果实顶部 y（越小越高）
      h = WORLD_H - top;             // 这一处堆积的总高度
      if (h > peak) peak = h;

      // 堆积余高：果实比“贴地摆放”时高出多少。贴地果实的余高恰为 0，
      // 因此它只度量“被垫起来的高度”，不会像绝对高度那样惩罚大果实本身。
      excess = WORLD_H - f.y - f.r;
      if (excess < 0) excess = 0;
      stack += excess;
      stackLevel += f.level * excess;

      mass += h;
      if (top < DANGER_Y) aboveLine += DANGER_Y - top;
      if (top < DANGER_Y + w.softMargin) aboveSoft += DANGER_Y + w.softMargin - top;
      bigLow += f.level * (f.y / WORLD_H);
    }

    // 同级别相邻 = 潜在合成机会
    var pair = 0;
    for (i = 0; i < fruits.length; i++) {
      for (j = i + 1; j < fruits.length; j++) {
        if (fruits[i].level !== fruits[j].level) continue;
        var dx = fruits[i].x - fruits[j].x;
        var dy = fruits[i].y - fruits[j].y;
        var d = Math.sqrt(dx * dx + dy * dy);
        var reach = (fruits[i].r + fruits[j].r) * 1.3;
        if (d < reach) pair += (1 + w.pairLevel * fruits[i].level) * (1 - d / reach);
      }
    }

    // 逆序：大果实压在小果实上方（横向有重叠）→ 堆叠不稳、浪费空间
    var order = 0;
    for (i = 0; i < fruits.length; i++) {
      for (j = 0; j < fruits.length; j++) {
        if (i === j) continue;
        var A = fruits[i], B = fruits[j];
        var dLevel = A.level - B.level;
        if (dLevel <= 0) continue;      // 上面的不比下面的大，正常
        if (A.y + A.r * 0.5 >= B.y - B.r * 0.5) continue;  // A 必须明显在 B 上方
        var span = (A.r + B.r) * 0.9;
        var dxa = Math.abs(A.x - B.x);
        if (dxa >= span) continue;      // 水平没压住
        order += dLevel * (1 - dxa / span);
      }
    }

    var surplus = peak - w.peakKnee;
    if (surplus < 0) surplus = 0;

    var e = 0;
    e += w.gain * gained;
    e += w.vanish * vanished;
    e -= w.peak * peak;
    e -= w.peakQuad * surplus * surplus;
    e -= w.aboveLine * aboveLine;
    e -= w.aboveSoft * aboveSoft;
    e -= w.stack * stack;
    e -= w.stackLevel * stackLevel;
    e -= w.mass * mass;
    e -= w.order * order;
    e += w.bigLow * bigLow;
    e += w.pair * pair;
    e -= w.unsettled * residualSpeed;
    return e;
  }

  /**
   * 入围者的最终排序键。
   *   - 没装 V            → 直接用启发式（run() 里 ev 就是 evH）
   *   - valueMode replace → 直接用 V（期望总分）
   *   - valueMode blend   → 默认。把两者的 z 分数加权融合。
   *
   * 为什么要 blend：V 的验证 MAE 有几百点，而同一局面下不同落点的真实差距往往只有几十点；
   * 直接替换等于把决策全押在一个噪声不小的信号上。标准化之后融合，鲁棒得多。
   */
  function rankFinalists(finals, vnet, opts) {
    if (!vnet) return "heuristic";
    if ((opts.valueMode || "blend") === "replace") return "replace";

    var withV = [];
    for (var i = 0; i < finals.length; i++) if (finals[i].evV != null) withV.push(finals[i]);
    if (withV.length < 3) return withV.length ? "replace" : "heuristic";  // 样本太少，标准差不稳

    var wt = opts.valueWeight != null ? opts.valueWeight : 0.5;
    var mH = 0, mV = 0, k;
    for (k = 0; k < withV.length; k++) { mH += withV[k].evH; mV += withV[k].evV; }
    mH /= withV.length; mV /= withV.length;
    var vH = 0, vV = 0;
    for (k = 0; k < withV.length; k++) {
      vH += (withV[k].evH - mH) * (withV[k].evH - mH);
      vV += (withV[k].evV - mV) * (withV[k].evV - mV);
    }
    var sH = Math.sqrt(vH / withV.length) || 1;
    var sV = Math.sqrt(vV / withV.length) || 1;

    for (k = 0; k < finals.length; k++) {
      var f = finals[k];
      var zH = (f.evH - mH) / sH;
      // 没落定/没算出 V 的，按「V 处于平均水平」处理
      var zV = f.evV != null ? (f.evV - mV) / sV : 0;
      f.ev = zV * wt + zH * (1 - wt);
    }
    return "blend";
  }

  /**
   * 决策主入口。
   *
   * @param {object} Matter Matter 实例（页面里的 window.Matter，或 Node 里的同一构建）
   * @param {object} opts
   *   levelCount   果实等级总数
   *   fruits       当前棋盘快照 [{level,x,y,r,vx,vy,av,angle}]
   *   dropLevel    当前待投放果实等级
   *   nextLevel    下一个果实等级（可选，用于两步预判）
   *   value        可选：src/value.js 的 createNet() 返回的价值网络。
   *                给了它之后，叶子评估变成「本步得分 + V(落定后的棋盘)」，
   *                手工启发式退居为粗筛与安全兜底。
   *   weights      权重覆盖
   *   candidates / finalists / shortSteps / longSteps / twoPly / timeBudgetMs
   *   now          () => ms 时钟注入
   */
  function chooseMove(Matter, opts) {
    var now = opts.now || function () { return Date.now(); };
    var t0 = now();
    var levelCount = opts.levelCount;
    var w = mergeWeights(opts.weights);
    var vnet = opts.value || null;
    var candidates = Math.max(2, opts.candidates || DEFAULT_OPTS.candidates);
    var finalists = Math.max(1, opts.finalists || (vnet ? DEFAULT_OPTS.valueFinalists : DEFAULT_OPTS.finalists));
    // 投完这一颗后，下一颗就是已知的 nextLevel；再下一颗未知，取均匀分布的期望
    var poolMax = Math.min(4, levelCount - 2);
    var leafDrop = opts.nextLevel != null ? opts.nextLevel : opts.dropLevel;
    var leafNext = poolMax > 0 ? poolMax / 2 : 0;
    var shortSteps = opts.shortSteps || DEFAULT_OPTS.shortSteps;
    var longSteps = opts.longSteps || DEFAULT_OPTS.longSteps;
    var budget = opts.timeBudgetMs || DEFAULT_OPTS.timeBudgetMs;
    var r0 = radiusForLevel(opts.dropLevel, levelCount);
    var overBudget = function () { return now() - t0 > budget; };

    var world = createWorld(Matter, levelCount);
    var board = opts.fruits;

    var lo = r0, hi = WORLD_W - r0;
    var xs = [];
    for (var i = 0; i < candidates; i++) xs.push(lo + ((hi - lo) * i) / (candidates - 1));
    xs.push(WORLD_W / 2); // 确保中线被覆盖

    function run(x, level, steps, boardFruits, wantValue) {
      world.reset(boardFruits || board);
      world.addFruit(level, x, DROP_Y);
      var done = 0, calm = 0, speed = 0;
      var eps = opts.settleEps != null ? opts.settleEps : DEFAULT_OPTS.settleEps;
      var need = opts.settleFrames != null ? opts.settleFrames : DEFAULT_OPTS.settleFrames;
      for (var s = 0; s < steps; s++) {
        world.step();
        done++;
        speed = world.maxSpeed();
        if (speed < eps) {
          calm++;
          if (calm > need) break;
        } else calm = 0;
      }
      var snap = world.fruits();
      var settled = calm > need;
      var gained = world.totals.gained;

      // 启发式分数：总是算，用作粗筛的排序键（便宜且稳）
      var evH = evaluateBoard(snap, w, gained, world.totals.vanish, settled ? 0 : speed);

      // 价值网络分数：期望总分 = 这一步已赚到的分 + V(落定后的棋盘)
      // V 的训练目标正是「从这个局面出发还能再拿多少分」，量纲一致。
      // 短模拟没落定时不算（V 只在落定局面上训练过）。
      var evV = null;
      if (vnet && wantValue && settled) {
        var st = boardStats(snap);
        evV = gained
            + vnet.predict(snap, leafDrop, leafNext)
            - w.valueGuard * st.aboveLine
            - w.valuePeak * st.peak;
      }

      return {
        x: x,
        fruits: snap,
        gained: gained,
        vanish: world.totals.vanish,
        steps: done,
        settled: settled,
        speed: speed,
        evH: evH,
        evV: evV,
        ev: evV != null ? evV : evH,
      };
    }

    // 一阶段：粗筛（只看启发式，便宜；V 留到入围者再算）
    var stage1 = [];
    for (var c = 0; c < xs.length; c++) {
      stage1.push(run(xs[c], opts.dropLevel, shortSteps, null, false));
      if (overBudget()) break;
    }
    stage1.sort(function (a, b) { return b.evH - a.evH; });

    // 二阶段：入围者长模拟 + 价值网络精排
    var finals = [];
    for (var k = 0; k < Math.min(finalists, stage1.length); k++) {
      finals.push(run(stage1[k].x, opts.dropLevel, longSteps, null, true));
      if (overBudget()) break;
    }
    if (!finals.length) finals = stage1.slice(0, 1);
    var evMode = rankFinalists(finals, vnet, opts);
    finals.sort(function (a, b) { return b.ev - a.ev; });

    // 两步预判：假设下一步投放 nextLevel，看能否守住。
    // 装了 V 就跳过——V(落定后的棋盘) 本身已经把「下一步那颗粒子」的期望算进去了。
    if (!vnet && opts.twoPly !== false && opts.nextLevel != null && finals.length > 1) {
      var probes = Math.min(opts.plyProbes || DEFAULT_OPTS.plyProbes, finals.length);
      var nxs = opts.plyXs || DEFAULT_OPTS.plyXs;
      var plyXs = [];
      for (var q = 0; q < nxs; q++) plyXs.push(lo + ((hi - lo) * q) / (nxs - 1));
      for (var p = 0; p < probes; p++) {
        if (overBudget()) break;
        var worst = -Infinity;
        for (var n = 0; n < plyXs.length; n++) {
          if (overBudget()) break;
          var r2 = run(plyXs[n], opts.nextLevel, shortSteps, finals[p].fruits);
          if (r2.ev > worst) worst = r2.ev;
        }
        if (worst > -Infinity) finals[p].ev2 = finals[p].ev * 0.65 + worst * 0.35;
      }
    }

    var chosen = finals[0];
    for (var z = 0; z < finals.length; z++) {
      if (finals[z].ev2 != null && (chosen.ev2 == null || finals[z].ev2 > chosen.ev2)) chosen = finals[z];
    }

    return {
      x: Math.max(lo, Math.min(hi, chosen.x)),
      ev: chosen.ev,
      evH: chosen.evH,
      evV: chosen.evV,
      ev2: chosen.ev2,
      usedValue: chosen.evV != null,
      evMode: chosen.evV != null ? evMode : "heuristic",
      settled: chosen.settled,
      evaluated: stage1.length + finals.length,
      elapsedMs: now() - t0,
      ranked: finals.slice(0, 8).map(function (f) {
        return { x: Math.round(f.x * 10) / 10, ev: Math.round(f.ev * 10) / 10, ev2: f.ev2 == null ? null : Math.round(f.ev2 * 10) / 10 };
      }),
    };
  }

  return {
    WORLD_W: WORLD_W,
    WORLD_H: WORLD_H,
    DANGER_Y: DANGER_Y,
    DROP_Y: DROP_Y,
    STEP_MS: STEP_MS,
    radiusForLevel: radiusForLevel,
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    DEFAULT_OPTS: DEFAULT_OPTS,
    mergeWeights: mergeWeights,
    createWorld: createWorld,
    evaluateBoard: evaluateBoard,
    chooseMove: chooseMove,
  };
});
