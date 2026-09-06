/**
 * AlphaZero 风格 PUCT 蒙特卡洛树搜索（纯逻辑，不依赖 onnxruntime）：
 * - 策略先验引导选路，价值头评估叶子，访问次数决定最终选点
 * - 合法手生成跳过占用点与黑方禁手；落子即成五的子节点直接记终局价值
 * - net 由调用方注入：浏览器侧绑 onnxruntime-web，Node 评测侧绑 onnxruntime-node
 *
 * 价值约定：net 返回的 value 是「当前行棋方视角」[-1,1]；节点 w 累计
 * 「走入该节点一方」的价值，因此父节点选子时直接用 w/n。
 */
import { Board, Color, Pos, SIZE, idx } from '../types'
import { candidateMoves } from './engine'
import { checkForbidden } from '../forbidden'
import { runLength } from '../board'

export const NN_ACTION = 229

export interface MctsNetResult {
  /** 229 维 policy logits（0..224 = y*15+x） */
  policy: Float32Array | number[]
  /** 当前行棋方视角价值 [-1,1] */
  value: number
}

/** net(board, color, plyFromRoot) → 策略 + 价值 */
export type MctsNet = (board: Board, color: Color, ply: number) => Promise<MctsNetResult>

export interface MctsOptions {
  /** 模拟次数上限 */
  sims: number
  /** 时间上限（Date.now() 毫秒）；至少完成 1 次模拟 */
  deadline: number
  /** PUCT 探索系数（默认 1.25） */
  cpuct?: number
  /** 根先验 Dirichlet 噪声（并行多树时提供多样性；同一 seed 可复现） */
  rootNoise?: { eps: number; alpha: number; seed: number }
}

export interface MctsVisit {
  /** 根合法手 cell index（y*15+x） */
  i: number
  n: number
  /** 该子节点价值（根行棋方视角），未访问为 0 */
  q: number
}

export interface MctsResult {
  pos: Pos
  /** 选中着法的价值（根行棋方视角，[-1,1]） */
  q: number
  /** 实际完成的模拟次数 */
  sims: number
  /** 树内达到的最大 ply */
  depth: number
  /** 访问次数前 3 的着法（调试/展示用） */
  top: Array<{ pos: Pos; n: number }>
  /** 根全部合法手的访问明细（并行多树汇总用） */
  visits: MctsVisit[]
}

/**
 * 并行多树汇总（根并行 MCTS）：各树根访问次数按 cell 求和，选访问最多的着法；
 * 价值取各树对该着法价值的加权平均。
 */
export function combineMctsResults(results: Array<MctsResult | null>): MctsResult | null {
  const valid = results.filter((r): r is MctsResult => r !== null)
  if (valid.length === 0) return null
  if (valid.length === 1) return valid[0]
  const sum = new Map<number, { n: number; wq: number }>()
  let totalSims = 0
  let maxDepth = 0
  for (const r of valid) {
    totalSims += r.sims
    if (r.depth > maxDepth) maxDepth = r.depth
    for (const v of r.visits) {
      const e = sum.get(v.i) ?? { n: 0, wq: 0 }
      e.n += v.n
      e.wq += v.q * v.n
      sum.set(v.i, e)
    }
  }
  let bestI = -1
  let bestN = -1
  let bestQ = 0
  for (const [i, e] of sum) {
    if (e.n > bestN) {
      bestN = e.n
      bestI = i
      bestQ = e.n > 0 ? e.wq / e.n : 0
    }
  }
  if (bestI < 0) return null
  const visits: MctsVisit[] = [...sum.entries()]
    .map(([i, e]) => ({ i, n: e.n, q: e.n > 0 ? e.wq / e.n : 0 }))
    .sort((a, b) => b.n - a.n)
  const posOf = (i: number): Pos => ({ x: i % SIZE, y: Math.floor(i / SIZE) })
  return {
    pos: posOf(bestI),
    q: bestQ,
    sims: totalSims,
    depth: maxDepth,
    top: visits.slice(0, 3).map((v) => ({ pos: posOf(v.i), n: v.n })),
    visits
  }
}

// ---------------------------------------------------------------- 种子化随机（根噪声）

/** mulberry32 种子随机：并行各树用不同 seed，同一 seed 可复现 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller 标准正态 */
function normalRng(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Marsaglia-Tsang Gamma 采样（alpha > 0） */
function gammaRng(rng: () => number, alpha: number): number {
  if (alpha < 1) {
    return gammaRng(rng, alpha + 1) * Math.pow(rng(), 1 / alpha)
  }
  const d = alpha - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    const x = normalRng(rng)
    const v = 1 + c * x
    if (v <= 0) continue
    const v3 = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v3
    if (Math.log(u) < 0.5 * x * x + d * (1 - v3 + Math.log(v3))) return d * v3
  }
}

