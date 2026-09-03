/**
 * AI 搜索引擎：Negamax + Alpha-Beta 剪枝 + 迭代加深 + 威胁启发排序。
 * 黑方落子自动过滤禁手点；终局（五连/长连）在搜索中直接判分。
 *
 * 阶段一强化（相对 v1.0 基线）：
 * - Zobrist 置换表（TT）：缓存「局面 → 分值/边界/最佳着」，命中复用 + 供走法排序。
 * - 走法排序增强：TT 最佳着 + 杀手着（killer）+ 历史启发（history）。
 * - 根节点 PVS + 期望窗口（aspiration），窗口失败自动全窗口重搜。
 */
import { AiLevel, Board, Color, Pos, SIZE, idx, inBounds } from '../types'
import { checkForbidden } from '../forbidden'

export interface SearchOptions {
  maxDepth: number
  timeMs: number
  width: number // 根节点/每层保留的候选宽度
  noise: number // 0~1，随机扰动强度（低难度用）
  /** 可选：根候选子集（并行根拆分时由主 Worker 指定，子 Worker 只搜该子集） */
  rootMoves?: Pos[]
}

export const LEVELS: Record<AiLevel, SearchOptions> = {
  novice: { maxDepth: 2, timeMs: 600, width: 8, noise: 0.5 },
  amateur: { maxDepth: 4, timeMs: 1500, width: 12, noise: 0.15 },
  advanced: { maxDepth: 6, timeMs: 4000, width: 16, noise: 0.03 },
  master: { maxDepth: 12, timeMs: 10000, width: 20, noise: 0 }
}

const MATE = 1_000_000

// ---------------------------------------------------------------- 评估函数

const W = [0, 2, 24, 320, 3600, 1_000_000]

/** 所有长度 ≥5 的线（行/列/两对角）的索引序列，静态预计算 */
const LINES: number[][] = (() => {
  const lines: number[][] = []
  for (let y = 0; y < SIZE; y++) lines.push(Array.from({ length: SIZE }, (_, x) => idx(x, y)))
  for (let x = 0; x < SIZE; x++) lines.push(Array.from({ length: SIZE }, (_, y) => idx(x, y)))
  // ↘：c = x - y，|c| ≤ 10（长度 ≥5）
  for (let c = -10; c <= 10; c++) {
    const line: number[] = []
    for (let x = 0; x < SIZE; x++) {
      const y = x - c
      if (y >= 0 && y < SIZE) line.push(idx(x, y))
    }
    if (line.length >= 5) lines.push(line)
  }
  // ↗：c = x + y，4 ≤ c ≤ 24
  for (let c = 4; c <= 24; c++) {
    const line: number[] = []
    for (let x = 0; x < SIZE; x++) {
      const y = c - x
      if (y >= 0 && y < SIZE) line.push(idx(x, y))
    }
    if (line.length >= 5) lines.push(line)
  }
  return lines
})()

/** 静态评估：黑方视角（正 = 黑优） */
export function evaluate(board: Board): number {
  let score = 0
  for (const line of LINES) {
    for (let i = 0; i + 5 <= line.length; i++) {
      let b = 0
      let w = 0
      for (let k = 0; k < 5; k++) {
        const s = board[line[i + k]]
        if (s === 1) b++
        else if (s === 2) w++
      }
      if (b > 0 && w > 0) continue
      if (b > 0) score += W[b]
      else if (w > 0) score -= W[w]
    }
  }
  return score
}

// ---------------------------------------------------------------- 候选生成与排序

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1]
]

/** 与任意棋子距离 ≤2 的空点 */
export function candidateMoves(board: Board, radius = 2): Pos[] {
  const out: Pos[] = []
  const seen = new Set<number>()
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (board[idx(x, y)] === 0) continue
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (!inBounds(nx, ny)) continue
          const i = idx(nx, ny)
          if (board[i] !== 0 || seen.has(i)) continue
          seen.add(i)
          out.push({ x: nx, y: ny })
        }
      }
    }
  }
  if (out.length === 0) out.push({ x: 7, y: 7 })
  return out
}

