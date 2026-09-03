# 规则引擎 → Python 移植清单

> 目标：AlphaZero 式训练（自对弈 + MCTS）跑在 Python 侧，需要一套与 TS 语义**完全一致**的连珠规则：棋盘、禁手、胜负、合法着法。
> 推理侧走 ONNX + onnxruntime（TS），不走子进程；因此规则会**双份存在**——TS（UI/对弈流程）与 Python（训练自对弈/MCTS），两份必须保持等价。
> 本文列出需要翻译成 Python 的函数、语义约定、依赖与边界。TS 现有实现是「黄金基准」，Python 移植须用同一套用例验收。

---

## 0. 必须对齐的核心语义（翻译前先定死）

这些是 RIF 连珠规则的硬约定，Python 移植不能想当然：

1. **棋盘表示**：`15×15`，扁平一维数组，索引 `idx = y * 15 + x`。黑 `1`、白 `2`、空 `0`。Python 侧可用自己的数据结构（如 numpy），但坐标/索引语义必须一致。
2. **禁手判定的前置约定**：`checkForbidden(board, p)` 假定 **p 已经放上黑子**（调用方先落子、再判定这一手是否禁手）。这是现有契约，移植时必须保留。
3. **五连优先**：黑方恰好五连直接胜，**即使同时构成三三/四四/长连也算胜**（`checkForbidden` 里先判五连返回 null）。
4. **黑长连 = 负**：黑方 ≥6 连是禁手（`overline`），即便其中含五连也判负。
5. **白方无禁手**：白方 ≥5 连即胜。
6. **四/三的去重键**：`countFours` 按「黑子坐标集合」去重（同一四只计一次）；`countThrees` 按「三本身的棋子集合」（活四去掉成四点 e）去重，同一三的两个成四端点归并为一个。
7. **假三（嵌套禁手）**：只有"能一步成真活四、且该成四点本身不是黑方禁手"的三才算活三。递归深度 `MAX_DEPTH = 3`，超出不再递归（直接视为真）。
8. **活四的严格定义**：恰好 4 连、两端为空、且两端落子后都恰好成五（更外侧一格不能是黑，否则会变长连）。

---

## 1. 必须移植（核心规则）

### 1.1 棋盘基础与坐标

| TS 位置 | 函数/常量 | 作用 | 依赖 | 移植注意点 |
| --- | --- | --- | --- | --- |
| `types.ts:3` | `SIZE = 15` | 棋盘尺寸 | 无 | 常量 |
| `types.ts:17` | `idx(x,y) = y*15 + x` | 坐标→扁平索引 | 无 | 索引顺序 `y` 优先 |
| `types.ts:20` | `inBounds(x,y)` | 边界判断 | 无 | — |
| `types.ts:22` | `posEq` / `samePos` | 坐标相等 | 无 | — |
| `types.ts:25-33` | `posName` / `parsePos` | `"aa".."oo"` 坐标串互转 | 无 | 仅棋谱/调试/日志用，可选 |
| `board.ts:3` | `emptyBoard()` | 空棋盘 | 无 | 225 个 0 |
| `board.ts:7` | `cloneBoard(b)` | 复制棋盘 | 无 | 深浅拷贝语义 |
| `board.ts:11` | `stoneAt(b,p)` | 取子 | `idx` | — |
| `board.ts:15` | `withStone(b,p,c)` | 不可变落子 | `cloneBoard`,`idx` | — |
| `board.ts:22` | `DIRS` | 4 方向 `[横,竖,↘,↗]` | 无 | 方向集合是核心 |

### 1.2 胜负判断

| TS 位置 | 函数 | 作用 | 依赖 | 移植注意点 |
| --- | --- | --- | --- | --- |
| `board.ts:32` | `runLength(b,p,color)` | 过 p 的最大连续同色长度（4 方向取最大） | `idx`,`inBounds` | 黑/白通用 |
| `board.ts:57` | `findWinningLine(b,p,color,exact)` | 返回恰好五连（黑 `exact=true`）或 ≥5（白 `exact=false`）的连线 | `idx`,`inBounds` | **黑必须 `exact=true`**（长连不算五连） |
| `forbidden.ts:160` | `isBlackFive(b,p)` | 黑恰好五连（快捷） | `findWinningLine` | — |

### 1.3 禁手判定（最复杂，务必逐行对照）

