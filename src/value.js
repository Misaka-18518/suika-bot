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
