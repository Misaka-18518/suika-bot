#!/usr/bin/env python3
"""PyTorch ↔ 纯 JS 推理的数值对齐测试。

    python train/parity_test.py --model models/value.json --out /tmp/parity.json

会在 /tmp/parity.json 里写出 N 组随机输入与 PyTorch 的输出；
再跑 node tools/parity-check.cjs /tmp/parity.json 比较 JS 端结果。
两边必须一致到 1e-3 以内（float32 累计误差），否则说明 JS 的卷积/全连接实现与 PyTorch 不一致。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import CHANNELS, GRID_H, GRID_W, TARGET_SCALE, ValueNet  # noqa: E402


def net_from_export(doc: dict) -> ValueNet:
    net = ValueNet()
    sd = {}
    for k, v in doc["layers"].items():
        raw = base64.b64decode(v["data"])
        arr = np.frombuffer(raw, dtype="<f4").reshape(v["shape"]).copy()
        sd[k] = torch.from_numpy(arr)
    net.load_state_dict(sd)
    net.eval()
    return net


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="models/value.json")
    ap.add_argument("--out", default="/tmp/parity.json")
    ap.add_argument("--n", type=int, default=12)
    args = ap.parse_args()

    with open(args.model, encoding="utf-8") as fh:
        doc = json.load(fh)
    net = net_from_export(doc)
    print(f"从 {args.model} 重建网络成功（{len(doc['layers'])} 个张量）")

    rng = np.random.default_rng(1234)
    cases = []
    for i in range(args.n):
        # 造一些「像棋盘」的输入：底部若干圆填满
        grid = np.zeros((CHANNELS, GRID_H, GRID_W), dtype=np.uint8)
        nf = int(rng.integers(3, 25))
        for _ in range(nf):
            lvl = int(rng.integers(0, 9))
            r = 15 * (78 / 15) ** (lvl / 8)
            cx = float(rng.uniform(r, 375 - r))
            top = max(r, 600.0 - r - 260.0)          # 只在棋盘下半部分乱撒
            cy = float(rng.uniform(top, 600 - r))
            gx0, gx1 = max(0, int((cx - r) // 15)), min(GRID_W - 1, int((cx + r) // 15))
            gy0, gy1 = max(0, int((cy - r) // 15)), min(GRID_H - 1, int((cy + r) // 15))
            lv8 = max(1, round(255 * lvl / 8))
            for gy in range(gy0, gy1 + 1):
                for gx in range(gx0, gx1 + 1):
                    dx, dy = (gx + .5) * 15 - cx, (gy + .5) * 15 - cy
                    if dx * dx + dy * dy <= r * r:
                        grid[0, gy, gx] = 255
                        grid[1, gy, gx] = max(grid[1, gy, gx], lv8)
                        grid[2, gy, gx] = max(grid[2, gy, gx], lv8)
        drop = float(rng.integers(0, 5))
        nxt = float(rng.integers(0, 5))
        occ = min(1.0, float((grid[0] != 0).sum()) / (GRID_H * GRID_W) * 8.0)
        glob = np.array([drop / 8.0, nxt / 8.0, occ], dtype=np.float32)
        g = torch.from_numpy(grid.astype(np.float32)[None] / 255.0)
        with torch.no_grad():
            out = float(net(g, torch.from_numpy(glob[None]))[0]) * TARGET_SCALE
        cases.append({
            "grid": base64.b64encode(grid.tobytes()).decode("ascii"),
            "drop": drop, "next": nxt,
            "expect": out,
        })

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"model": args.model, "cases": cases}, fh)
    print(f"已写出 {len(cases)} 组测试用例 → {args.out}")
    print("期望值示例:", [round(c["expect"], 2) for c in cases[:5]])


if __name__ == "__main__":
    main()