/** 单点启发分：自己在此落子的进攻价值 + 防守价值 */
function quickScore(board: Board, p: Pos, color: Color): number {
  const opp: Color = color === 1 ? 2 : 1
  return shapeScore(board, p, color) + 0.75 * shapeScore(board, p, opp)
}

function shapeScore(board: Board, p: Pos, color: Color): number {
  let total = 0
  for (const [dx, dy] of DIRS) {
    let cnt = 1
    let openEnds = 0
    let jump = 0
    for (const s of [1, -1]) {
      let step = 1
      for (;;) {
        const x = p.x + dx * step * s
        const y = p.y + dy * step * s
        if (!inBounds(x, y)) break
        const st = board[idx(x, y)]
        if (st === color) {
          cnt++
        } else if (st === 0 && jump === 0) {
          // 允许一个跳空点（跳三/跳四）
          const nx = p.x + dx * (step + 1) * s
          const ny = p.y + dy * (step + 1) * s
          if (inBounds(nx, ny) && board[idx(nx, ny)] === color) {
            jump++
            step++
            continue
          }
          openEnds++
          break
        } else break
        step++
      }
    }
    if (cnt >= 5) total += 100000
    else if (cnt === 4) total += openEnds > 0 ? 5000 : 2000
    else if (cnt === 3) total += openEnds === 2 ? 800 : openEnds === 1 ? 300 : 0
    else if (cnt === 2) total += openEnds === 2 ? 60 : openEnds === 1 ? 20 : 0
    else total += openEnds === 2 ? 4 : 1
  }
  return total
}

// ---------------------------------------------------------------- 终局判定

/** 落子后是否立即获胜（黑：恰好五连；白：≥5 连） */
function isWinningStone(board: Board, p: Pos, color: Color): boolean {
  for (const [dx, dy] of DIRS) {
    let cnt = 1
    for (const s of [1, -1]) {
      let step = 1
      for (;;) {
        const x = p.x + dx * step * s
        const y = p.y + dy * step * s
        if (!inBounds(x, y) || board[idx(x, y)] !== color) break
        cnt++
        step++
      }
    }
    if (color === 2 ? cnt >= 5 : cnt === 5) return true
  }
  return false
}

// ---------------------------------------------------------------- VCF（连续冲四）

/**
 * 落子 p（已放 color）后，返回所有「再落一子即成五」的空点（四的成五点）。
 * 与 rule.py 的 _count_fours 同口径：仅统计补齐后「恰好五连」的四（窗口外不能还是 color，
 * 否则补齐成 6+，黑方为长连、白方虽也算胜但此处按保守口径只认恰好五）。
 */
export function fourWinningPoints(board: Board, p: Pos, color: Color): number[] {
  const opp: Color = color === 1 ? 2 : 1
  const out = new Set<number>()
  for (const [dx, dy] of DIRS) {
    const cells: number[] = []
    const positions: Pos[] = []
    for (let s = -7; s <= 7; s++) {
      const x = p.x + dx * s
      const y = p.y + dy * s
      if (!inBounds(x, y)) continue
      cells.push(idx(x, y))
      positions.push({ x, y })
    }
    const pi = positions.findIndex((q) => q.x === p.x && q.y === p.y)
    if (pi < 0) continue
    const n = cells.length
    for (let start = Math.max(0, pi - 4); start <= Math.min(pi, n - 5); start++) {
      let cnt = 0
      let emptyIdx = -1
      let ok = true
      for (let k = start; k < start + 5; k++) {
        const s = board[cells[k]]
        if (s === color) cnt++
        else if (s === 0) emptyIdx = k
        else {
          ok = false
          break
        }
      }
      if (!ok || cnt !== 4 || emptyIdx < 0) continue
      const before = start - 1 >= 0 ? board[cells[start - 1]] : opp
      const after = start + 5 < n ? board[cells[start + 5]] : opp
      if (before === color || after === color) continue
      out.add(cells[emptyIdx])
    }
  }
  return Array.from(out)
}

