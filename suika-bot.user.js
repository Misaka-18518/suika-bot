// ==UserScript==
// @name         合成大西瓜 · AI 自动游玩
// @namespace    suika-bot
// @version      1.0.0
// @description  自动游玩 dxg.calyx.site 上的合成大西瓜：读取真实物理状态 → Matter.js 前向模拟候选落点 → 选最优位置投放
// @author       suika-bot
// @match        *://dxg.calyx.site/g/*
// @match        *://*/g/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// 可选运行参数（在油猴脚本管理器的“设置/编辑”里，或在页面 <head> 前注入）：
//   window.__SUIKA_CONFIG__ = { autostart: true, submitScore: "我的昵称", autoRestart: true };

/* ------------------------------------------------------------------
 * 由 tools/build.cjs 自动生成，请勿直接编辑。
 *   src/ai.js        → 决策核心（物理前向模拟 + 棋盘评估）
 *   src/value.js     → 价值网络 V(board)：栅格化 + 纯 JS 推理
 *   src/bot-core.js  → 浏览器胶水（状态钩子 + 指针事件 + 主循环）
 * ------------------------------------------------------------------ */

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


/*!
 * SuikaValue — 棋盘价值网络 V(board)
 *
 * 两部分：
 *   1. rasterize()：把水果列表编码成固定尺寸的多通道栅格图（供网络输入）
 *   2. createNet() ：加载导出的 JSON 权重，做纯 JS 前向推理（无依赖）
 *
 * 网络结构必须与 train/model.py 完全一致：
 *   conv(3→16,k3,s2,p1)+ReLU → conv(16→32,k3,s2,p1)+ReLU → conv(32→64,k3,s2,p1)+ReLU
 *   → flatten(64*5*4=1280) ⊕ 全局特征(3) → fc(1283→96)+ReLU → fc(96→48)+ReLU → fc(48→1)
 *
 * UMD：浏览器挂 window.SuikaValue，Node 里 module.exports。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SuikaValue = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var WORLD_W = 375, WORLD_H = 600;
  var GRID_W = 25, GRID_H = 40, CHANNELS = 3, CELL = 15;   // 15px 一格
  var GLOBALS = 3;                                          // drop, next, 数量

  // ---------------------------------------------------------------- 栅格化
  /**
   * @param {Array} fruits   [{level,x,y,r,...}]（建议先用已落定的棋盘）
   * @param {number} levelCount 果实等级总数
   * @param {Uint8Array} out  长度 CHANNELS*GRID_H*GRID_W，会被覆盖
   *
   * 通道 0：覆盖掩码
   * 通道 1：该格上「最大等级」水果的等级（归一化到 0..255）
   * 通道 2：该格上「最靠上」水果的等级（决定还能往哪堆）
   */
  var _minY = new Float32Array(GRID_H * GRID_W);   // 复用的临时缓冲，避免每次预测都分配

  function rasterize(fruits, levelCount, out) {
    var plane = GRID_H * GRID_W;
    if (!out || out.length !== CHANNELS * plane) out = new Uint8Array(CHANNELS * plane);
    out.fill(0);
    var denom = levelCount > 1 ? levelCount - 1 : 1;
    var minY = _minY;
    minY.fill(Infinity);

    for (var f = 0; f < fruits.length; f++) {
      var fr = fruits[f];
      var r = fr.r, x = fr.x, y = fr.y;
      var lv = Math.round(255 * fr.level / denom);
      if (lv < 1) lv = 1;
      if (lv > 255) lv = 255;

      var gx0 = Math.floor((x - r) / CELL); if (gx0 < 0) gx0 = 0;
      var gx1 = Math.floor((x + r) / CELL); if (gx1 > GRID_W - 1) gx1 = GRID_W - 1;
      var gy0 = Math.floor((y - r) / CELL); if (gy0 < 0) gy0 = 0;
      var gy1 = Math.floor((y + r) / CELL); if (gy1 > GRID_H - 1) gy1 = GRID_H - 1;
      var r2 = r * r;

      for (var gy = gy0; gy <= gy1; gy++) {
        var cy = (gy + 0.5) * CELL - y;
        var rowBase = gy * GRID_W;
        for (var gx = gx0; gx <= gx1; gx++) {
          var cx = (gx + 0.5) * CELL - x;
          if (cx * cx + cy * cy > r2) continue;
          var idx = rowBase + gx;
          out[idx] = 255;
          if (lv > out[plane + idx]) out[plane + idx] = lv;
          if (y < minY[idx]) { minY[idx] = y; out[2 * plane + idx] = lv; }
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 推理
  function b64ToFloat32(b64) {
    var bin;
    if (typeof atob === "function") {
      bin = atob(b64);
    } else {
      bin = Buffer.from(b64, "base64").toString("binary");
    }
    var n = bin.length;
    var bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer, bytes.byteOffset, n >> 2);
  }

  /** padding=1, stride 可变的 3x3 卷积 + ReLU（权重布局与 PyTorch 一致：OC,IC,KH,KW） */
  function conv3x3(inp, inC, inH, inW, w, bias, outC, stride) {
    var outH = Math.floor((inH + 2 - 3) / stride) + 1;
    var outW = Math.floor((inW + 2 - 3) / stride) + 1;
    var outc = new Float32Array(outC * outH * outW);
    for (var oc = 0; oc < outC; oc++) {
      var b = bias[oc];
      var wBase = oc * inC * 9;
      var oBase = oc * outH * outW;
      for (var oy = 0; oy < outH; oy++) {
        for (var ox = 0; ox < outW; ox++) {
          var sum = b;
          for (var ic = 0; ic < inC; ic++) {
            var iBase = ic * inH * inW;
            var kBase = wBase + ic * 9;
            for (var ky = 0; ky < 3; ky++) {
              var iy = oy * stride - 1 + ky;
              if (iy < 0 || iy >= inH) continue;
              var rowBase = iBase + iy * inW;
              var kRow = kBase + ky * 3;
              for (var kx = 0; kx < 3; kx++) {
                var ix = ox * stride - 1 + kx;
                if (ix < 0 || ix >= inW) continue;
                var v = inp[rowBase + ix];
                if (v !== 0) sum += v * w[kRow + kx];
              }
            }
          }
          outc[oBase + oy * outW + ox] = sum > 0 ? sum : 0;
        }
      }
    }
    return { data: outc, c: outC, h: outH, w: outW };
  }

  function linear(inp, inN, w, bias, outN, relu) {
    var out = new Float32Array(outN);
    for (var o = 0; o < outN; o++) {
      var sum = bias[o];
      var base = o * inN;
      for (var i = 0; i < inN; i++) sum += inp[i] * w[base + i];
      out[o] = relu && sum < 0 ? 0 : sum;
    }
    return out;
  }

  /**
   * @param {object} model 由 train/train.py 导出的 JSON
   */
  function createNet(model) {
    if (!model || model.format !== "suika-value-v1") throw new Error("价值模型格式不正确");
    var L = {};
    for (var k in model.layers) {
      L[k] = b64ToFloat32(model.layers[k].data);
    }
    var gridBytes = CHANNELS * GRID_H * GRID_W;
    var buf = new Uint8Array(gridBytes);
    var inF = new Float32Array(gridBytes);
    var scale = model.targetScale || 1000;
    var lc = model.levelCount || 9;

    var planeN = GRID_H * GRID_W;

    /** 直接喂栅格（0..255 的 Uint8Array），便于与 PyTorch 做数值对齐测试 */
    function predictGrid(gridBytesIn, dropLevel, nextLevel) {
      var occupied = 0;
      for (var i = 0; i < planeN; i++) if (gridBytesIn[i]) occupied++;
      for (var i2 = 0; i2 < gridBytes; i2++) inF[i2] = gridBytesIn[i2] * (1 / 255);
      var denom = lc > 1 ? lc - 1 : 1;
      var a = conv3x3(inF, CHANNELS, GRID_H, GRID_W, L["conv1.weight"], L["conv1.bias"], 16, 2);
      var b = conv3x3(a.data, 16, a.h, a.w, L["conv2.weight"], L["conv2.bias"], 32, 2);
      var c = conv3x3(b.data, 32, b.h, b.w, L["conv3.weight"], L["conv3.bias"], 64, 2);
      var flat = c.c * c.h * c.w;
      var vec = new Float32Array(flat + GLOBALS);
      vec.set(c.data, 0);
      vec[flat] = dropLevel / denom;
      vec[flat + 1] = (nextLevel == null ? denom / 2 : nextLevel) / denom;
      vec[flat + 2] = Math.min(1, occupied / planeN * 8);
      var h1 = linear(vec, flat + GLOBALS, L["fc1.weight"], L["fc1.bias"], 96, true);
      var h2 = linear(h1, 96, L["fc2.weight"], L["fc2.bias"], 48, true);
      var out = linear(h2, 48, L["fc3.weight"], L["fc3.bias"], 1, false);
      return out[0] * scale;
    }

    /**
     * @param {Array} fruits 棋盘水果快照
     * @param {number} dropLevel 即将投放的等级
     * @param {number} nextLevel 再下一个等级（未知时传期望值）
     * @returns {number} 预计还能拿到的分数（已还原到真实分数量级）
     */
    function predict(fruits, dropLevel, nextLevel) {
      rasterize(fruits, lc, buf);
      return predictGrid(buf, dropLevel, nextLevel);
    }

    return { predict: predict, predictGrid: predictGrid, levelCount: lc, model: model };
  }

  return {
    GRID_W: GRID_W, GRID_H: GRID_H, CHANNELS: CHANNELS, GLOBALS: GLOBALS, CELL: CELL,
    WORLD_W: WORLD_W, WORLD_H: WORLD_H,
    rasterize: rasterize,
    createNet: createNet,
    b64ToFloat32: b64ToFloat32,
    conv3x3: conv3x3,
    linear: linear,
  };
});

/*!
 * SuikaBot 浏览器端胶水层
 *
 * 职责：
 *   1. 在不修改站点源码的前提下抓取真实游戏状态
 *        - 拦截 window.Matter 的赋值，包裹 Engine.create 拿到页面里的物理引擎
 *        - 包裹 CanvasRenderingContext2D#drawImage，从瞄准预览/“下一个”预览反推果实等级
 *   2. 通过合成 PointerEvent 驱动页面自己的 input.js（= 真正的“手”）
 *   3. 每步调用 SuikaAI.chooseMove 做前向模拟决策
 *
 * 需要先加载 SuikaAI（window.SuikaAI）。
 */
(function () {
  "use strict";

  if (window.__SUIKA_BOT__ && window.__SUIKA_BOT__.version) return;

  var VERSION = "1.0.0";
  var MIN_R = 15, MAX_R = 78, WORLD_W = 375;

  var CFG = Object.assign({
    autostart: true,
    candidates: 29,
    finalists: 6,
    shortSteps: 78,
    longSteps: 190,
    twoPly: true,
    plyProbes: 3,
    plyXs: 9,
    timeBudgetMs: 700,
    settleSpeed: 0.6,
    settleMaxMs: 2600,
    dangerBudgetMs: 220,
    overlay: true,
    autoRestart: false,
    maxGames: 1,
    submitScore: null,
    submitDelayMs: 1200,
    log: true,
  }, window.__SUIKA_CONFIG__ || {});

  var log = function () {
    if (!CFG.log) return;
    try { console.log.apply(console, ["[suika-bot]"].concat([].slice.call(arguments))); } catch (e) {}
  };
  var now = function () { return performance.now(); };

  // 价值网络（自我训练产物）；没装就自动退回手工启发式
  var valueNet = null;

  function installValueModel() {
    if (!window.SuikaValue) return;
    var m = CFG.valueModel || window.__SUIKA_VALUE_MODEL__ || null;
    if (!m) return;
    if (typeof m === "string") {
      fetch(m).then(function (r) { return r.json(); }).then(function (doc) {
        valueNet = window.SuikaValue.createNet(doc);
        log("已加载价值网络（" + m + "，验证 MAE " + (doc.valMae != null ? doc.valMae : "?") + " 分）");
      }).catch(function (e) { log("价值网络加载失败，继续用启发式:", e.message); });
      return;
    }
    try {
      valueNet = window.SuikaValue.createNet(m);
      log("已加载内嵌价值网络（验证 MAE " + (m.valMae != null ? m.valMae : "?") + " 分）");
    } catch (e) {
      log("价值网络不可用，继续用启发式:", e.message);
    }
  }

  // ---------------------------------------------------------------- 状态
  var MatterRef = null;
  var engineRef = null;
  var aim = { level: null, x: null, at: -1e9 };   // 来自主画布的瞄准预览
  var peek = { level: null, at: -1e9 };           // 来自 #next-canvas
  var dprEst = null;
  var levelCount = 9;
  var state = {
    running: false,
    gamesPlayed: 0,
    drops: 0,
    lastDropAt: -1e9,
    lastDecision: null,
    lastError: null,
    lastScore: 0,
    startedAt: 0,
    simulating: false,   // 为 true 时，新出现的 Engine.create 属于本 bot 的模拟世界，不能当作游戏引擎
    engineCaptured: 0,
    userStopped: false,
    waitingSince: 0,
  };

  // ---------------------------------------------------------------- 钩子
  function levelFromRadius(r) {
    var n = levelCount;
    if (n <= 1) return 0;
    var lv = (n - 1) * Math.log(r / MIN_R) / Math.log(MAX_R / MIN_R);
    return Math.max(0, Math.min(n - 1, Math.round(lv)));
  }

  function levelFromSpriteWidth(w) {
    var best = 0, bestErr = Infinity;
    for (var lv = 0; lv < levelCount; lv++) {
      var d = Math.ceil(window.SuikaAI.radiusForLevel(lv, levelCount) * 2);
      var pred = dprEst ? Math.ceil(d * dprEst) : d;
      var err = Math.abs(pred - w);
      if (err < bestErr) { bestErr = err; best = lv; }
    }
    return best;
  }

  function patchMatter(M) {
    if (!M || !M.Engine || M.__suikaHooked) return;
    var origCreate = M.Engine.create;
    M.Engine.create = function () {
      var eng = origCreate.apply(this, arguments);
      // chooseMove 内部也会 Engine.create()，那些是模拟世界，绝不能覆盖游戏引擎
      if (!state.simulating) {
        engineRef = eng;
        state.engineCaptured++;
        if (state.engineCaptured === 1) log("已接管游戏物理引擎 (matter " + M.version + ")");
      }
      return eng;
    };
    M.__suikaHooked = true;
    MatterRef = M;
  }

  function installMatterHook() {
    if (window.Matter) { patchMatter(window.Matter); return; }
    try {
      Object.defineProperty(window, "Matter", {
        configurable: true,
        enumerable: true,
        get: function () { return MatterRef; },
        set: function (v) { MatterRef = v; try { patchMatter(v); } catch (e) { state.lastError = String(e); } },
      });
      log("已挂载 window.Matter 钩子");
    } catch (e) {
      state.lastError = "Matter 钩子安装失败: " + e;
    }
  }

  function installCanvasHook() {
    var proto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
    if (!proto || proto.__suikaHooked) return;
    var orig = proto.drawImage;
    proto.drawImage = function (img) {
      try {
        var c = this.canvas;
        if (c && c.id === "game-canvas" && this.globalAlpha === 0.85 && arguments.length >= 5) {
          // renderer.js 里瞄准预览是唯一以 0.85 透明度绘制的精灵
          var dw = arguments[3];
          var lv = levelFromRadius(dw / 2);
          aim.level = lv;
          aim.x = arguments[1] + dw / 2;
          aim.at = now();
          if (img && img.width) {
            var d = Math.ceil(window.SuikaAI.radiusForLevel(lv, levelCount) * 2);
            if (d > 0) dprEst = img.width / d;
          }
        } else if (c && c.id === "next-canvas" && img && img.width) {
          peek.level = levelFromSpriteWidth(img.width);
          peek.at = now();
        }
      } catch (e) { /* 钩子绝不打断渲染 */ }
      return orig.apply(this, arguments);
    };
    proto.__suikaHooked = true;
    log("已挂载 canvas 钩子");
  }

  // ---------------------------------------------------------------- 读状态
  function fruitBodies() {
    if (!MatterRef || !engineRef) return [];
    var bodies = MatterRef.Composite.allBodies(engineRef.world);
    var out = [];
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.label !== "fruit" || b.plugin.removed || b.plugin.dead) continue;
      out.push(b);
    }
    return out;
  }

  function snapshot() {
    var bs = fruitBodies();
    var out = new Array(bs.length);
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      out[i] = {
        level: b.plugin.level,
        x: b.position.x,
        y: b.position.y,
        r: b.circleRadius,
        vx: b.velocity.x,
        vy: b.velocity.y,
        av: b.angularVelocity,
        angle: b.angle,
      };
    }
    return out;
  }

  function maxSpeed() {
    var bs = fruitBodies();
    var m = 0;
    for (var i = 0; i < bs.length; i++) {
      var s = Math.abs(bs[i].velocity.x) + Math.abs(bs[i].velocity.y);
      if (s > m) m = s;
    }
    return m;
  }

  function headroom() {
    var bs = fruitBodies();
    var minTop = 1e9;
    for (var i = 0; i < bs.length; i++) {
      var top = bs[i].position.y - bs[i].circleRadius;
      if (top < minTop) minTop = top;
    }
    return minTop === 1e9 ? 999 : minTop - window.SuikaAI.DANGER_Y;
  }

  function hudScore() {
    var el = document.getElementById("hud-score");
    return el ? parseInt(el.textContent, 10) || 0 : 0;
  }

  function overlayVisible() {
    var el = document.getElementById("overlay");
    return !!el && !el.hidden;
  }

  function gameIsOver() {
    if (overlayVisible()) return true;
    var err = document.getElementById("error");
    if (err && !err.hidden) return true;
    // 兜底：引擎存在但没有棋盘（destroy 之后）
    return false;
  }

  // ---------------------------------------------------------------- 动作
  function canvasEl() { return document.getElementById("game-canvas"); }

  function dispatchDrop(worldX) {
    var canvas = canvasEl();
    if (!canvas) return false;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width) return false;
    var scale = rect.width / WORLD_W;
    var clientX = rect.left + worldX * scale;
    var clientY = rect.top + rect.height * 0.5;
    var base = {
      bubbles: true, cancelable: true, composed: true,
      clientX: clientX, clientY: clientY,
      pointerId: 1, pointerType: "mouse", isPrimary: true,
      button: 0, buttons: 1,
    };
    try {
      canvas.dispatchEvent(new PointerEvent("pointerdown", base));
      canvas.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
      return true;
    } catch (e) {
      state.lastError = "派发指针事件失败: " + e;
      return false;
    }
  }

  function restartGame() {
    var btn = document.getElementById("restart-btn");
    if (btn) { btn.click(); return true; }
    return false;
  }

  function submitScore(nickname) {
    var input = document.getElementById("nickname");
    var btn = document.getElementById("submit-btn");
    if (!input || !btn) return false;
    input.value = nickname;
    btn.click();
    log("已提交成绩，昵称 =", nickname);
    return true;
  }

  // ---------------------------------------------------------------- 界面
  var overlayEl = null, markerEl = null;

  function ensureOverlay() {
    if (!CFG.overlay || overlayEl || !document.body) return;
    overlayEl = document.createElement("div");
    overlayEl.id = "suika-bot-overlay";
    overlayEl.style.cssText =
      "position:fixed;left:8px;top:8px;z-index:2147483000;background:rgba(20,20,24,.78);color:#fff;" +
      "font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;padding:7px 10px;border-radius:8px;" +
      "pointer-events:none;white-space:pre;letter-spacing:.2px;";
    markerEl = document.createElement("div");
    markerEl.style.cssText =
      "position:fixed;width:0;border-left:2px dashed rgba(230,57,70,.9);z-index:2147482999;" +
      "pointer-events:none;display:none;";
    document.body.appendChild(overlayEl);
    document.body.appendChild(markerEl);
  }

  function updateOverlay(info) {
    if (!CFG.overlay) return;
    ensureOverlay();
    if (!overlayEl) return;
    overlayEl.textContent = info;
    var canvas = canvasEl();
    var plan = state.planX;
    if (markerEl && canvas && plan != null && !gameIsOver()) {
      var rect = canvas.getBoundingClientRect();
      var scale = rect.width / WORLD_W;
      markerEl.style.display = "block";
      markerEl.style.left = (rect.left + plan * scale) + "px";
      markerEl.style.top = rect.top + "px";
      markerEl.style.height = rect.height + "px";
    } else if (markerEl) {
      markerEl.style.display = "none";
    }
  }

  // ---------------------------------------------------------------- 主循环
  var rafId = null;
  var waitSince = 0;

  function decideAndDrop(danger) {
    var t0 = now();
    if (danger === undefined) danger = headroom() < 40;
    var budget = danger ? CFG.dangerBudgetMs : CFG.timeBudgetMs;
    state.simulating = true;
    var move;
    try {
      move = window.SuikaAI.chooseMove(MatterRef, {
        levelCount: levelCount,
        fruits: snapshot(),
        dropLevel: aim.level,
        nextLevel: now() - peek.at < 1000 ? peek.level : null,
        value: valueNet || undefined,
        candidates: danger ? Math.max(9, Math.round(CFG.candidates / 2)) : CFG.candidates,
        finalists: danger ? 3 : CFG.finalists,
        shortSteps: CFG.shortSteps,
        longSteps: CFG.longSteps,
        twoPly: CFG.twoPly && !danger,
        plyProbes: CFG.plyProbes,
        plyXs: CFG.plyXs,
        timeBudgetMs: budget,
        now: now,
      });
    } finally {
      state.simulating = false;
    }
    state.lastDecision = move;
    state.planX = move.x;

    var ok = dispatchDrop(move.x);
    state.lastDropAt = now();
    if (ok) state.drops++;
    log(
      "投放 #" + state.drops,
      "level=" + aim.level,
      "x=" + move.x.toFixed(1),
      move.usedValue
        ? ("V=" + Math.round(move.evV) + "分 启发式=" + Math.round(move.evH) + " [" + move.evMode + "]")
        : ("ev=" + move.ev.toFixed(1)),
      "候选=" + move.evaluated,
      "决策=" + (now() - t0).toFixed(0) + "ms"
    );
    return ok;
  }

  function frame() {
    rafId = requestAnimationFrame(frame);
    if (!state.running) {
      // 用户手动点了“再来一局”，或 autoRestart 之外的路径开了新一局 → 自动跟上
      if (!state.userStopped && state.overHandled && !overlayVisible() && canvasEl()) {
        state.overHandled = false;
        state.drops = 0;
        state.lastDropAt = -1e9;
        state.gamesPlayed++;
        state.running = true;
        log("检测到新一局，继续游玩");
      }
      return;
    }

    try {
      var ready = MatterRef && engineRef && window.SuikaAI;
      if (!ready) {
        // 常见坑：在页面加载完成后才手工粘贴脚本 → 游戏的引擎早就建好了。
        // 此时点一下“再来一局”就会新建引擎，钩子立刻生效。
        if (MatterRef && !engineRef) {
          if (state.waitingSince === 0) state.waitingSince = now();
          if (now() - state.waitingSince > 2500) {
            updateOverlay("SuikaBot v" + VERSION + "\n已就绪，但还没拿到游戏引擎。\n" +
              "如果你是在页面加载完成后才注入脚本的，\n请点一下页面上的「再来一局」即可开始。");
          }
        }
        return;
      }
      state.waitingSince = 0;

      if (state.startedAt === 0) state.startedAt = now();

      if (gameIsOver()) {
        onGameOver();
        return;
      }
      if (aim.level == null) { updateStatus("等待瞄准预览…"); return; }

      var fresh = now() - aim.at < 150;   // 预览每帧刷新 ⇒ game.canDrop() 为真
      if (!fresh) { waitSince = 0; updateStatus("冷却中…"); return; }

      if (now() - state.lastDropAt < 480) { updateStatus("冷却中…"); return; }

      // 已经在警戒线附近时不再等落定，立刻处理（压线超过 1.2s 就直接输了）
      var danger = headroom() < 40;
      var spd = maxSpeed();
      if (!danger && spd > CFG.settleSpeed) {
        if (waitSince === 0) waitSince = now();
        if (now() - waitSince < CFG.settleMaxMs) { updateStatus("等待落定 (v=" + spd.toFixed(2) + ")…"); return; }
      }
      waitSince = 0;

      decideAndDrop(danger);
      updateStatus("已投放");
      updateOverlay(buildStatusText());
    } catch (e) {
      state.lastError = String(e && e.stack || e);
      log("决策异常", state.lastError);
      updateStatus("异常: " + e);
    }
  }

  function buildStatusText() {
    var m = state.lastDecision;
    return [
      "SuikaBot v" + VERSION + "  " + (state.running ? "运行中" : "已停止"),
      "得分      " + hudScore(),
      "投放次数  " + state.drops,
      "当前/下一个  " + aim.level + " / " + (peek.level == null ? "?" : peek.level),
      "离警戒线  " + Math.round(headroom()) + "px",
      m ? "上次落点  x=" + m.x.toFixed(1) +
          (m.usedValue ? "  V=" + Math.round(m.evV) + "分" : "  ev=" + m.ev.toFixed(1)) +
          "  " + m.evaluated + " 次模拟  " + m.elapsedMs.toFixed(0) + "ms" : "",
      "评估器    " + (valueNet ? "价值网络 V(board)" : "手工启发式"),
      m && m.ranked ? "Top: " + m.ranked.slice(0, 4).map(function (r) { return r.x.toFixed(0); }).join(", ") : "",
      state.lastError ? "err: " + String(state.lastError).slice(0, 60) : "",
    ].filter(Boolean).join("\n");
  }

  function updateStatus(_msg) { updateOverlay(buildStatusText()); }

  function onGameOver() {
    if (state.overHandled) return;
    state.overHandled = true;
    state.running = false;
    state.lastScore = hudScore();
    log("游戏结束，得分 =", state.lastScore, "，投放", state.drops, "次");
    state.planX = null;
    updateOverlay(buildStatusText());
    if (CFG.submitScore) setTimeout(function () { submitScore(CFG.submitScore); }, CFG.submitDelayMs);
    if (CFG.autoRestart && state.gamesPlayed + 1 < (CFG.maxGames || Infinity)) {
      setTimeout(function () {
        state.gamesPlayed++;
        state.overHandled = false;
        state.drops = 0;
        state.lastDropAt = -1e9;
        state.startedAt = 0;
        restartGame();
        state.running = true;
      }, 2500);
    }
  }

  // ---------------------------------------------------------------- 对外 API
  function start() {
    state.userStopped = false;
    if (state.running) return;
    state.running = true;
    state.overHandled = false;
    log("启动");
    if (rafId == null) rafId = requestAnimationFrame(frame);
  }
  function stop() {
    state.running = false;
    state.userStopped = true;
    log("停止");
  }

  function loadLevelCount() {
    try {
      var m = location.pathname.match(/^\/g\/([^/]+)$/);
      if (!m) return Promise.resolve();
      return fetch("/api/games/" + m[1]).then(function (r) { return r.json(); }).then(function (cfg) {
        if (cfg && cfg.level_count) { levelCount = cfg.level_count; }
        window.__SUIKA_BOT__.levelCount = levelCount;
        log("关卡数 =", levelCount, "标题 =", cfg && cfg.title);
      }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  window.__SUIKA_BOT__ = {
    version: VERSION,
    config: CFG,
    state: state,
    start: start,
    stop: stop,
    status: buildStatusText,
    drop: decideAndDrop,
    submit: submitScore,
    restart: restartGame,
    get levelCount() { return levelCount; },
    _internals: { snapshot: snapshot, headroom: headroom, maxSpeed: maxSpeed, fruitBodies: fruitBodies },
  };

  installMatterHook();
  installCanvasHook();
  installValueModel();
  loadLevelCount().then(function () {
    if (CFG.autostart) setTimeout(start, 400);
  });
  log("已注入 v" + VERSION);
})();

