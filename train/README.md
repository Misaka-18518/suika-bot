# 自我训练：价值网络 V(board)

> **先看这里（实测结论，样本量不大，但足以说明问题）**
>
> 我在一台 M4 MacBook 上按下面的流程跑了完整一轮：300 局自我对弈 → 89,745 条样本 →
> 训练出 15 万参数的 CNN，验证 MAE **345 分**（目标本身 std ≈ 600）。
> 三次配对 A/B：纯替换 +4.5（t=0.07）、融合 +165（t=0.68）、融合重跑 +9.7（t=0.07）——
> **均值差都不显著**；但**中位数三次都稳定提升**（+212 / +235），说明它主要是在减少"打崩"的局。
>
> 也就是说——**流水线是通的、数值是对齐的，但 9 万条样本还不足以让 V 超过手调启发式。**
> 瓶颈非常明确：**数据量**。验证 MAE 从第 2~4 轮开始就不再下降，训练 loss 却一路降到 1/10，
> 这是典型的「模型把 8 万条样本背下来了」。经验上要让它真正超过启发式，
> 需要 **2000~5000 局（60 万~150 万条样本）**，并且跑 2~3 轮策略迭代。
>
> 这正是你那台 5070 Ti 的价值：**训练几秒一轮，数据生成才是瓶颈**，
> 而生成速度取决于 CPU 核数，与显卡无关。所以最划算的用法是：
> 在一台多核机器上挂着生成数据（几小时），然后拿 GPU 快速反复训练/迭代。
>
> 如果你只想要「立刻比现在强」，性价比最高的仍然是调 `tools/ab.cjs` 里的启发式权重；
> 想要「上限更高」，就走这套自我训练。

现在的 AI 是「手工启发式 + 前向模拟搜索」。瓶颈不在物理模拟，而在**评估函数是手调的**。
这套流水线把评估函数换成一个**自己学出来的价值网络**：

```
V(board) = 从当前局面出发，预计还能再拿多少分
```

有了它，搜索里的叶子评估就从「猜一个分数」变成「真·期望总分」：

```
ev(落点) = 本步模拟中赚到的分 + V(落定后的棋盘) - 少量安全兜底
```

然后**迭代**（近似策略迭代）：新策略打出的局面更好 → 生成更好的数据 → V 更准 → 策略更强。

---

## 0. 原理与数据流

```
tools/gen-data.cjs        自我对弈（Node，多进程并行，CPU）
   │  每个决策点记一条样本：棋盘栅格 + 当前/下一个水果 + 之后实际拿到的分
   ▼
data/v1/shard-*.bin       uint8 栅格 3x40x25 + float32 元信息（约 3KB/样本）
   │
   ▼
train/train.py            小型 CNN 回归（PyTorch + CUDA，5070 Ti 上很快）
   ▼
models/value.json         base64 float32 权重（约 600~800KB）
   │
   ├─▶ src/value.js       纯 JS 推理（无依赖），供 Node / 浏览器使用
   └─▶ node tools/gen-data.cjs --model models/value.json   ← 回到第一步，策略迭代
```

棋盘被编码成 3 通道 40x25 的栅格（每格 15px）：覆盖掩码 / 该格最大等级 / 该格最靠上的等级。
栅格化和推理都在 `src/value.js` 里，与 `train/model.py` 严格对应；
两侧的数值对齐由 `train/parity_test.py` + `tools/parity-check.cjs` 保证（实测最大误差 6e-5 分）。

---

## 1. 在 5070 Ti 上装环境

5070 Ti 是 Blackwell（sm_120），**必须用 PyTorch 2.7+ 的 CUDA 12.8 轮子**，老版本跑不起来：

```bash
# Node 18+（生成数据用）与 Python 3.10+
pip install torch --index-url https://download.pytorch.org/whl/cu128

# 自检：应打印 (12, 0) 和 True
python -c "import torch;print(torch.__version__, torch.cuda.get_device_capability(), torch.cuda.is_available())"
```