/** Dirichlet(alpha, k)：k 个正分量，和为 1 */
function dirichlet(rng: () => number, alpha: number, k: number): Float32Array {
  const out = new Float32Array(k)
  let sum = 0
  for (let i = 0; i < k; i++) {
    out[i] = gammaRng(rng, alpha)
    sum += out[i]
  }
  if (sum <= 0) {
    out.fill(1 / k)
    return out
  }
  for (let i = 0; i < k; i++) out[i] /= sum
  return out
}

interface MctsNode {
  parent: MctsNode | null
  /** 走入该节点的着（cell index），根为 -1 */
  move: number
  toMove: Color
  /** 展开后：合法手先验（与 children 平行） */
  priors: Float32Array | null
  children: Array<MctsNode | null>
  /** 该节点局面下的合法手 cell index（展开时固化） */
  legal: number[]
  n: number
  /** 「走入该节点一方」的累计价值 */
  w: number
  /** 终局价值（toMove 视角）；null = 非终局 */
  terminalValue: number | null
}

function makeNode(parent: MctsNode | null, move: number, toMove: Color): MctsNode {
  return { parent, move, toMove, priors: null, children: [], legal: [], n: 0, w: 0, terminalValue: null }
}

/** 局面下 color 方的合法手（半径 2 近点；黑方过滤禁手） */
function legalMoves(board: Board, color: Color): number[] {
  const out: number[] = []
  for (const p of candidateMoves(board, 2)) {
    const i = idx(p.x, p.y)
    if (board[i] !== 0) continue
    if (color === 1) {
      board[i] = 1
      const bad = checkForbidden(board, p) !== null
      board[i] = 0
      if (bad) continue
    }
    out.push(i)
  }
  return out
}

/** 在 board 上落 color 于 i 后是否成五（黑恰好五，白≥五） */
function isWinningMove(board: Board, i: number, color: Color): boolean {
  const p = { x: i % SIZE, y: Math.floor(i / SIZE) }
  const len = runLength(board, p, color)
  return color === 1 ? len === 5 : len >= 5
}

function softmax(xs: number[]): Float32Array {
  let max = -Infinity
  for (const x of xs) if (x > max) max = x
  let sum = 0
  const out = new Float32Array(xs.length)
  for (let i = 0; i < xs.length; i++) {
    out[i] = Math.exp(xs[i] - max)
    sum += out[i]
  }
  for (let i = 0; i < xs.length; i++) out[i] /= sum
  return out
}

/**
 * PUCT 蒙特卡洛树搜索。
 * board 不会被修改；返回 null 仅当根节点无合法手（理论不可达）。
 */
