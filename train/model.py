"""棋盘价值网络 V(board)。

结构必须与 src/value.js 的 createNet() 严格一致：
    conv(3→16,k3,s2,p1)+ReLU
    conv(16→32,k3,s2,p1)+ReLU
    conv(32→64,k3,s2,p1)+ReLU
    flatten(64*5*4=1280) ⊕ 全局特征(3)
    fc(1283→96)+ReLU → fc(96→48)+ReLU → fc(48→1)

输入栅格由 JS 端 src/value.js 的 rasterize() 生成并落盘，Python 只负责读。
"""
from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn

GRID_W = 25
GRID_H = 40
CHANNELS = 3
GLOBALS = 3
LEVEL_COUNT = 9
TARGET_SCALE = 1000.0
HEADER_BYTES = 32
MAGIC = b"SKD1"


class ValueNet(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(CHANNELS, 16, 3, stride=2, padding=1)
        self.conv2 = nn.Conv2d(16, 32, 3, stride=2, padding=1)
        self.conv3 = nn.Conv2d(32, 64, 3, stride=2, padding=1)
        self.fc1 = nn.Linear(64 * 5 * 4 + GLOBALS, 96)
        self.fc2 = nn.Linear(96, 48)
        self.fc3 = nn.Linear(48, 1)
        # Dropout 只在训练时生效，导出/推理阶段是完全的恒等映射，
        # 所以加了它也不用改 src/value.js
        self.drop = nn.Dropout(0.15)

    def forward(self, grid: torch.Tensor, glob: torch.Tensor) -> torch.Tensor:
        x = torch.relu(self.conv1(grid))
        x = torch.relu(self.conv2(x))
        x = torch.relu(self.conv3(x))
        x = x.flatten(1)
        x = torch.cat([x, glob], dim=1)
        x = self.drop(torch.relu(self.fc1(x)))
        x = self.drop(torch.relu(self.fc2(x)))
        return self.fc3(x).squeeze(1)


# ------------------------------------------------------------------ 数据读取
RECORD_DTYPE = np.dtype(
    [
        ("score_now", "<f4"),
        ("score_to_go", "<f4"),
        ("drop_level", "<f4"),
        ("next_level", "<f4"),
        ("grid", "u1", (CHANNELS, GRID_H, GRID_W)),
    ]
)


def read_header(path: str) -> dict:
    with open(path, "rb") as fh:
        raw = fh.read(HEADER_BYTES)
    if raw[:4] != MAGIC:
        raise ValueError(f"{path}: 不是 SuikaAI 数据集（magic 不匹配）")
    ver, gw, gh, ch, lc, rec, cnt = np.frombuffer(raw[4:32], dtype="<u4")
    return dict(version=int(ver), grid_w=int(gw), grid_h=int(gh), channels=int(ch),
                level_count=int(lc), record_bytes=int(rec), count=int(cnt))


def occupancy(grids: np.ndarray) -> np.ndarray:
    """通道 0 被覆盖的格子占比 × 8（截断到 1）。必须与 src/value.js 完全一致。"""
    cov = (grids[:, 0] != 0).reshape(len(grids), -1).sum(axis=1).astype(np.float32)
    return np.minimum(1.0, cov / (GRID_H * GRID_W) * 8.0)


class ShardReader:
    """把若干 shard 当作一个大的随机访问数据集（memmap，不占内存）。"""

    def __init__(self, paths: list[str]) -> None:
        self.shards = []
        total = 0
        for p in paths:
            h = read_header(p)
            if h["record_bytes"] != RECORD_DTYPE.itemsize:
                raise ValueError(f"{p}: 记录长度 {h['record_bytes']} != {RECORD_DTYPE.itemsize}")
            arr = np.memmap(p, dtype=RECORD_DTYPE, mode="r", offset=HEADER_BYTES, shape=(h["count"],))
            self.shards.append(arr)
            total += h["count"]
        if total == 0:
            raise ValueError("数据集为空")
        # 累积偏移，便于按全局下标取样本
        self.cum = np.cumsum([0] + [len(s) for s in self.shards])
        self.total = int(total)
        self.level_count = read_header(paths[0])["level_count"]

    def batch(self, idx: np.ndarray) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """idx: 全局下标数组 → (grid, glob, target)"""
        grids = np.empty((len(idx), CHANNELS, GRID_H, GRID_W), dtype=np.uint8)
        drops = np.empty(len(idx), dtype=np.float32)
        nexts = np.empty(len(idx), dtype=np.float32)
        targets = np.empty(len(idx), dtype=np.float32)
        for s_i, shard in enumerate(self.shards):
            lo, hi = self.cum[s_i], self.cum[s_i + 1]
            sel = (idx >= lo) & (idx < hi)
            if not sel.any():
                continue
            local = idx[sel] - lo
            chunk = shard[local]
            grids[sel] = chunk["grid"]
            drops[sel] = chunk["drop_level"]
            nexts[sel] = chunk["next_level"]
            targets[sel] = chunk["score_to_go"]
        denom = max(1, self.level_count - 1)
        glob = np.stack([drops / denom, nexts / denom, occupancy(grids)], axis=1).astype(np.float32)
        g = torch.from_numpy(grids.astype(np.float32) / 255.0)
        return g, torch.from_numpy(glob), torch.from_numpy(targets / TARGET_SCALE)


def glob_from_meta(drops: np.ndarray, nexts: np.ndarray, grids: np.ndarray, level_count: int) -> np.ndarray:
    denom = max(1, level_count - 1)
    return np.stack([drops / denom, nexts / denom, occupancy(grids)], axis=1).astype(np.float32)
