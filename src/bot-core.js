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