/** 返回能形成「四」或直接成五的着法（cell index）。黑方已过滤禁手。 */
export function fourThreatMoves(board: Board, color: Color): number[] {
  const out: number[] = []
  for (const p of candidateMoves(board, 2)) {
    const i = idx(p.x, p.y)
    board[i] = color
    let threat = false
    if (isWinningStone(board, p, color)) threat = true
    else if (fourWinningPoints(board, p, color).length > 0) threat = true
    board[i] = 0
    if (!threat) continue
    if (color === 1) {
      board[i] = 1
      const forbidden = checkForbidden(board, p) !== null
      board[i] = 0
      if (forbidden) continue
    }
    out.push(i)
  }
  return out
}

const VCF_MAX_DEPTH = 14
const VCF_NODE_LIMIT = 15000

/**
 * 纯四强制连将（VCF）：返回 color 方必胜首着 cell index，无则 -1。
 * 保守口径：若对手的挡点自身形成反威胁（成五/成四），该线判失败（交给 VCT/Negamax）。
 */
function vcfWin(board: Board, color: Color, depth: number, budget: { n: number }): number {
  if (depth <= 0) return -1
  if (++budget.n > VCF_NODE_LIMIT) return -1
  const opp: Color = color === 1 ? 2 : 1
  for (const i of fourThreatMoves(board, color)) {
    const p = { x: i % SIZE, y: Math.floor(i / SIZE) }
    board[i] = color
    let win = false
    if (isWinningStone(board, p, color)) {
      win = true
    } else {
      const fp = fourWinningPoints(board, p, color)
      if (fp.length >= 2) {
        win = true // 活四 / 双四（双威胁）
      } else if (fp.length === 1) {
        const w = fp[0]
        const wPos = { x: w % SIZE, y: Math.floor(w / SIZE) }
        board[w] = opp
        const counter =
          isWinningStone(board, wPos, opp) || fourWinningPoints(board, wPos, opp).length > 0
        if (!counter && vcfWin(board, color, depth - 1, budget) >= 0) win = true
        board[w] = 0
      }
    }
    board[i] = 0
    if (win) return i
  }
  return -1
}

/** 落 p（已放 color）后，返回「再落 color 即形成四（4 子 + 1 空）」的空点（三的延伸点/防守点）。 */
export function threeFourPoints(board: Board, p: Pos, color: Color): number[] {
  const out = new Set<number>()
  for (const [dx, dy] of DIRS) {
    const cells: number[] = []
    const positions: Pos[] = []
    for (let s = -7; s <= 7; s++) {
      const x = p.x + dx * s
      const y = p.y + dy * s
      if (!inBounds(x, y)) continue
      cells.push(idx(x, y))
      positions.push({ x, y })
    }
    const pi = positions.findIndex((q) => q.x === p.x && q.y === p.y)
    if (pi < 0) continue
    const n = cells.length
    for (let start = Math.max(0, pi - 4); start <= Math.min(pi, n - 5); start++) {
      let cnt = 0
      const empties: number[] = []
      let ok = true
      for (let k = start; k < start + 5; k++) {
        const s = board[cells[k]]
        if (s === color) cnt++
        else if (s === 0) empties.push(cells[k])
        else {
          ok = false
          break
        }
      }
      if (!ok || cnt !== 3 || empties.length !== 2) continue
      for (const e of empties) out.add(e)
    }
  }
  return Array.from(out)
}

