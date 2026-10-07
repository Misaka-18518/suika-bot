# Windows 部署手册（写给在这台机器上干活的 Agent）

> 这份文档假设你是一个 AI coding agent，在一台 **Windows** 机器上工作，
> 目标是把 [suika-bot](https://github.com/Misaka-18518/suika-bot) 跑起来，并能自己迭代它的 AI。
> 每一步都有**验收命令**，跑不过就不要往下走。

---

## 0. 你的任务与验收标准

分三档，按用户实际要求选做：

| 档位 | 目标 | 验收 |
| --- | --- | --- |
| A（必做） | 让 bot 能在真实浏览器里自动游玩 | `node run.mjs --timeout 60` 能打印分数且分数 > 0 |
| B（可选） | 能自己训练价值网络 | `python train/train.py` 跑通并产出 `models/value.json` |
| C（可选） | 改进 AI 且**可证明**变强 | `node tools/ab.cjs` 给出配对差与 t 值 |

**不要跳过 A 直接做 B/C。** A 跑不通说明环境有问题，此时做 B/C 只会把问题搅在一起。

---

## 1. 环境体检

```powershell
node -v          # 需要 >= 18，推荐 20 LTS。没有就装：winget install OpenJS.NodeJS.LTS
npm -v
python --version # 需要 3.10 ~ 3.12；没有就装：winget install Python.Python.3.12
nvidia-smi       # 有 N 卡才需要；记下驱动版本
```

注意：
- Windows 上 Python 命令是 `python`（不是 `python3`）。本文档统一写 `python`。
- 如果 `python` 打开的是 Microsoft Store 的占位程序，用 `py -3` 代替。
- **路径要求**：把仓库放在短路径且不含中文/空格的地方，例如 `C:\suika`。
  项目里有大量文件写入和子进程 fork，长中文路径在 Windows 上容易炸。

---

## 2. 克隆

```powershell
cd C:\
git clone https://github.com/Misaka-18518/suika-bot.git suika
cd C:\suika
ls   # 应该看到 run.mjs / src / tools / train / README.md
```

如果用户已经把这个目录给你了，跳过这步，确认 `run.mjs` 在就行。

---

## 3. 装 Node 依赖

```powershell
cd C:\suika
npm install
```

关于这一步你要知道的事：
- 依赖只有 **playwright-core** 一个包，**不会**下载浏览器（那是 `playwright` 包的行为）。
  如果你看到它在下载 Chromium，说明装错包了，检查 `package.json`。
- 如果报 `EACCES`/权限错误，改用本地缓存重试：
  ```powershell
  npm install --cache .\.npmcache
  ```

**验收**：
```powershell
node -e "console.log(require.resolve('playwright-core'))"
```
能打印路径即通过。

---

## 4. 装浏览器（Chrome for Testing）

项目**不使用**系统里的 Chrome/Edge，而是自带一份 Chrome for Testing，路径固定为
NaN.browsers\chrome-win64\chrome.exe`（`run.mjs` 就是这么找的）。

```powershell
$ErrorActionPreference = "Stop"
$meta = Invoke-RestMethod "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
$url  = ($meta.channels.Stable.downloads.chrome | Where-Object { $_.platform -eq "win64" }).url
$zip  = Join-Path $env:TEMP "chrome-win64.zip"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
New-Item -ItemType Directory -Force -Path ".browsers" | Out-Null
Copy-Item -Recurse -Force (Join-Path $env:TEMP "chrome-win64") ".browsers\chrome-win64"
```

**验收**（必须输出 True）：
```powershell
Test-Path ".browsers\chrome-win64\chrome.exe"
```

包大约 180MB。如果公司网络挡了 `storage.googleapis.com`，
让用户手动下载 `chrome-win64.zip` 解压到 `.browsers\` 下，效果一样。

---

## 5. 冒烟验证（档位 A）

```powershell
node run.mjs --timeout 60
```

**期望输出**（顺序出现）：
```
→ 使用价值网络 models/value.json（valMae 345.28 分）
→ 打开 https://dxg.calyx.site/g/FgyFHY2p
→ 页面就绪 {"matter":"0.19.0","bot":"1.0.0","levels":9,"title":"合成大西瓜"}
  分数     0  投放   0  离警戒线 999px
  分数     6  投放   5  离警戒线 406px
  ...
最终得分: xxx 总投放: xx
```

判定标准：**分数 > 0 且投放次数持续增长**。满足即档位 A 通过。

常见不通过的情况：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `net::ERR_CONNECTION_CLOSED` 或 `ERR_INTERNET_DISCONNECTED` | 网络/代理/VPN 抖动 | `run.mjs` 自带 5 次重试；仍然失败就 `curl.exe -I https://dxg.calyx.site/g/FgyFHY2p` 确认站点可达 |
| 卡在 `等待瞄准预览…` | canvas 钩子没装上 | 确认页面能正常玩（人肉打开看看）；确认没有别的脚本抢先定义 `window.Matter` |
| 一直 `投放 0` | 没抓到游戏引擎 | 看面板有没有提示「请点一下再来一局」 |
| 分数一直是 0 但投放次数在涨 | 正常，前期合成少 | 继续等 |

想让人看着它玩（会弹出窗口）：
```powershell
node run.mjs --headed --keepOpen
```

### 5.1 顺带：给用户装油猴脚本（浏览器里用）

如果用户想要「在自己日常用的浏览器里打开游戏页就自动玩」，而不是让你用无头浏览器跑：

仓库里自带的 `suika-bot.user.js` 是**精简版（46KB）**，用的是手工启发式 —— 开箱即用、更新检查也快。
如果你已经训练出了自己的价值网络，想把它一起打进脚本：

```powershell
node tools/build.cjs              # 有 models/value.json 时会自动内嵌 → 脚本变成约 850KB
node tools/build.cjs --no-model   # 强制不内嵌，回到 46KB
```
2. 让用户装 [Tampermonkey](https://www.tampermonkey.net/) 扩展（Chrome/Edge 商店搜 Tampermonkey 即可）。
3. 把脚本内容给他 —— 两种方式任选：
   - **直接给文件**：把 `C:\suika\suika-bot.user.js` 拖进浏览器，Tampermonkey 会弹出安装页；
   - **给在线地址**：打开 `https://raw.githubusercontent.com/Misaka-18518/suika-bot/main/suika-bot.user.js`，
     Tampermonkey 会自动识别为脚本安装页。
4. 装完打开 `https://dxg.calyx.site/g/FgyFHY2p`，左上角出现状态面板即成功。

注意：**不要在页面加载完之后才粘贴脚本**。钩子必须在页面脚本之前装好 ——
事后粘贴的话，面板会提示「请点一下再来一局」，点一下游戏里的「再来一局」按钮即可生效（会新建引擎）。

---

## 6. （可选，档位 B）GPU 训练环境

**如果你的卡是 RTX 50 系（Blackwell，sm_120），必须用 cu128 的 PyTorch 轮子**，老版本直接报错。
5070 Ti / 5080 / 5090 都属于这一类。

```powershell
cd C:\suika
python -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force   # 否则下面 Activate.ps1 会被拦
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install torch --index-url https://download.pytorch.org/whl/cu128
```

（cmd 用户用 `.\.venv\Scripts\activate.bat` 代替第 3 行。）

**验收**（三个值都要对）：
```powershell
python -c "import torch;print(torch.__version__, torch.cuda.get_device_capability(), torch.cuda.is_available())"
```
期望：版本号 >= 2.7，`(12, 0)`，`True`。

- 打印 `False` → 装成 CPU 版了，删掉 `.venv` 重来，确认用的是 `cu128` 的 index-url。
- 打印 `(8, 9)` 之类 → 驱动太老，让用户升级显卡驱动。

---

## 7. （可选，档位 B）跑一轮自我训练

### 7.1 先测数据生成吞吐（很重要）

数据生成是**纯 CPU**、而且**并行度不是越高越好**（大量小对象分配会打满内存带宽，
大小核混跑会互相拖累；在 M4 上实测 9 并发比 5 并发慢一倍多）。

```powershell
node tools/gen-data.cjs --games 20 --conc 6 --out data/probe
```

看输出最后的 `gamesPerSec`。用它反推：**想要 N 局，耗时 ≈ N / gamesPerSec 秒**。
然后调 `--conc`（从「物理核心数」起步，往上往下各试一次）取吞吐最高的值。

### 7.2 生成正式数据

```powershell
node tools/gen-data.cjs --games 3000 --conc 10 --out data/r1
```

- 中途 Ctrl-C 不会白跑：分片 header 是增量写的，已完成的部分能直接训练。
- 3000 局 ≈ 60~90 万条样本 ≈ 2GB，按 0.5 局/秒约 100 分钟。

### 7.3 训练

```powershell
python train/train.py --data data/r1 --epochs 60 --device cuda --batch 1024 --out models/value.json
```

**只盯一个指标：val MAE（单位是「分」）**，越小越好，脚本会自动保存验证集上最好的那一版。

- 5070 Ti 上 15 万参数的网络每轮只要几秒，可以放心多跑。
- **如果 val MAE 在第几轮触底后开始回升，就是过拟合了**：加数据，不要加网络容量。
- 参考基线：9 万样本 → 345 分；目标是把样本堆到 60 万以上再看。

### 7.4 强制校验（不许跳过）

```powershell
python train/parity_test.py --model models/value.json --out $env:TEMP\parity.json
node tools/parity-check.cjs $env:TEMP\parity.json
```

**必须打印 `✔ 数值对齐通过`**（最大绝对误差应 < 0.01 分）。
这一步保证浏览器里的纯 JS 推理和 PyTorch 完全一致；不通过就说明你动了 `src/value.js` 或
NaNtrain/model.py` 其中一边而没同步另一边。

### 7.5 策略迭代（真正涨分的地方）

```powershell
node tools/gen-data.cjs --games 3000 --conc 10 --out data/r2 --model models/value.json --explore 0.05
python train/train.py --data data/r2 --epochs 60 --device cuda --batch 1024 --out models/value.json
```

每轮**只用新一轮数据**（on-policy）。旧数据是弱策略打出来的，混进来会把 V 往下拽。
跑 3~5 轮，每轮都用 `tools/ab.cjs` 验证有没有真的变强（见下一节）。

---

## 8. 改 AI 的正确姿势（档位 C）

### 8.1 先读懂这三个文件

| 文件 | 你要知道的事 |
| --- | --- |
| `src/ai.js` | 决策核心。粗筛（启发式）→ 入围者长模拟 → V/blend 精排。**改权重改这里** |
| `tools/sim-game.cjs` | 站点 `engine.js` 的逐行复刻。**这里的物理常数不许乱改**，改了离线评测就不可信 |
| `src/value.js` | 价值网络的栅格化 + JS 推理。**改这里必须同步改 `train/model.py`** |

### 8.2 纪律：绝对不要用一局的结果下结论

单局分数标准差约 **700~1200 分**。粗算需要多少局才能看出提升：

```
需要的局数 n ≈ 16 × (配对标准差 / 你想检测的差值)²

配对标准差 800、想可靠看出 150 分的提升 → n ≈ 450 局
配对标准差 800、想可靠看出 300 分的提升 → n ≈ 115 局
```

所以：
- **任何「我改了 X，分数从 1200 涨到 1400」的结论都是噪声**，除非跑了足够多局。
- 一律用 `tools/ab.cjs`：它用**相同的随机种子**跑 A/B 两臂，做配对比较并给出 t 值。

```powershell
# 换权重
node tools/ab.cjs --games 60 --profile full --a '{...}' --b '{...}'

# 换决策档位
node tools/ab.cjs --games 60 --profileA light --profileB full --a '{}' --b '{}'

# 换评估器（手工启发式 vs 启发式+价值网络）
node tools/ab.cjs --games 60 --profile full --valueB models/value.json --valueMode blend
```

**判读标准**：看最后一行 `配对差 B-A` 和 `t`。
NaN|t| < 2` 就当作「没有差异」，不要写进结论。

### 8.3 想快速调启发式权重

```powershell
node tools/search.cjs --games 8 --passes 2 --profile full   # 并行坐标下降
node tools/prof.cjs                                          # 看决策耗时分布
node tools/prof2.cjs                                         # 看单局各环节耗时
```

---

## 9. Windows 特有的坑

1. **路径**：仓库放 `C:\suika` 这种短路径。中文/空格/超长路径会让 `fork()` 和
   文件写入出各种奇怪错误。
2. **PowerShell 执行策略**：跑 `Activate.ps1` 报「禁止运行脚本」时，先执行
   `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`（只影响当前窗口）。
3. **防火墙**：首次跑 `run.mjs` 时 Windows 会弹窗问是否允许 Node 联网，**必须允许**。
   无人值守时可能被静默拦截，表现为所有请求都失败。
4. **杀毒软件**：可能拦截 Playwright 启动 Chrome 的行为，把这个仓库目录加白名单。
5. **编码**：仓库里全是 UTF-8（含中文）。用 PowerShell 看输出乱码的话先 `chcp 65001`。
6. **不要提交 `data/`**：那是几百 MB 的生成物，已经在 `.gitignore` 里了。

---

## 10. 最终验收清单

做完请逐条确认并汇报给用户：

- [ ] `node -v` ≥ 18，`npm install` 成功
- [ ] `.browsers\chrome-win64\chrome.exe` 存在
- [ ] `node run.mjs --timeout 60` 打印了非零分数
- [ ] （做了 B）`torch.cuda.is_available()` 为 True、capability 为 `(12, 0)`
- [ ] （做了 B）`python train/train.py` 产出了 `models/value.json` 并报告 val MAE
- [ ] （做了 B）`node tools/parity-check.cjs` 打印 `✔ 数值对齐通过`
- [ ] （做了 C）`tools/ab.cjs` 给出 `|t| >= 2` 的提升，或如实说明「没有显著差异」

汇报时请给出**原始数字**（A 每局、B 每局、均值、配对差、t、局数），不要只给结论。

---

## 附：这个项目在做什么（30 秒版）

```
真实游戏页面 (dxg.calyx.site)
  ├─ 钩 window.Matter  → 拿到页面自己的物理引擎 → 读全部水果状态
  ├─ 钩 drawImage      → 从瞄准预览反推当前/下一个水果等级
  └─ 派发 pointerdown/up → 页面自己的 input.js 会投放（= 真实操作）

决策 (src/ai.js)
  ├─ 用站点同款 matter-js 0.19.0 重建世界，逐行复刻合并逻辑
  ├─ 29~33 个候选落点 → 前向模拟到落定
  └─ 启发式粗筛 → 入围者长模拟 → V(board)/blend 精排

自我训练 (train/)
  ├─ tools/gen-data.cjs  自我对弈，记录 (棋盘栅格, 之后实际得分)
  ├─ train/train.py      小型 CNN 回归，导出 JSON
  └─ src/value.js        纯 JS 推理，误差 < 1e-4 分
```