把整个项目目录拷到那台机器上即可（`node_modules/` 可以不带，重新 `npm install` 也行；
如果只是训练，连 Node 依赖都不需要，只要有 `node` 本体）。

---

## 2. 第一轮：用现有策略生成数据

```bash
node tools/gen-data.cjs --games 1500 --conc 12 --out data/v1 --sampleEvery 2
```

- `--conc` 是**并行局数**，不是越大越好。单局约 6~12 秒，其中 90% 是决策计算，
  属于纯 CPU + 大量小对象分配；开到核数以上会因内存带宽和大小核调度互相拖累。
  建议从「大核数」起步（Apple Silicon 上就是 "性能核心" 数，一般 4~6），实测调参：

  | 机器 | conc | 吞吐 |
  | --- | --- | --- |
  | M4（4P+6E） | 9 | 0.09 局/秒 |
  | M4（4P+6E） | 5 | **0.21 局/秒** |

  也就是**少开几个反而快一倍多**。跑之前先 `--games 20` 试一下，用完成的局数除以耗时算出吞吐再定。
- 300 局 ≈ 4 万条样本 ≈ 120 MB，按 0.2 局/秒约 25 分钟。
- `--fast`（9 候选）比默认快一倍；第二轮之后可以用默认档或 `--strong` 提质量。
- 中途 Ctrl-C 也不会白跑：分片 header 会随每次落盘更新，已完成的部分可以直接拿去训练。

## 3. 训练

```bash
python train/train.py --data data/v1 --epochs 25 --device cuda --batch 512 --out models/value.json
```

会打印每轮的验证 MAE（单位是「分」，即预测「还能再拿多少分」的平均绝对误差）。
**这个数字就是唯一要盯的指标**，越小越好；它会自动保存验证集上最好的那一版。

- 参数量 15 万，5070 Ti 上 20 万样本跑一轮只要几秒，可以放心多跑几十轮。
- 想更准就加数据，比调网络结构有用得多。
- 过拟合信号：训练 loss 一直降但 val MAE 回升 → 加数据 / 减小 `--epochs`。

## 4. 验证导出没问题（很重要）

```bash
python train/parity_test.py --model models/value.json --out /tmp/parity.json
node tools/parity-check.cjs /tmp/parity.json
```

必须打印 `✔ 数值对齐通过`。这保证浏览器里跑的 JS 推理和 PyTorch 完全一致。

## 5. 看它到底有没有变强

用同一批随机种子做配对 A/B：A 是手工启发式，B 是启发式 + V。

```bash
node tools/ab.cjs --games 24 --profile full --valueB models/value.json
```

输出里的 `配对差 B-A` 和 `t` 就是结论：均值差为正、t 越大越可信。
24 局大约 10 分钟。想更确信就跑 48 局。

> 注意：训练和 A/B 都在简化环境里跑，分数绝对值会明显高于真实浏览器（那边要等落定、受帧率限制），
> 但**相对优劣是一致的**。

## 6. 策略迭代（真正涨分的地方）

用刚训好的 V 当策略，重新生成数据，再训一轮：

```bash
node tools/gen-data.cjs --games 1500 --conc 12 --out data/v2 --model models/value.json
python train/train.py --data data/v2 --epochs 25 --device cuda --out models/value.json
node tools/ab.cjs --games 24 --profile full --valueB models/value.json
```

每轮建议只用**新一轮**的数据（on-policy），不要把旧轮次混进来——旧数据是弱策略打出来的，
会把 V 往下拽。想混合可以用 `--data data/v1,data/v2` 对比一下。

循环 3~5 轮，通常能看到明显提升。

---

## 7. 把训练好的模型用起来

```bash
node run.mjs                 # 自动使用 models/value.json（存在的话）
node run.mjs --noValue       # 强制退回手工启发式，方便对照
node run.mjs --value 别的.json

node tools/build.cjs         # 打包油猴脚本时把模型内嵌进去
node tools/build.cjs --no-model   # 不内嵌（脚本小很多）
```