/** 威胁着：成五 / 成四 / 成三（活三），黑方已过滤禁手。 */
function threatMoves(board: Board, color: Color): number[] {
  const out: number[] = []
  for (const p of candidateMoves(board, 2)) {
    const i = idx(p.x, p.y)
    board[i] = color
    let threat = false
    if (isWinningStone(board, p, color)) threat = true
    else if (fourWinningPoints(board, p, color).length > 0) threat = true
    else if (threeFourPoints(board, p, color).length > 0) threat = true
    board[i] = 0
    if (!threat) continue
    if (color === 1) {
      board[i] = 1
      const forbidden = checkForbidden(board, p) !== null
      board[i] = 0
      if (forbidden) continue
    }
    out.push(i)
  }
  return out
}

/** 快速判断 color 方是否存在「成五/成四」的威胁着（短路）。 */
function hasFourThreat(board: Board, color: Color): boolean {
  for (const p of candidateMoves(board, 2)) {
    const i = idx(p.x, p.y)
    board[i] = color
    const threat = isWinningStone(board, p, color) || fourWinningPoints(board, p, color).length > 0
    board[i] = 0
    if (!threat) continue
    if (color === 1) {
      board[i] = 1
      const forbidden = checkForbidden(board, p) !== null
      board[i] = 0
      if (forbidden) continue
    }
    return true
  }
  return false
}

/** 按局面复杂度动态分配搜索时间：存在成五/成四威胁的关键局面多花、稀疏局面少花。 */
export function dynamicTimeMs(board: Board, color: Color, baseMs: number): number {
  const b = board.slice() as Board // 副本，避免临时落子触发响应式副作用
  const critical = hasFourThreat(b, color) || hasFourThreat(b, color === 1 ? 2 : 1)
  let stones = 0
  for (let i = 0; i < SIZE * SIZE; i++) if (board[i] !== 0) stones++
  const density = stones / (SIZE * SIZE)
  if (critical) return baseMs * 1.5
  return baseMs * (0.5 + density)
}

const VCT_MAX_DEPTH = 10
const VCT_NODE_LIMIT = 1000
const VCT_TIME_BUDGET = 80 // 毫秒：单次根节点 VCT 探测的耗时上限
const VCT_SEARCH_BUDGET = 120 // 毫秒：整次搜索内叶节点 VCT 的总耗时上限

/**
 * 威胁空间搜索（VCT，含 VCF）：返回 color 方必胜首着 cell index，无则 -1。
 * 保守口径：对手挡点后若其自身仍存在成五/成四威胁，则该线判失败（避免假胜）。
 * 受节点数 + 时间双上限约束，超限直接返回 -1（交给 Negamax）。
 */
function vctWin(board: Board, color: Color, depth: number, budget: { n: number; deadline: number }): number {
  if (depth <= 0) return -1
  if (++budget.n > VCT_NODE_LIMIT || Date.now() > budget.deadline) return -1
  const opp: Color = color === 1 ? 2 : 1
  for (const i of threatMoves(board, color)) {
    const p = { x: i % SIZE, y: Math.floor(i / SIZE) }
    board[i] = color
    let win = false
    if (isWinningStone(board, p, color)) {
      win = true
    } else {
      const fp = fourWinningPoints(board, p, color)
      if (fp.length >= 2) {
        win = true // 活四 / 双四（双威胁）
      } else {
        const defenses = fp.length === 1 ? fp : threeFourPoints(board, p, color)
        win = defenses.length > 0
        for (const d of defenses) {
          const dPos = { x: d % SIZE, y: Math.floor(d / SIZE) }
          board[d] = opp
          const counter = isWinningStone(board, dPos, opp) || hasFourThreat(board, opp)
          let subWin = false
          if (!counter) subWin = vctWin(board, color, depth - 1, budget) >= 0
          board[d] = 0
          if (!subWin) {
            win = false
            break
          }
        }
      }
    }
    board[i] = 0
    if (win) return i
  }
  return -1
}

