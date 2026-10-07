/*!
 * 无头游戏复刻：与站点 static/js/engine.js 的行为逐行对应，
 * 用同一份 matter-js 0.19.0 构建跑物理，用于离线快速调参与基准测试。
 */
"use strict";

const Matter = require("../vendor/matter.min.cjs");
const AI = require("../src/ai.js");

const { Engine, World, Bodies, Body, Composite, Events } = Matter;

const WORLD_W = 375;
const WORLD_H = 600;
const DANGER_Y = 110;
const DROP_Y = 50;
const STEP_MS = 1000 / 60;
const DROP_COOLDOWN_MS = 450;
const GAME_OVER_MS = 1200;

function dropLevelFor(levelCount) {
  const max = Math.min(4, levelCount - 2);
  return Math.floor(Math.random() * (max + 1));
}

class SimGame {
  constructor(levelCount) {
    this.levelCount = levelCount;
    this.engine = Engine.create();
    this.engine.gravity.y = 1;
    this.score = 0;
    this.maxLevel = 0;
    this.vanished = 0;
    this.over = false;
    this.now = 0;
    this.currentLevel = dropLevelFor(levelCount);
    this.nextLevel = dropLevelFor(levelCount);
    this.lastDropAt = -1e9;
    this.dropCount = 0;
    this.mergeQueue = [];
    this.consumed = new Set();
    this.dangerSince = null;
    this._buildWalls();
    Events.on(this.engine, "collisionStart", (evt) => this._onCollide(evt));
  }

  _buildWalls() {
    const t = 200;
    World.add(this.engine.world, [
      Bodies.rectangle(WORLD_W / 2, WORLD_H + t / 2, WORLD_W + t * 2, t, { isStatic: true }),
      Bodies.rectangle(-t / 2, WORLD_H / 2, t, WORLD_H * 3, { isStatic: true }),
      Bodies.rectangle(WORLD_W + t / 2, WORLD_H / 2, t, WORLD_H * 3, { isStatic: true }),
    ]);
  }

  _onCollide(evt) {
    for (const pair of evt.pairs) {
      const a = pair.bodyA, b = pair.bodyB;
      if (a.label !== "fruit" || b.label !== "fruit") continue;
      if (a.plugin.level !== b.plugin.level) continue;
      if (this.consumed.has(a.id) || this.consumed.has(b.id)) continue;
      if (a.plugin.dead || b.plugin.dead) continue;
      this.consumed.add(a.id);
      this.consumed.add(b.id);
      a.plugin.dead = true;
      b.plugin.dead = true;
      this.mergeQueue.push({ a, b, level: a.plugin.level });
    }
  }

  _makeFruit(level, x, y) {
    const body = Bodies.circle(x, y, AI.radiusForLevel(level, this.levelCount), {
      label: "fruit",
      restitution: 0.2,
      friction: 0.5,
      frictionStatic: 0.6,
      density: 0.001,
    });
    body.plugin = { kind: "fruit", level, bornAt: this.now, overTime: 0, dead: false, removed: false };
    World.add(this.engine.world, body);
    return body;
  }

  _processMerges() {
    for (const { a, b, level } of this.mergeQueue) {
      if (a.plugin.removed || b.plugin.removed) continue;
      World.remove(this.engine.world, a);
      World.remove(this.engine.world, b);
      a.plugin.removed = true;
      b.plugin.removed = true;
      const mx = (a.position.x + b.position.x) / 2;
      const my = (a.position.y + b.position.y) / 2;
      if (level >= this.levelCount - 1) {
        this.score += this.levelCount * 2;
        this.vanished += 1;
        continue;
      }
      const newLevel = level + 1;
      const body = this._makeFruit(newLevel, mx, my);
      Body.setVelocity(body, { x: (a.velocity.x + b.velocity.x) * 0.5, y: (a.velocity.y + b.velocity.y) * 0.5 });
      this.maxLevel = Math.max(this.maxLevel, newLevel);
      this.score += newLevel + 1;
    }
    this.mergeQueue = [];
    if (this.consumed.size > 200) this.consumed.clear();
  }

  _checkDanger() {
    let anyOver = false;
    for (const body of Composite.allBodies(this.engine.world)) {
      if (body.label !== "fruit" || body.plugin.dead || body.plugin.removed) continue;
      const r = body.circleRadius;
      const overLine = body.position.y - r < DANGER_Y;
      const age = this.now - body.plugin.bornAt;
      if (overLine && age > 800) {
        anyOver = true;
        body.plugin.overTime += STEP_MS;
      } else {
        body.plugin.overTime = 0;
      }
      if (body.plugin.overTime > GAME_OVER_MS) {
        this.over = true;
        return;
      }
    }
    if (anyOver && this.dangerSince === null) this.dangerSince = this.now;
    else if (!anyOver) this.dangerSince = null;
  }

  canDrop() {
    return !this.over && this.now - this.lastDropAt >= DROP_COOLDOWN_MS;
  }

  drop(x) {
    if (!this.canDrop()) return false;
    const level = this.currentLevel;
    this._makeFruit(level, x, DROP_Y);
    this.maxLevel = Math.max(this.maxLevel, level);
    this.lastDropAt = this.now;
    this.currentLevel = this.nextLevel;
    this.nextLevel = dropLevelFor(this.levelCount);
    this.dropCount++;
    return true;
  }

  step() {
    if (this.over) return;
    Engine.update(this.engine, STEP_MS);
    this._processMerges();
    this._checkDanger();
    this.now += STEP_MS;
  }

  snapshot() {
    const out = [];
    for (const b of Composite.allBodies(this.engine.world)) {
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

  maxSpeed() {
    let m = 0;
    for (const b of Composite.allBodies(this.engine.world)) {
      if (b.label !== "fruit" || b.plugin.removed || b.plugin.dead) continue;
      const s = Math.abs(b.velocity.x) + Math.abs(b.velocity.y);
      if (s > m) m = s;
    }
    return m;
  }

  /** 最高果实顶部到警戒线的余量（px，正数 = 安全） */
  headroom() {
    let minTop = WORLD_H;
    for (const b of Composite.allBodies(this.engine.world)) {
      if (b.label !== "fruit" || b.plugin.removed || b.plugin.dead) continue;
      const top = b.position.y - b.circleRadius;
      if (top < minTop) minTop = top;
    }
    return minTop - DANGER_Y;
  }
}

module.exports = { SimGame, Matter, AI, WORLD_W, WORLD_H, DANGER_Y, DROP_Y, STEP_MS, DROP_COOLDOWN_MS, dropLevelFor };