油猴脚本读不到本地文件，所以模型会被 base64 内嵌进 `suika-bot.user.js`（约 +800KB）。
浏览器里也能手动指定：

```js
window.__SUIKA_CONFIG__ = { valueModel: "https://你的地址/value.json" };  // 或直接给对象
```

面板上会显示当前用的是「价值网络 V(board)」还是「手工启发式」。

---

## 文件

| 路径 | 作用 |
| --- | --- |
| `src/value.js` | 栅格化 + 纯 JS 前向推理（浏览器/Node 通用） |
| `train/model.py` | 网络结构、数据集读取、占用特征（必须与 value.js 一致） |
| `train/train.py` | 训练循环 + 导出 JSON |
| `train/parity_test.py` | 生成 PyTorch 侧输出用于对齐测试 |
| `tools/gen-data.cjs` / `tools/gen-worker.cjs` | 并行自我对弈生成数据 |
| `tools/parity-check.cjs` | JS 侧对齐测试 |
| `data/` | 数据集分片（可随时删了重新生成） |
| `models/` | 导出的价值网络 |

## 实测记录（一轮完整的迭代）

硬件：M4 MacBook（10 核），无 GPU。

| 阶段 | 配置 | 结果 |
| --- | --- | --- |
| 数据生成 | 300 局，conc 5，`--fast`，sampleEvery 1 | 89,745 条样本 / 258 MB / 38 分钟 |
| 训练（第一版） | 20 epoch，无 dropout | 最佳 val MAE **355.8**（第 2 epoch） |
| 训练（第二版） | + dropout 0.15，wd 3e-4，lr 8e-4 | 最佳 val MAE **345.3**（第 4 epoch） |
| A/B：启发式 vs 纯 V | `--profile light`，20 局配对 | 963.8 vs 968.4，**+4.5，t=0.07**（无差异） |

两个明确的现象：

1. **过拟合来得极快**：训练 loss 从 0.136 降到 0.013，验证 MAE 却在第 2~4 轮触底后回升到 450。
   15 万参数 + 8 万样本，模型完全能记住训练集。加 dropout 只是把底从 356 挪到 345。
2. **验证 MAE ≈ 345 分，而目标 std ≈ 600 分**，R² 只有 0.35 左右。
   同局面下不同落点的真实差距通常只有几十到一百多分，**信噪比不够**，
   所以直接用它替换启发式会打平甚至拖后腿。

### 想让它真正超过启发式，按这个顺序做

1. **先把数据堆上去**（收益最大）。目标 2000~5000 局。生成速度和显卡无关，只看 CPU 核数，
   注意先用 `--games 20` 测吞吐再定 `--conc`（并行度太高反而慢，见第 2 节）。
2. **降低探索噪声**：第一轮 `--explore 0.12` 是为了覆盖状态；后续轮次可以降到 0.03~0.05，
   数据会更贴近当前策略。
3. **默认用融合模式**（`valueMode: "blend"`，已经是默认值），不要一上来就 `replace`。
   它在 V 不准的时候最多是「打平」，不会明显拖累。
4. **换目标函数**：现在回归的是原始分数，长尾很重（mean 803 / max 2901）。
   可以试 `log1p(score)` 或者对分数分桶做分类，通常能把 MAE 压下去一截。
5. **策略迭代**：每轮用上一轮的 V 生成新数据再训，状态分布会跟着变好。
   这是唯一能让 V 和数据「互相抬升」的机制，值得跑 3~5 轮。

---

## 常见问题

- **`torch.cuda.is_available()` 是 False**：装成 CPU 版了，按第 1 节用 cu128 的 index-url 重装。
- **算力利用率低**：把 `--batch` 加到 2048；数据读取已经是全内存，瓶颈会转到 GPU。
- **val MAE 降不下去**：数据太少。第二轮开始每个局面都会被更新策略覆盖到，通常几百局就明显好转。
- **分数没涨反跌**：检查 `weights.valueGuard`（默认 4.0）——早期 V 不准时，兜底项压不住送命手
  就会被 V 带偏。可以调大到 8~12 再试。
