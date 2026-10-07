#!/usr/bin/env python3
"""训练棋盘价值网络 V(board)。

    python train/train.py --data data/v1 --epochs 12 --device cuda
    python train/train.py --data data/v1 --epochs 2 --device cpu --maxSamples 20000 --out models/smoke.json

数据由 node tools/gen-data.cjs 生成；导出的 JSON 直接给 src/value.js 做纯 JS 推理。
"""
from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import (  # noqa: E402
    CHANNELS, GRID_H, GRID_W, LEVEL_COUNT, TARGET_SCALE, ValueNet, ShardReader, occupancy,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def pick_device(name: str) -> torch.device:
    if name == "auto":
        name = "cuda" if torch.cuda.is_available() else "cpu"
    dev = torch.device(name)
    if dev.type == "cuda":
        i = dev.index or 0
        cap = torch.cuda.get_device_capability(i)
        print(f"   GPU: {torch.cuda.get_device_name(i)}  sm_{cap[0]}{cap[1]}  "
              f"显存 {torch.cuda.get_device_properties(i).total_memory / 2**30:.1f} GiB")
    return dev


def load_all(paths: list[str], max_samples: int | None):
    """把全部 shard 拉进内存（uint8 栅格 + float32 元信息），训练时再切片送 GPU。"""
    grids, drops, nexts, targets, score_nows = [], [], [], [], []
    for p in paths:
        r = ShardReader([p])
        n = r.total
        g = np.empty((n, CHANNELS, GRID_H, GRID_W), dtype=np.uint8)
        d = np.empty(n, dtype=np.float32)
        nx = np.empty(n, dtype=np.float32)
        t = np.empty(n, dtype=np.float32)
        s = np.empty(n, dtype=np.float32)
        shard = r.shards[0]
        g[:] = shard["grid"]
        d[:] = shard["drop_level"]
        nx[:] = shard["next_level"]
        t[:] = shard["score_to_go"]
        s[:] = shard["score_now"]
        grids.append(g); drops.append(d); nexts.append(nx); targets.append(t); score_nows.append(s)
    G = np.concatenate(grids); D = np.concatenate(drops); NX = np.concatenate(nexts)
    T = np.concatenate(targets); S = np.concatenate(score_nows)
    if max_samples and len(G) > max_samples:
        idx = np.random.default_rng(0).choice(len(G), max_samples, replace=False)
        G, D, NX, T, S = G[idx], D[idx], NX[idx], T[idx], S[idx]
    return G, D, NX, T, S


def make_glob(G: np.ndarray, D: np.ndarray, NX: np.ndarray, level_count: int) -> np.ndarray:
    denom = max(1, level_count - 1)
    return np.stack([D / denom, NX / denom, occupancy(G)], axis=1).astype(np.float32)


def evaluate(net, G, X, T, dev, batch=2048):
    """T 是真实分数（未缩放）；网络输出是缩放后的，这里还原回真实分数再算 MAE/RMSE。"""
    net.eval()
    preds = []
    with torch.no_grad():
        for i in range(0, len(G), batch):
            g = torch.from_numpy(G[i:i + batch].astype(np.float32) / 255.0).to(dev)
            x = torch.from_numpy(X[i:i + batch]).to(dev)
            preds.append(net(g, x).float().cpu())
    p = torch.cat(preds).numpy() * TARGET_SCALE
    t = np.asarray(T, dtype=np.float32)
    return float(np.mean(np.abs(p - t))), float(np.sqrt(np.mean((p - t) ** 2))), p, t


def export_json(net, path, level_count, extra):
    layers = {}
    for k, v in net.state_dict().items():
        arr = v.detach().cpu().numpy().astype("<f4")
        layers[k] = {
            "shape": list(arr.shape),
            "data": base64.b64encode(arr.tobytes()).decode("ascii"),
        }
    doc = {
        "format": "suika-value-v1",
        "levelCount": level_count,
        "gridW": GRID_W, "gridH": GRID_H, "channels": CHANNELS,
        "targetScale": TARGET_SCALE,
        **extra,
        "layers": layers,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/v1", help="包含 shard-*.bin 的目录（可多个，逗号分隔）")
    ap.add_argument("--out", default="models/value.json")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--wd", type=float, default=1e-5)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--valShards", type=int, default=1, help="留出最后 N 个 shard 做验证")
    ap.add_argument("--maxSamples", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    dirs = [d for d in args.data.split(",") if d]
    files: list[str] = []
    for d in dirs:
        files += sorted(glob.glob(os.path.join(ROOT, d, "shard-*.bin")))
    if not files:
        raise SystemExit(f"在 {args.data} 里找不到 shard-*.bin，先跑 node tools/gen-data.cjs")

    val_files = files[-args.valShards:] if args.valShards > 0 and len(files) > args.valShards else []
    train_files = files[: len(files) - len(val_files)]
    print(f"→ 训练分片 {len(train_files)} 个，验证分片 {len(val_files)} 个")

    t0 = time.time()
    Gtr, Dtr, Ntr, Ttr, _ = load_all(train_files, args.maxSamples or None)
    Xtr = make_glob(Gtr, Dtr, Ntr, LEVEL_COUNT)
    print(f"   训练样本 {len(Gtr)}  得分目标 mean={Ttr.mean():.0f} median={np.median(Ttr):.0f} max={Ttr.max():.0f}")
    if val_files:
        Gva, Dva, Nva, Tva, _ = load_all(val_files, None)
        Xva = make_glob(Gva, Dva, Nva, LEVEL_COUNT)
        print(f"   验证样本 {len(Gva)}")
    else:
        # 没有留出分片就随机切 10%
        n = len(Gtr); cut = int(n * 0.9)
        perm = np.random.permutation(n)
        tr, va = perm[:cut], perm[cut:]
        Gva, Xva, Tva = Gtr[va], Xtr[va], Ttr[va]
        Gtr, Xtr, Ttr = Gtr[tr], Xtr[tr], Ttr[tr]
    print(f"   载入耗时 {time.time() - t0:.1f}s")

    dev = pick_device(args.device)
    net = ValueNet().to(dev)
    nparam = sum(p.numel() for p in net.parameters())
    print(f"   参数量 {nparam:,}（导出约 {nparam * 4 * 4 / 3 / 1024:.0f} KB base64）")

    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=args.wd)
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=args.lr, total_steps=max(1, args.epochs * (len(Gtr) // args.batch + 1)), pct_start=0.25
    )
    lossf = nn.HuberLoss(delta=0.35)   # 目标已除以 TARGET_SCALE

    Gt = torch.from_numpy(Gtr)
    Xt = torch.from_numpy(Xtr)
    Tt = torch.from_numpy(Ttr / TARGET_SCALE).float()
    best = float("inf")

    for ep in range(1, args.epochs + 1):
        net.train()
        perm = np.random.permutation(len(Gt))
        run, nb = 0.0, 0
        te = time.time()
        for i in range(0, len(perm), args.batch):
            idx = perm[i:i + args.batch]
            g = Gt[idx].to(dev).float() / 255.0
            x = Xt[idx].to(dev)
            y = Tt[idx].to(dev)
            pred = net(g, x)
            loss = lossf(pred, y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            run += loss.item(); nb += 1
        mae, rmse, _, _ = evaluate(net, Gva, Xva, Tva, dev)
        flag = ""
        if mae < best:
            best = mae
            flag = "  ← best"
            export_json(net, args.out, LEVEL_COUNT, {"valMae": round(mae, 2), "epoch": ep})
        print(f"  epoch {ep:2d}/{args.epochs}  loss {run / max(1, nb):.4f}  "
              f"val MAE {mae:7.1f} 分  RMSE {rmse:7.1f}  {time.time() - te:.1f}s{flag}")

    print(f"\n✔ 完成，最佳验证 MAE {best:.1f} 分，模型已写到 {args.out}")
    print("  下一步：node tools/gen-data.cjs --model " + args.out + " ...  生成下一轮数据（策略迭代）")


if __name__ == "__main__":
    main()