/**
 * 必胜探测（VCT/VCF 威胁空间搜索）：返回 color 方必胜首着 cell index，无则 -1。
 * 独立暴露给 Rust/WASM 路径：WASM 内核只做 Negamax（不含威胁空间搜索），
 * 主 Worker 先在 TS 侧做毫秒级 VCT 预探，命中必胜直接落子，否则交给 WASM 深层搜索。
 */
export function probeForcedWin(board: Board, color: Color): number {
  return vctWin(board.slice() as Board, color, VCT_MAX_DEPTH, {
    n: 0,
    deadline: Date.now() + VCT_TIME_BUDGET
  })
}

// ---------------------------------------------------------------- Zobrist 哈希

const ZOBRIST = new Uint32Array(SIZE * SIZE * 3)
for (let i = 0; i < ZOBRIST.length; i++) ZOBRIST[i] = (Math.random() * 4294967296) >>> 0
// 颜色盐：区分「同棋盘、不同轮到谁」的局面
const COLOR_SALT = new Uint32Array(3)
COLOR_SALT[1] = (Math.random() * 4294967296) >>> 0
COLOR_SALT[2] = (Math.random() * 4294967296) >>> 0

const zobristAt = (i: number, stone: number): number => ZOBRIST[i * 3 + stone]

function boardHash(board: Board): number {
  let h = 0
  for (let i = 0; i < SIZE * SIZE; i++) {
    const s = board[i]
    if (s !== 0) h ^= ZOBRIST[i * 3 + s]
  }
  return h >>> 0
}

// ---------------------------------------------------------------- 置换表

interface TTEntry {
  depth: number // 已搜索的剩余深度
  score: number
  flag: 0 | 1 | 2 // 0 exact / 1 lower / 2 upper
  move: number // 最佳着（单元格 index），-1 表示无
}

const TT_MAX = 1 << 20

// ---------------------------------------------------------------- 搜索

export interface SearchResult {
  move: Pos | null
  score: number
  depth: number
  nodes: number
  timedOut: boolean
  /** 并行根拆分时参与的线程数（单线程缺省） */
  threads?: number
}

/** 迭代加深过程中每个深度完成时的实时进度（供 UI 动态展示） */
export interface SearchProgress {
  depth: number
  score: number
  nodes: number
  elapsedMs: number
}
export type ProgressHandler = (p: SearchProgress) => void

class Timeout extends Error {}

interface Ctx {
  deadline: number
  nodes: number
  board: Board
  hash: number
  tt: Map<number, TTEntry>
  killers: Array<[number, number]>
  history: Float64Array
  leafVct: boolean
  vctDeadline: number
}

function orderedCandidates(
  ctx: Ctx,
  color: Color,
  width: number,
  ttMove: number,
  ply: number
): Pos[] {
  const cands = candidateMoves(ctx.board, 2)
  const k = ctx.killers[ply] ?? [0, 0]
  const k1 = k[0]
  const k2 = k[1]
  const scored = cands.map((p) => {
    const i = idx(p.x, p.y)
    let s = quickScore(ctx.board, p, color) * 16
    if (i === ttMove) s += 1 << 30 // TT 最佳着置顶
    else if (i === k1) s += 1 << 28
    else if (i === k2) s += 1 << 27
    s += ctx.history[i] // 历史启发（小权重）
    return { p, s }
  })
  scored.sort((a, b) => b.s - a.s)
  let top = scored.slice(0, width).map((e) => e.p)
  if (color === 1) {
    // 黑方过滤禁手点
    top = top.filter((p) => {
      const i = idx(p.x, p.y)
      ctx.board[i] = 1
      const ok = checkForbidden(ctx.board, p) === null
      ctx.board[i] = 0
      return ok
    })
  }
  return top
}

