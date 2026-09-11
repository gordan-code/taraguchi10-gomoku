# RenjuMaster 连珠大师

基于 **塔拉山口-10（Taraguchi-10）**职业规则的连珠（五子棋）AI 对弈桌面应用（Electron + Vue 3 + TypeScript + Rust/WASM）。

## 功能

- **完整塔拉山口-10 规则**：天元开局 → 3×3/5×5/7×7 逐级区域约束 → 5 次交换决策 → 走法一（9×9 直接落子 + 最后交换权）/ 走法二（十打点报价 + 白方十选一）→ 第 6 手进入中盘
- **人机对弈**：可选执黑/执白/随机；中盘引擎可选神经网络（NN+MCTS）或 Negamax（Rust/WASM 搜索），失败自动回退
- **AI 观战**：AI vs AI 自动对弈，1x/2x/4x/瞬时倍速
- **NN+MCTS 神经引擎**：AlphaZero 风格 PUCT 蒙特卡洛树搜索（策略先验引导 + 价值头评估，一步取胜预检），onnxruntime 推理。当前快照为 **KataGo 蒸馏重训版**（1000 万 renju15x 局面监督训练，自 iter55 自对弈快照 warm-start）：对旧 NN 模型 +154 Elo，对 Rapfi 外部标尺 -552 → **-402**；策略先验修复了实战败局回归中"跳三不挡"的先验盲区
- **Rust/WASM 搜索内核**：no_std Rust 编译为 WebAssembly（~28KB），在 Worker 内运行，含置换表 / PVS / 杀手着 / 历史启发 / 期望窗口 / LMR / 威胁延伸；10 秒预算下名义深度 10、威胁线深度（选择性深度）18-20
- **威胁空间搜索（VCT/VCF）**：毫秒级必胜探测，冲四连招、活四/双四强制线在搜索前直接识别
- **禁手系统**：黑方三三/四四/长连判定（含假三、嵌套禁手等 RIF 严格口径），实时禁手点标记，五连与禁手同达时五连优先
- **开局引导交互**：阶段进度条、区域高亮、交换决策面板、走法选择卡片、打点摆点模式（对称校验）、AI 决策理由气泡
- **实时分析面板**：深度/评估/速度/节点数/用时统计、威胁线深度、评估曲线（SVG）、路线与局面代码
- **棋谱导入导出**：RenjuMaster JSON（全量保真，含所有开局决策）+ Piskvork `.psq`（生态兼容）
- **复盘回放**：逐帧回放、自动播放、回到当前
- **悔棋**：回退到你最近一次决策之前（含交换决策前）
- **自动保存**：异常退出后重启可恢复未完成对局

## 开发

```bash
npm install
npm run dev        # 开发模式
npm run test       # 运行测试（84 个用例）
npm run typecheck  # 类型检查
npm run build      # 构建
npm run package    # 打包 Windows 安装包（release/）
```

### Rust/WASM 搜索内核

中盘搜索内核位于 `rust-engine/`，TS 侧通过 `src/renderer/src/ai/wasmEngine.ts` 懒加载，加载/推理失败自动回退 TS Negamax。修改内核后需重新编译并复制：

```bash
cd rust-engine
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/renju_engine.wasm ../src/renderer/src/ai/renju_engine.wasm
node bench.mjs   # 基准回归：堵活三/冲四即胜/活四判负/增量评估与四表一致性
```

（需要 `rustup target add wasm32-unknown-unknown`。`src/renderer/src/ai/` 下已放置编译产物，不装 Rust 也能正常开发运行。）

### 引擎对打评测

`scripts/eval.mjs` 是固定时间控制的引擎对打框架（TS 引擎经 esbuild 打包进 Node，WASM 直接加载），用于度量任何内核/参数改动的棋力影响：

```bash
node scripts/eval.mjs --engine-a ts --engine-b wasm --games 12 --time 500   # 基线对比
node scripts/eval.mjs --engine-a wasm --engine-b wasm \
  --wasm-a <旧内核.wasm> --wasm-b <新内核.wasm> --games 24                  # 新旧内核 A/B
node scripts/eval.mjs --engine-a ts --engine-b wasm --games 1 --dump        # 复盘单局着法+终盘
```

输出胜/负/和、得分率与 Elo 估计、平均深度/威胁线深度/节点率。判定：黑恰好五连胜、白 ≥五连胜、黑禁手即负；着法上限后按最后评估分裁决。种子化开局可复现，先后手轮换。

### 外部标尺：对打 Rapfi（Gomocup 冠军引擎）