export async function mctsSearch(
  board: Board,
  toMove: Color,
  opts: MctsOptions,
  net: MctsNet
): Promise<MctsResult | null> {
  const cpuct = opts.cpuct ?? 1.25
  const root = makeNode(null, -1, toMove)
  root.legal = legalMoves(board, toMove)
  if (root.legal.length === 0) return null
  root.children = new Array(root.legal.length).fill(null)

  // 一步取胜预检（与 Negamax 引擎同口径）：不依赖先验质量，
  // 否则均匀/低先验下少模拟数会按索引顺序扫、漏掉盘面上的即胜点
  for (const i of root.legal) {
    board[i] = toMove
    const win = isWinningMove(board, i, toMove)
    board[i] = 0
    if (win) {
      return {
        pos: { x: i % SIZE, y: Math.floor(i / SIZE) },
        q: 1,
        sims: 0,
        depth: 1,
        top: [{ pos: { x: i % SIZE, y: Math.floor(i / SIZE) }, n: 1 }],
        visits: [{ i, n: 1, q: 1 }]
      }
    }
  }

  // 工作棋盘：下沉时落子、回退时清子
  const work = board.slice() as Board
  const path: number[] = [] // 本次模拟在 work 上落过的 cell
  let maxDepth = 0
  let done = 0

  const backup = (node: MctsNode, v: number): void => {
    // v 是 node.toMove 视角；节点统计「走入该节点一方」的价值 = -v
    let cur: MctsNode | null = node
    while (cur) {
      cur.n++
      cur.w += -v
      v = -v
      cur = cur.parent
    }
  }

  const unwind = (): void => {
    for (let k = path.length - 1; k >= 0; k--) work[path[k]] = 0
    path.length = 0
  }

  const sim = async (): Promise<void> => {
    // 每次模拟结束必须把下沉路径从工作棋盘上清掉，否则棋盘跨模拟累积脏子
    try {
      let node = root
      let ply = 0
      // ---- 选路下沉 ----
      for (;;) {
        if (node.terminalValue !== null) {
          backup(node, node.terminalValue)
          if (ply > maxDepth) maxDepth = ply
          return
        }
        if (node.priors === null) break // 未展开叶

        const sqrtN = Math.sqrt(node.n)
        let bestK = -1
        let bestU = -Infinity
        for (let k = 0; k < node.legal.length; k++) {
          const c = node.children[k]
          const q = c && c.n > 0 ? c.w / c.n : 0
          const p = node.priors[k]
          const u = q + cpuct * p * (sqrtN / (1 + (c ? c.n : 0)))
          if (u > bestU) {
            bestU = u
            bestK = k
          }
        }
        const moveI = node.legal[bestK]
        work[moveI] = node.toMove
        path.push(moveI)
        ply++

        let child = node.children[bestK]
        if (!child) {
          if (isWinningMove(work, moveI, node.toMove)) {
            // 落子即成五：终局，价值 = -1（child.toMove 视角，已输）
            child = makeNode(node, moveI, node.toMove === 1 ? 2 : 1)
            child.terminalValue = -1
            child.n = 1
            child.w = 1 // 走入该节点一方（即 node.toMove）赢
            node.children[bestK] = child
            backup(child, child.terminalValue)
            if (ply > maxDepth) maxDepth = ply
            return
          }
          child = makeNode(node, moveI, node.toMove === 1 ? 2 : 1)
          node.children[bestK] = child
        }
        node = child
      }

      // ---- 展开：网络评估叶节点 ----
      const { policy, value } = await net(work, node.toMove, ply)
      if (ply > maxDepth) maxDepth = ply
      const legal = legalMoves(work, node.toMove)
      if (legal.length === 0) {
        // 无合法手：满盘和棋；黑方全禁手判负（近似口径：有空点即判负）
        let hasEmpty = false
        for (let i = 0; i < SIZE * SIZE; i++)
          if (work[i] === 0) {
            hasEmpty = true
            break
          }
        node.terminalValue = hasEmpty ? -1 : 0
        backup(node, node.terminalValue)
        return
      }
    const logits: number[] = []
    for (const i of legal) logits.push(policy[i] ?? 0)
    node.priors = softmax(logits)
    // 根先验噪声：并行多树的多样性来源（仅根展开时施加）
    if (node === root && opts.rootNoise) {
      const rng = makeRng(opts.rootNoise.seed)
      const noise = dirichlet(rng, opts.rootNoise.alpha, node.priors.length)
      for (let k = 0; k < node.priors.length; k++) {
        node.priors[k] = (1 - opts.rootNoise.eps) * node.priors[k] + opts.rootNoise.eps * noise[k]
      }
    }
    node.legal = legal
    node.children = new Array(legal.length).fill(null)
    backup(node, value)
    } finally {
      unwind()
    }
  }

  // 至少完成 1 次模拟（首模拟不受 deadline 限制）
  await sim()
  done++
  while (done < opts.sims && Date.now() <= opts.deadline) {
    await sim()
    done++
  }

  // ---- 按访问次数选点 ----
  let bestK = -1
  let bestN = -1
  for (let k = 0; k < root.legal.length; k++) {
    const c = root.children[k]
    const n = c ? c.n : 0
    if (n > bestN) {
      bestN = n
      bestK = k
    }
  }
  if (bestK < 0) return null
  const bestChild = root.children[bestK]
  const q = bestChild && bestChild.n > 0 ? bestChild.w / bestChild.n : 0
  const visits: MctsVisit[] = root.legal.map((i, k) => {
    const c = root.children[k]
    return { i, n: c ? c.n : 0, q: c && c.n > 0 ? c.w / c.n : 0 }
  })
  const posOf = (i: number): Pos => ({ x: i % SIZE, y: Math.floor(i / SIZE) })
  const top = visits
    .slice()
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((v) => ({ pos: posOf(v.i), n: v.n }))

  return {
    pos: { x: root.legal[bestK] % SIZE, y: Math.floor(root.legal[bestK] / SIZE) },
    q,
    sims: done,
    depth: maxDepth,
    top,
    visits
  }
}
