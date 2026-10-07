# 合成大西瓜 · AI 自动游玩 (Suika Bot)

给 [https://dxg.calyx.site/g/FgyFHY2p](https://dxg.calyx.site/g/FgyFHY2p)（合成呜呜药物，9 级链条）写的自动游玩程序。

> **在 Windows 上部署？** 直接看 **[AGENT-WINDOWS.md](AGENT-WINDOWS.md)** ——
> 那是一份写给 AI agent 的逐步手册，含验收命令、GPU 环境、以及这个项目在 Windows 上的所有坑。
> 本文档是原理与总览。

它**不修改站点源码、不伪造分数**：在真实页面里用真实物理引擎读状态，用合成指针事件驱动页面自己的
`input.js` 投放水果，走的完全是官方那套判定与计分。

## 实测结果

| 项目 | 结果 |
| --- | --- |
| **真实浏览器完整一局**（无头 Chrome，站点真实物理与判定） | **1950 分 / 439 次投放 / 约 10 分钟**（当时榜单第 1 名是 1787） |
| 离线评测（full 档位，8 局，600 次投放上限） | 平均 **1570.9**，中位 1584，最高 2846 |
| 决策开销 | 每次 120 ~ 300ms；濒临警戒线时自动降到 ~220ms 预算 |

离线分数普遍高于实时对战，因为离线是 CPU 满速、不等落定；实时一局受真实帧率与
等待策略影响。截图见 `shots/final.png`（游戏结束面板显示 1950）。

### 关键改动的 A/B 实测（配对同种子）

| 对比 | A 平均分 | B 平均分 | 配对差 |
| --- | --- | --- | --- |
| 评估函数：绝对堆积高度 → 堆积余高 + 逆序惩罚 | 979.9 | **1035.2** | +55.3 |
| 决策档位：light(17 候选/无预报) → full(29 候选 + 两步预报) | 912.8 | **962.3** | +49.5 |
| 评估器：手工启发式 → 启发式 + 价值网络融合（24 局 / full） | 1512.0 | **1677.2** | +165.1（t=0.68） |
| 同上（32 局 / light，修好落定判定后重跑） | 1400.6 | **1410.3** | +9.7（t=0.07） |

**关于价值网络要如实说明**：三次 A/B 里均值差都没到显著，但**中位数三次都稳定提升**
（1304→1516、1261→**1496**）。分数分布长尾极重（几十局里会蹦出 2800+ 的局），
均值被这些局主导所以噪声巨大；中位数持续变好说明它确实减少了"打崩"的局。
结论：**当前这批数据训出来的 V 只能算「不亏」，还不足以稳定超过手调启发式**，
原因和下一步做法写在 [train/README.md](train/README.md)。

---

## 快速开始

```bash
# 1. 装依赖（首次，已装过可跳过）
npm install

# 2. 无头跑一局，跑完打印得分并截图
npm run play

# 3. 想看着它玩（弹出浏览器窗口，结束后保持打开）
npm run watch

# 4. 连打 3 局
npm run play3
```

等价的原生命令是 `node run.mjs`（`suika-bot.user.js` 缺失或比源文件旧时会自动重新打包）：

| npm 别名 | 等价命令 | 说明 |
| --- | --- | --- |
| `npm run play` | `node run.mjs` | 无头跑一局 |
| `npm run watch` | `node run.mjs --headed --keepOpen` | 显示窗口观看 |
| `npm run play3` | `node run.mjs --games 3 --autoRestart` | 连打 3 局 |
| `npm run build` | `node tools/build.cjs` | 只重新生成油猴脚本 |
| `npm run bench` | 离线 8 局基准 | 评测当前 AI 强度 |
| `npm run tune` | `node tools/tune.cjs` | 离线跑对局看分布 |

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--headed` | 显示浏览器窗口 |
| `--games N --autoRestart` | 连打 N 局 |
| `--timeout 秒` | 最长运行时间（默认 900） |
| `--url <地址>` | 换一个游戏实例（任意 `/g/<id>`） |
| `--nickname 名字` | **可选**：结束后自动把成绩提交到排行榜 |
| `--candidates N` `--budget ms` `--noTwoPly` | 调整 AI 的算力预算 |

### 在自己的浏览器里用（油猴脚本）

**`suika-bot.user.js`** 就是成品（运行 `npm run build` 可重新生成）：

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey；
2. 新建脚本 → 把 `suika-bot.user.js` 的内容整个粘进去 → 保存；
3. 打开 `https://dxg.calyx.site/g/FgyFHY2p` → 自动开始玩，左上角有实时状态面板，
   红色虚线是它准备投放的位置。

> 没有油猴也行：打开游戏页 → F12 → Console → 粘贴脚本内容回车 → **再点一下页面上的「再来一局」**。
> 之所以要多点这一下：脚本必须在页面加载前装好钩子才能接管游戏的物理引擎；事后注入时引擎已经建好，
> 点「再来一局」会新建引擎，钩子立刻生效（面板上也会显示这句提示）。

也可以在控制台直接改配置（改完刷新页面）：

```js
window.__SUIKA_CONFIG__ = {
  autostart: true,
  overlay: true,
  autoRestart: true,     // 结束后自动再来一局
  submitScore: null,     // 填昵称则自动提交成绩
  candidates: 29,        // 每步评估的候选落点数
  timeBudgetMs: 700,     // 每次决策的时间上限
};
```

页面里还有 `window.__SUIKA_BOT__`：`start() / stop() / status() / drop() / submit(nick)`。

---

## 它是怎么玩的

```
真实页面                      SuikaBot                         SuikaAI（纯计算）
─────────────                ──────────────                   ──────────────────
window.Matter  ──钩子──▶  抓取页面物理引擎
                                                             ┌─ 复制当前棋盘
#game-canvas  ──钩子──▶  从瞄准预览反推               ──▶  │  逐个候选落点前向模拟
                         当前水果等级 / 落点                │  （Matter 0.19.0，与页面同款）
                                                                  │
input.js  ◀──合成 pointerdown/up──  最优落点  ◀──────────────────┘ 打分
```

1. **抓状态**（不改站点代码）
   - 在 `document-start` 用 `Object.defineProperty(window,'Matter')` 接住 UMD 赋值，包裹
     `Matter.Engine.create`，从而拿到页面自己的物理引擎 → 全部水果的坐标/速度/等级/半径。
   - 包裹 `CanvasRenderingContext2D.drawImage`：`renderer.js` 里瞄准预览是唯一用
     `globalAlpha = 0.85` 绘制的精灵，从它的目标宽度反解出 `currentLevel`（
     `radiusForLevel` 是单调的，可精确反解）；`#next-canvas` 的绘制则给出下一个水果等级。
   - 决策时内部会跑模拟引擎，所以钩子里用 `state.simulating` 标记把二者区分开，
     避免把模拟世界误当成游戏世界。

2. **前向模拟**：用同一份 matter-js 0.19.0（`vendor/matter.min.cjs` 取自站点 `static/vendor/`）
   重建一个世界：同样的三面墙、同样的 `restitution/friction/density`、同样的
   `collisionStart` 同级别合并逻辑与 `_processMerges`（含“两个满级双双消失、给两倍分”）。
   把当前棋盘按位置/速度/角度灌进去，加上候选水果，按 60Hz 步进到落定。

3. **打分**：两种评估器，二选一。
   - **手工启发式**（默认兜底）：合成得分 + 棋盘形态。惩罚最高堆积高度、越过警戒线的像素量、
     堆积余高、逆序（大压小）、未落定速度；鼓励大果实沉底、同级别相邻。
   - **价值网络 V(board)**（自我训练的产物，见 `train/README.md`）：把棋盘栅格化后过一个小 CNN，
     直接预测"这个局面还能再拿多少分"，叶子评估变成 `本步得分 + V(落定后的棋盘)`。
     存在 `models/value.json` 时自动启用，启发式退居粗筛与安全兜底。

4. **出手**：粗筛（默认 29~33 个落点，短模拟）→ 入围者长模拟 → 可选两步预判
   （用已知的下一颗水果评估最坏情况）。然后给 `#game-canvas` 派发
   `pointerdown` + `pointerup`，页面自己的 `input.js` 会 `setAimX` + `drop()`。
   出手前会确认瞄准预览仍在逐帧刷新（即 `game.canDrop()` 为真），且棋盘基本落定。

---

## 目录

| 路径 | 作用 |
| --- | --- |
| `suika-bot.user.js` | **成品**：单文件油猴脚本（由 build 生成，也是 run.mjs 注入的内容） |
| `src/ai.js` | 决策核心：模拟世界 + 棋盘评估 + `chooseMove`（UMD，浏览器/Node 通用） |
| `src/value.js` | 价值网络 V(board)：棋盘栅格化 + 纯 JS 前向推理 |
| `src/bot-core.js` | 浏览器胶水：状态钩子 + 指针事件 + 主循环 + 状态面板 |
| `run.mjs` | Playwright 驱动真实浏览器自动游玩 |
| `tools/build.cjs` | 拼接源文件、可选内嵌模型，生成 `suika-bot.user.js` |
| `tools/sim-game.cjs` | 站点 `engine.js` 的无头复刻（逐行对应），供离线评测 |
| `tools/tune.cjs` | 离线跑完整对局、统计得分 |
| `tools/ab.cjs` | 同种子配对 A/B（换权重、换档位、换评估器） |
| `tools/gen-data.cjs` | 并行自我对弈，生成价值网络训练数据 |
| `tools/parity-check.cjs` | 校验 JS 推理与 PyTorch 数值一致 |
| `train/` | PyTorch 训练流水线，见 `train/README.md` |
| `vendor/matter.min.cjs` | 站点同款 matter-js 0.19.0 |

---

## 自我训练（价值网络）

手工启发式是有上限的。项目里带了一套完整的**自我训练流水线**，把评估函数换成学出来的价值网络：

```bash
# 1. 自我对弈生成数据（Node，多进程，CPU）
node tools/gen-data.cjs --games 1500 --conc 12 --out data/v1

# 2. 训练（PyTorch + CUDA；5070 Ti 上一轮几秒）
python train/train.py --data data/v1 --epochs 25 --device cuda --out models/value.json

# 3. 校验 JS 推理与 PyTorch 数值一致
python train/parity_test.py --model models/value.json --out /tmp/parity.json
node tools/parity-check.cjs /tmp/parity.json

# 4. 配对 A/B 看有没有变强
node tools/ab.cjs --games 24 --profile full --valueB models/value.json

# 5. 用新策略再生成数据 → 策略迭代
node tools/gen-data.cjs --games 1500 --conc 12 --out data/v2 --model models/value.json
```

```bash
# 6. 用起来
node run.mjs                      # 自动加载 models/value.json
node run.mjs --noValue            # 强制退回手工启发式做对照
node tools/build.cjs              # 内嵌模型打包成油猴脚本（+790KB）
```

**第一轮的实测结论**（M4 MacBook，300 局 / 8.97 万条样本）：

| 指标 | 结果 |
| --- | --- |
| 验证 MAE | **345 分**（目标 std ≈ 600） |
| 纯 V 替换启发式 | 打平（+4.5 分，t=0.07） |
| 启发式 + V 融合（24 局） | 1512.0 → **1677.2**（+165 分，中位 1304 → 1516） |

也就是说：**流水线通了，但 9 万条样本还不足以让 V 稳定超过手调启发式**——瓶颈是数据量，
不是网络结构（训练 loss 一路降到 1/10，验证 MAE 第 2~4 轮就触底回升，是典型过拟合）。
要真正拉开差距，需要 2000~5000 局 + 2~3 轮策略迭代。具体怎么调、每一步注意什么，
见 **[train/README.md](train/README.md)**。

训练好之后 `node run.mjs` 会自动使用 `models/value.json`（`--noValue` 可强制退回启发式），
`node tools/build.cjs` 会把它内嵌进油猴脚本。

网络结构、数据格式、5070 Ti 的 Blackwell/cu128 安装要点、调参与迭代建议，全部写在
**[train/README.md](train/README.md)**。

---

## 离线评测与调参

因为决策逻辑与 DOM 无关，可以在 Node 里用同一份物理以 CPU 满速跑完整对局，比在浏览器里实时跑快得多：

```bash
node tools/tune.cjs --games 8 --verbose                        # 跑 8 局，打印分布
node tools/tune.cjs --games 8 --weights '{"gain":60}'          # 换一组权重
node tools/search.cjs --games 6 --passes 2                     # 并行坐标下降搜索
```

调参结果写到 `tools/best-weights.json`，把它塞进 `window.__SUIKA_CONFIG__.weights`（或 `run.mjs --weights`）即可。

---

## 注意

- **排行榜**：默认不会提交成绩。加 `--nickname` 或 `submitScore` 才会点页面上的
  “提交成绩”按钮上榜 —— 请自行判断是否愿意让 AI 的成绩出现在公开榜单上。
- 决策在主线程同步执行（默认 0.1~0.4 秒/次），会短暂占用页面帧；用 `--budget` / `candidates` 可以调小。
- 只在 `/g/<id>` 这类页面上工作，大厅/创建页不会做任何事。
- 游戏实例是通用的：换成别的 `/g/<id>`，bot 会自动 `fetch('/api/games/<id>')` 读取 `level_count` 适配不同长度的合成链。
