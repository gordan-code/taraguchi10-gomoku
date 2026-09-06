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
        top: [{ pos: { x: i % SIZE, y: Math.floor(i / SIZE) }, n: 1 }]
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
  const top = root.legal
    .map((i, k) => ({ i, n: root.children[k] ? root.children[k]!.n : 0 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map(({ i, n }) => ({ pos: { x: i % SIZE, y: Math.floor(i / SIZE) }, n }))

  return {
    pos: { x: root.legal[bestK] % SIZE, y: Math.floor(root.legal[bestK] / SIZE) },
    q,
    sims: done,
    depth: maxDepth,
    top
  }
}