自对弈只回答"我是否比昨天的自己强"，外部引擎才提供绝对坐标。`--engine rapfi`（[rapfi-adapter.mjs](scripts/rapfi-adapter.mjs)，piskvork 协议子进程适配器）可把 [Rapfi](https://github.com/dhbloo/rapfi) 接入评测框架：

```bash
# 准备：下载 Rapfi release（Rapfi-engine.7z）解压到 engines/（已 gitignore）
node scripts/eval.mjs --engine-a wasm --engine-b rapfi --games 100 --time 500
node scripts/eval.mjs --engine-a rapfi --engine-b rapfi --games 4   # 镜像自检：应约 50% / Elo≈0
```

对齐口径：renju 规则（`INFO rule 4`，黑白分权 NNUE）、单线程（与 WASM 内核一致）、500ms/手快棋、种子化随机开局 4 手后引擎接管。适配器踩过三个坑（均有注释记录）：`max_memory` 需按**字节**传（Rapfi 源码 `val>>10` 转 KB，传 KB 值会把搜索内存钳到 1KB、棋力骤降）；`BOARD` 的颜色标记是**相对语义**（1=引擎自己 / 2=对手，不是绝对黑白）；`BOARD` 必须按**真实落子顺序**发子（乱序会触发 Rapfi 的 PASS 补偿、翻转其行棋方导致"替对手思考"）。

**基线（2026-09-09，100 局，500ms/手）**：WASM 内核 vs Rapfi 2025-06-15 = **4 : 96，Elo -552**。差距主要来自 Rapfi 的 NNUE 评估（约 3000 Elo 级权重）对线型评估函数的碾压——这正是 texel 调参与 NN 蒸馏路线的起点标尺。texel 调参后复测：**5 : 95，Elo -512**（+40，与内部 A/B 的 +28 一致）。

### 在应用内与 Rapfi 对弈

图形界面也可直接选择 Rapfi 作为对手（新对局 → AI 引擎 → "Rapfi（外部冠军引擎）"）。架构：渲染层 store 在中盘（PLAY 阶段）经 IPC 把棋盘发给主进程（[src/main/rapfi.ts](src/main/rapfi.ts)），主进程持有 piskvork 子进程并复用评测适配器同款协议逻辑（BOARD 相对颜色/落子序/TURN 增量/跨局重启）；塔拉山口-10 开局决策（交换/走法/打点）仍由内置引擎完成，Rapfi 只负责中盘。应用退出/新对局时自动终止子进程（`before-quit` 钩子 + `startNewGame` 重置），无进程残留。前提：`engines/` 目录下放置 Rapfi 可执行文件（同上节，gitignore 不入库）。

### Texel 调参（2026-09-09）

用 Rapfi 自对弈棋谱（300 局 / 1434 局面，[gen-tuning-data.mjs](scripts/gen-tuning-data.mjs) 驱动双 Rapfi 进程对打）拟合窗口评估权重（[texel-tune.mjs](scripts/texel-tune.mjs)，sigmoid 胜率拟合 + 单调约束坐标下降）：

- **特征相关性**：1/2 子窗口计数与胜负相关性仅 -0.05/-0.01（零判别力），3/4 子窗 0.23/0.31——手拍权重 `[2,24,320,3600]` 给了小窗口虚高的重要性
- **对打筛选**（[eval.mjs](scripts/eval.mjs) `--ts-weights-a/b` 注入权重，TS 与 WASM 双引擎独立验证）：新权重 `[1,8,96,600]` 合计 200 局 105:93:2，**约 +28 Elo，方向一致但未达统计显著**（95% CI 含 0）
- 已部署（TS + Rust 两侧同步、bench 回归与 104 项测试全绿）。**诚实的结论**：纯窗口计数评估的信息天花板就在这里——下一步的真正增量在评估函数架构（开放端/活眠区分特征，或直接上 NNUE/NN 蒸馏），已记录于路线图
- 附带发现：Rapfi 自对弈白方胜率 83%（300 局 51:249）——renju 规则下白方优势的强引擎实证

### NN 蒸馏重训（2026-09-10）

用 KataGo renju15x 蒸馏数据（[AlphaZero-Gomoku-Taraguchi10](https://github.com/gordan-code/AlphaZero-Gomoku-Taraguchi10) 训练仓库，`train_supervised.py`）对 NN 引擎做监督重训，替代纯自对弈（自对弈 55 轮后已陷平台期、评估胜率归零）：

- **数据**：KataGo renju15x（带禁手 15×15），8M 局面 × 2 epochs（另有 2M warm-up 批），从 iter55 自对弈快照 warm-start；状态编码 4 通道（我的/对手/禁手生效/阶段）与应用侧 `encodeNnState` 逐通道对齐，蒸馏数据由 `katago_loader.py` 直接产出该格式
- **损失**：策略 2.55 → 2.33，价值 MSE 0.44 → 0.34（仍在下降，全量 6500 万局面是下一步）
- **验证**：对旧 NN 模型 24 局 17:7（**+154 Elo**）；对 Rapfi 外部标尺 100 局 9:91（**-552 → -402**）；实战败局回归测试中策略先验从"跳三不挡的败着 E7"变为直接选防守点 J7（原测试预言"高质量数据重训后达成"，已达成并升级断言）
- **全量复测（负结果，如实记录）**：追加全量 6477 万局面 × 2 epochs（loss 2.33→2.25 / 0.34→0.30）后，对 10M 版内部对打 72 局 40:32（+44，不显著），对 Rapfi 100 局 7:93（-449，与 -402 在测量误差内不可区分）。**行为克隆的边际收益已耗尽**——监督蒸馏阶段到此为止，下一步增量在自对弈接力（蒸馏起点跑 AlphaZero 循环）。全量快照 `sl_pretrain_20260911_032053.pt` 留档未部署

### WASM 并行搜索实验（2026-09-11，负结果）

内核新增根子集接口（`search_best_move_subset` 位掩码切分 + `search_moves` 显式着法列表精搜），eval.mjs 支持 `--engine wasm-parallel`（N 个 worker_threads 各持独立 WASM 实例/独立 TT）。三变体 × 100 局对打单线程基线：

- 交错切分 + 最大分汇总：54:46（+28）
- 交错切分 + 两阶段重验证（60/40 预算）：54:46（+28）
- 块切分（前佳候选给主 worker）+ 两阶段：46:54（-28）

**合并 200 局 100:100，约 0 Elo。** 节点吞吐 ~2.2 倍（4 worker）但深度不变（5.4 vs 5.5）——这不是实现问题而是 root-splitting 的固有性质：切树并行降低的是**到达深度 D 的时延**，不提升**固定时控下能到达的深度**（各 worker 的子树只有单线程 1/N 大小，同墙钟时间搜到同深度）。附带发现：各子集的 aspiration 分数跨子集不可比，直接取 max 有 ~25% 局面选错着法，两阶段重验证可修复但预算翻倍不划算。**结论**：时控对弈场景 root-splitting 无收益；深度限制场景（开局库生成）可用；真正的时控增益需要 Lazy SMP（全树共享 TT 并行）——依赖 WASM 线程 + SharedArrayBuffer，留作后续。基础设施（subset/search_moves 接口、并行适配器）保留入库。

## 架构

```
├── rust-engine/           # Rust no_std 搜索内核（编译为 WASM）
│   ├── src/lib.rs         # Negamax + TT/PVS/杀手着/LMR/威胁延伸/增量评估/禁手
│   └── bench.mjs          # Node 基准与回归脚本
├── src/
│   ├── shared/               # 规则引擎（纯函数，无 UI 依赖，可独立测试）
│   │   ├── types.ts          # 类型定义
│   │   ├── board.ts          # 棋盘基础（连线、区域、对称）
│   │   ├── forbidden.ts      # 禁手判定（三三/四四/长连，递归假三校验）
│   │   ├── fsm.ts            # 塔拉山口-10 状态机（16 相位，可序列化）
│   │   ├── record.ts         # JSON 棋谱（事件重放式序列化/还原）
│   │   ├── psq.ts            # Piskvork psq 格式互操作
│   │   └── ai/
│   │       ├── engine.ts     # TS Negamax 引擎（回退路径）+ VCT/VCF 必胜探测
│   │       ├── opening.ts    # 开局决策（交换/走法/打点/选点博弈）
│   │       ├── nn.ts         # 神经网络状态编码/选点（ONNX）
│   │       └── report.ts     # AI 决策报告结构
│   ├── main/                 # Electron 主进程（文件对话框 IPC）
│   ├── preload/              # 上下文桥
│   └── renderer/             # Vue 3 界面
│       └── src/
│           ├── store/game.ts # 游戏仓库（AI Worker 调度/悔棋/回放/自动保存）
│           ├── ai/
│           │   ├── worker.ts     # AI Worker（NN 推理 / WASM 搜索 / TS 回退）
│           │   ├── wasmEngine.ts # Rust/WASM 内核加载与调用
│           │   ├── nnSession.ts  # onnxruntime-web 会话
│           │   └── model.onnx    # 导出的策略/价值网络
│           └── components/   # 棋盘 Canvas/阶段条/玩家卡/分析面板/结算/回放条
```

## AI 训练（AlphaZero）

配套的 AlphaZero 训练框架见 [AlphaZero-Gomoku-Taraguchi10](https://github.com/gordan-code/AlphaZero-Gomoku-Taraguchi10)：蒸馏数据监督预训练 + 自对弈强化，训练完成的快照导出 ONNX 放入 `src/renderer/src/ai/model.onnx` 供应用内推理。

## 规则参考

- [RenjuNet 塔拉山口-10 官方规则](https://www.renju.net/rule/25/)
- [2026 世界连珠团体锦标赛](https://www.renju.net/tournament/3510/)（采用 Taraguchi-10）