| TS 位置 | 函数 | 作用 | 依赖 | 移植注意点 |
| --- | --- | --- | --- | --- |
| `forbidden.ts:150` | `checkForbidden(board,p,depth=0)` | 主入口：五连优先 → 长连 → 四四 → 三三 | `findWinningLine`,`runLength`,`countFours`,`countThrees` | **p 已为黑子**的契约；返回 `ForbiddenKind \| null` |
| `forbidden.ts:18` | `lineOf(board,p,dx,dy)` | 提取过 p 的整条线（含出界截断） | 无 | 内部辅助，可改写 |
| `forbidden.ts:48` | `countFours(board,p)` | 统计"四"数量（按黑子集合去重） | `lineOf` | 活四/眠四都计 1 个；去重键 = 窗口内 4 个黑子坐标排序拼接 |
| `forbidden.ts:95` | `countThrees(board,p,depth)` | 统计"活三"数量（去重 + 递归假三校验） | `lineOf`,`checkForbidden` | 见第 0 节第 7/8 条的严格口径 |
| `forbidden.ts:15` | `MAX_DEPTH = 3` | 假三递归深度上限 | 无 | 与 TS 一致 |

### 1.4 合法着法生成（组合逻辑，无现成单一函数）

TS 里没有独立的 `legalMoves(board,color)`，而是分散在：

- `engine.ts` 的 `candidateMoves(board,radius)`（候选启发，非全量合法）+ `orderedCandidates`（黑方过滤禁手）。
- `fsm.ts` 的 `movePlacementLegal(s,pos)`（占用 + 开局区域约束）+ `forbiddenAt(s,p)`（禁手包装）。

Python 侧需要自己组合成一个函数：

```text
legal_moves(board, color) =
    所有空点
    ├─ 黑方：过滤 checkForbidden(place_black(board,p), p) != null 的点
    └─ 白方：全部空点
```

> 中盘 AlphaZero 训练只需上面这个；若训练要覆盖开局区域约束，见 §2。

### 1.5 终局判定（中盘部分）

| TS 位置 | 逻辑 | 移植要点 |
| --- | --- | --- |
| `fsm.ts` `checkGameEnd(s,pos,color)` | 黑：恰好五连→黑胜；禁手→白胜；白：≥5 连→白胜（含长连）；满盘→和棋 | 移植只需**中盘部分**；`winner` 用玩家索引，Python 侧可改为颜色/±1 表示 |

---

## 2. 可选移植（仅当自对弈要跑完整开局）

AlphaZero 通常只训练中盘（局面→策略/价值）。若要让自对弈从塔拉山口-10 开局开始（含交换/走法/十打点），才需要以下协议类函数：

| TS 位置 | 函数 | 作用 | 说明 |
| --- | --- | --- | --- |
| `board.ts:85` | `withinCentral(p,r)` | 第 N 手是否落在中央 `(2r+1)×(2r+1)` | 区域约束 |
| `board.ts:90` | `isCenterSymmetric(p,q)` | 两点是否关于天元对称 | 十打点"不得中心对称" |
| `fsm.ts` `regionRadius(s)` | 各开局阶段半径 `0/1/2/3/4` | 映射阶段→区域 |
| `fsm.ts` `movePlacementLegal(s,pos)` | 占用 + 区域合法性 | 占用部分通用，区域部分仅开局 |
| `fsm.ts` `validateTenOffers(s,points)` | 十打点校验：恰好 10 点、不重复、不对称、不落已有子 | 走法二 |
| `fsm.ts` `currentActor` / `applyEvent` / `phaseLabel` | 整个塔拉山口-10 状态机（交换/走法选择/打点/选点/阶段流转） | 这是「协议」，不是中盘规则 |

**建议**：第一版 Python 训练只做中盘（§1），开局复用 TS 现有逻辑或固定开局库，避免一开始就移植整套 FSM。

---

## 3. 等价性验收基准（黄金用例）

Python 移植完成后，用现有 TS 测试作为逐条对照：

| 测试文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/shared/__tests__/forbidden.test.ts` | 17 | 三三/四四/长连、假三、五连优先、经典争议局面 |
| `src/shared/__tests__/fsm.test.ts` | 15 | 区域约束、交换、走法一/二、五连/禁手/长连/认输/超时终局 |
| `src/shared/__tests__/ai.test.ts` | 10 | 一步取胜/挡杀、黑方过滤禁手 |

> 最稳妥做法：把 `forbidden.test.ts` 的用例翻译成 Python 参数化测试，逐一断言 `checkForbidden` 输出与 TS 一致；再用随机棋盘做「交叉验证」——TS 与 Python 对同一盘面、同一落点给出相同判罚。

---

## 4. 移植顺序建议

1. `SIZE / idx / inBounds / emptyBoard / cloneBoard / DIRS`（地基）。
2. `runLength` + `findWinningLine`（胜负，简单且被禁手依赖）。
3. `countFours` + `countThrees` + `checkForbidden`（禁手核心，最易错，逐行对照 + 用例验证）。
4. `legal_moves(board, color)` 组合函数。
5. `checkGameEnd` 中盘部分（五连/禁手/长连/满盘）。
6. 需要时再补 §2 的开局协议函数。
