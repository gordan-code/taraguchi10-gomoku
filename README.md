# RenjuMaster 连珠大师

基于 **塔拉山口-10（Taraguchi-10）**职业规则的连珠（五子棋）AI 对弈桌面应用（Electron + Vue 3 + TypeScript + Rust/WASM）。

## 功能

- **完整塔拉山口-10 规则**：天元开局 → 3×3/5×5/7×7 逐级区域约束 → 5 次交换决策 → 走法一（9×9 直接落子 + 最后交换权）/ 走法二（十打点报价 + 白方十选一）→ 第 6 手进入中盘
- **人机对弈**：可选执黑/执白/随机；中盘引擎可选 Negamax（Rust/WASM 搜索）或神经网络（ONNX 推理），失败自动回退
- **AI 观战**：AI vs AI 自动对弈，1x/2x/4x/瞬时倍速
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
npm run test       # 运行测试（79 个用例）
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
node bench.mjs   # 基准回归：堵活三/冲四即胜/活四判负/增量评估一致性
```

（需要 `rustup target add wasm32-unknown-unknown`。`src/renderer/src/ai/` 下已放置编译产物，不装 Rust 也能正常开发运行。）

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