function negamax(ctx: Ctx, color: Color, depth: number, alpha: number, beta: number, ply: number): number {
  ctx.nodes++
  if ((ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) throw new Timeout()

  const opp: Color = color === 1 ? 2 : 1
  const key = (ctx.hash ^ COLOR_SALT[color]) >>> 0

  // 置换表探测
  let ttMove = -1
  const entry = ctx.tt.get(key)
  if (entry && entry.depth >= depth) {
    if (entry.flag === 0) return entry.score
    if (entry.flag === 1 && entry.score >= beta) return entry.score
    if (entry.flag === 2 && entry.score <= alpha) return entry.score
    ttMove = entry.move
  }

  if (depth === 0) {
    // 叶节点威胁探测（仅中高难度启用）：在评估前识别当前方是否有强制胜（VCT）
    if (ctx.leafVct && Date.now() < ctx.vctDeadline) {
      const w = vctWin(ctx.board, color, VCT_MAX_DEPTH, { n: 0, deadline: ctx.vctDeadline })
      if (w >= 0) return MATE - ply
    }
    return (color === 1 ? 1 : -1) * evaluate(ctx.board)
  }

  const cands = orderedCandidates(ctx, color, 24, ttMove, ply)
  if (cands.length === 0) {
    // 黑方所有候选均为禁手 → 黑只能走禁手 → 黑负
    return color === 1 ? -MATE + ply : MATE - ply
  }

  let best = -Infinity
  let bestMove = -1
  let a = alpha
  let first = true
  for (const p of cands) {
    const i = idx(p.x, p.y)
    ctx.board[i] = color
    ctx.hash ^= zobristAt(i, color)
    let val: number
    if (isWinningStone(ctx.board, p, color)) {
      val = MATE - ply
    } else if (first) {
      val = -negamax(ctx, opp, depth - 1, -beta, -a, ply + 1)
      first = false
    } else {
      // PVS：零窗口试探，未 fail-high 则全窗口重搜
      val = -negamax(ctx, opp, depth - 1, -(a + 1), -a, ply + 1)
      if (val > a && val < beta) {
        val = -negamax(ctx, opp, depth - 1, -beta, -a, ply + 1)
      }
    }
    ctx.hash ^= zobristAt(i, color)
    ctx.board[i] = 0

    if (val > best) {
      best = val
      bestMove = i
    }
    if (val > a) a = val
    if (a >= beta) {
      // 截断：记录杀手着与历史
      const k = ctx.killers[ply]
      if (k[0] !== i) {
        k[1] = k[0]
        k[0] = i
      }
      ctx.history[i] += depth
      break
    }
  }

  let flag: 0 | 1 | 2
  if (best <= alpha) flag = 2
  else if (best >= beta) flag = 1
  else flag = 0

  if (ctx.tt.size >= TT_MAX) ctx.tt.clear()
  ctx.tt.set(key, { depth, score: best, flag, move: bestMove })

  return best
}

function searchRoot(
  ctx: Ctx,
  color: Color,
  opp: Color,
  cands: Pos[],
  depth: number,
  alpha: number,
  beta: number,
  noise: number
): { move: Pos; score: number } {
  let a = alpha
  let bestMove = cands[0]
  let bestScore = -Infinity
  for (let j = 0; j < cands.length; j++) {
    const p = cands[j]
    const i = idx(p.x, p.y)
    ctx.board[i] = color
    ctx.hash ^= zobristAt(i, color)
    let val: number
    if (isWinningStone(ctx.board, p, color)) {
      val = MATE
    } else if (j === 0) {
      val = -negamax(ctx, opp, depth - 1, -beta, -a, 1)
    } else {
      val = -negamax(ctx, opp, depth - 1, -(a + 1), -a, 1)
      if (val > a && val < beta) {
        val = -negamax(ctx, opp, depth - 1, -beta, -a, 1)
      }
    }
    ctx.hash ^= zobristAt(i, color)
    ctx.board[i] = 0
    if (noise > 0) val += (Math.random() - 0.5) * noise * 500
    if (val > bestScore) {
      bestScore = val
      bestMove = p
    }
    if (val > a) a = val
  }
  return { move: bestMove, score: bestScore }
}

/** 迭代加深搜索最佳落子（board 不会被修改）。onProgress 在每个深度完成时回调（可选，用于 UI 实时展示）。 */
export function searchBestMove(
  board: Board,
  color: Color,
  opts: SearchOptions,
  onProgress?: ProgressHandler
): SearchResult {
  const startTime = Date.now()
  const ctx: Ctx = {
    deadline: Date.now() + opts.timeMs,
    nodes: 0,
    board: board.slice() as Board,
    hash: boardHash(board),
    tt: new Map(),
    killers: Array.from({ length: opts.maxDepth + 2 }, () => [0, 0] as [number, number]),
    history: new Float64Array(SIZE * SIZE),
    leafVct: opts.maxDepth >= 4,
    vctDeadline: Date.now() + VCT_SEARCH_BUDGET
  }
  const opp: Color = color === 1 ? 2 : 1
  const cands = opts.rootMoves ? opts.rootMoves : orderedCandidates(ctx, color, opts.width, -1, 0)

  // 一步取胜
  for (const p of cands) {
    const i = idx(p.x, p.y)
    ctx.board[i] = color
    const win = isWinningStone(ctx.board, p, color)
    ctx.board[i] = 0
    if (win) return { move: p, score: MATE, depth: 1, nodes: ctx.nodes, timedOut: false }
  }

  if (cands.length === 0) {
    // 黑方无合法点（极端）：任选空点
    const any = board.findIndex((s) => s === 0)
    return {
      move: any >= 0 ? { x: any % SIZE, y: Math.floor(any / SIZE) } : null,
      score: -MATE,
      depth: 0,
      nodes: 0,
      timedOut: false
    }
  }

  // VCT 必胜探测：威胁空间搜索（活四/双四/连续冲四/连续威胁），带时间上限
  const vctMove = vctWin(ctx.board, color, VCT_MAX_DEPTH, { n: 0, deadline: Date.now() + VCT_TIME_BUDGET })
  if (vctMove >= 0) {
    return {
      move: { x: vctMove % SIZE, y: Math.floor(vctMove / SIZE) },
      score: MATE - 1,
      depth: 1,
      nodes: ctx.nodes,
      timedOut: false
    }
  }

  let bestMove = cands[0]
  let bestScore = -Infinity
  let reachedDepth = 0
  let timedOut = false

  try {
    let prevScore = 0
    for (let depth = 2; depth <= opts.maxDepth; depth += 2) {
      // 期望窗口：用上一层的分值 ±200；接近将死分值则用全窗口
      let alpha = -MATE
      let beta = MATE
      if (depth > 2 && Math.abs(prevScore) < MATE / 2) {
        alpha = prevScore - 200
        beta = prevScore + 200
      }
      let r = searchRoot(ctx, color, opp, cands, depth, alpha, beta, opts.noise)
      if (r.score <= alpha || r.score >= beta) {
        // 窗口失败：全窗口重搜该层
        r = searchRoot(ctx, color, opp, cands, depth, -MATE, MATE, opts.noise)
      }
      bestMove = r.move
      bestScore = r.score
      reachedDepth = depth
      prevScore = r.score
      onProgress?.({ depth, score: r.score, nodes: ctx.nodes, elapsedMs: Date.now() - startTime })
    }
  } catch {
    timedOut = true
  }

  return { move: bestMove, score: bestScore, depth: reachedDepth, nodes: ctx.nodes, timedOut }
}

/** 计算根候选（并行根拆分时由主 Worker 先算好再切分到各子 Worker）。 */
export function rootCandidates(board: Board, color: Color, width: number): Pos[] {
  const ctx: Ctx = {
    deadline: Infinity,
    nodes: 0,
    board: board.slice() as Board,
    hash: boardHash(board),
    tt: new Map(),
    killers: [],
    history: new Float64Array(SIZE * SIZE),
    leafVct: false,
    vctDeadline: 0
  }
  return orderedCandidates(ctx, color, width, -1, 0)
}
