/**
 * 连珠黑方禁手判定（三三 / 四四 / 长连）。
 *
 * 约定：board 中 p 点已经放上黑子，再判定这手棋是否禁手。
 * 五连优先：若该手恰好形成五连，直接返回 null（不算禁手，黑胜）。
 *
 * 三的判定遵循 RIF 严格口径：只有能一步成"真活四"（两端均为可成五的点）
 * 且该成四点本身不是黑方禁手点的三，才计入活三（假三不计）。
 * 递归校验深度有限（MAX_DEPTH），足够覆盖实战与经典争议局面。
 */
import { Board, Color, ForbiddenKind, Pos, Stone } from './types'
import { findWinningLine, runLength } from './board'

const BLACK: Color = 1
const MAX_DEPTH = 3

/** 提取经过 p 的某方向整条线（15 个格），返回格子下标 0..14 与坐标 */
function lineOf(
  board: Board,
  p: Pos,
  dx: number,
  dy: number
): { stones: Stone[]; positions: Pos[] } {
  const stones: Stone[] = []
  const positions: Pos[] = []
  for (let i = -7; i <= 7; i++) {
    const x = p.x + dx * i
    const y = p.y + dy * i
    // 沿方向逐格走出棋盘即止（线最长 15）
    if (x < 0 || x > 14 || y < 0 || y > 14) continue
    stones.push(board[y * 15 + x])
    positions.push({ x, y })
  }
  return { stones, positions }
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1]
]

/**
 * 统计落 p 后（p 已为黑）各方向上"四"的数量（活四计 1 个）。
 * 返回所有四的黑子坐标集合（按方向分组去重）。
 */
function countFours(board: Board, p: Pos): number {
  let total = 0
  for (const [dx, dy] of DIRS) {
    const { stones, positions } = lineOf(board, p, dx, dy)
    const pi = positions.findIndex((q) => q.x === p.x && q.y === p.y)
    if (pi < 0) continue
    const seen = new Set<string>()
    const n = stones.length
    // 枚举包含 pi 的 5 格窗口
    for (let start = Math.max(0, pi - 4); start <= Math.min(pi, n - 5); start++) {
      let black = 0
      let emptyIdx = -1
      let ok = true
      for (let k = start; k < start + 5; k++) {
        const s = stones[k]
        if (s === 1) black++
        else if (s === 0) emptyIdx = k
        else {
          ok = false
          break
        }
      }
      if (!ok || black !== 4 || emptyIdx < 0) continue
      // 补上空点后须恰好五连（窗口外两端不能也是黑）
      const before = start - 1 >= 0 ? stones[start - 1] : 2
      const after = start + 5 < n ? stones[start + 5] : 2
      if (before === 1 || after === 1) continue // 会成长连，五点无效 → 不构成"四"
      // 四的黑子集合（窗口内除空点外的 4 格）
      const key = positions
        .slice(start, start + 5)
        .filter((_, k) => start + k !== emptyIdx)
        .map((q) => `${q.x},${q.y}`)
        .sort()
        .join('|')
      seen.add(key)
    }
    total += seen.size
  }
  return total
}

/**
 * 统计落 p 后（p 已为黑）各方向上"活三"的数量。
 * 活三定义：存在空点 e，在 e 落黑子后形成包含 p 与 e 的真活四
 * （恰好 4 连、两端空、且两端落子均恰好成五），
 * 且 e 点本身不是黑方禁手点（递归校验，深度受限）。
 */
function countThrees(board: Board, p: Pos, depth: number): number {
  let total = 0
  for (const [dx, dy] of DIRS) {
    const { stones, positions } = lineOf(board, p, dx, dy)
    const n = stones.length
    const pi = positions.findIndex((q) => q.x === p.x && q.y === p.y)
    if (pi < 0) continue
    const seen = new Set<string>()
    // 候选空点 e：与 p 同线且相距 ≤3（活四须同时包含 p 与 e）
    for (let ei = Math.max(0, pi - 3); ei <= Math.min(n - 1, pi + 3); ei++) {
      if (ei === pi || stones[ei] !== 0) continue
      // 模拟在 e 落黑
      const sim = stones.slice()
      sim[ei] = 1
      // 寻找包含 p 与 e、恰好 4 连、两端空且两端均为有效五点的活四
      let found = false
      let foundKey = ''
      for (let j = 0; j + 3 < n && !found; j++) {
        if (sim[j] !== 1 || sim[j + 1] !== 1 || sim[j + 2] !== 1 || sim[j + 3] !== 1) continue
        const lo = j - 1 >= 0 ? sim[j - 1] : 2
        const hi = j + 4 < n ? sim[j + 4] : 2
        if (lo !== 0 || hi !== 0) continue // 两端必须为空
        // 两端落子须恰好成五：更外侧一格不能是黑
        const lo2 = j - 2 >= 0 ? sim[j - 2] : 2
        const hi2 = j + 5 < n ? sim[j + 5] : 2
        if (lo2 === 1 || hi2 === 1) continue
        // 活四须包含 p 与 e
        const includesP = pi >= j && pi <= j + 3
        const includesE = ei >= j && ei <= j + 3
        if (!includesP || !includesE) continue
        // 严格口径：e 点本身不能是黑方禁手（递归）
        if (depth < MAX_DEPTH) {
          const ePos = positions[ei]
          const withE = board.slice() as Board
          withE[ePos.y * 15 + ePos.x] = 1
          if (checkForbidden(withE, ePos, depth + 1)) continue
        }
        found = true
        // 去重键 = 三本身的棋子集合（活四去掉成四点 e），同一三的两个成四端点归并为一个
        foundKey = [j, j + 1, j + 2, j + 3]
          .filter((k) => k !== ei)
          .map((k) => `${positions[k].x},${positions[k].y}`)
          .join('|')
      }
      if (found) seen.add(foundKey)
    }
    total += seen.size
  }
  return total
}

/**
 * 判定 p 点（已放黑子）这手棋是否禁手。
 * 返回禁手类型，null 表示合法。
 */
export function checkForbidden(board: Board, p: Pos, depth = 0): ForbiddenKind | null {
  // 五连优先：恰好五连直接获胜，即使同时构成其他禁手形态
  if (findWinningLine(board, p, BLACK, true)) return null
  if (runLength(board, p, BLACK) >= 6) return 'overline'
  if (countFours(board, p) >= 2) return 'double-four'
  if (depth < MAX_DEPTH && countThrees(board, p, depth) >= 2) return 'double-three'
  return null
}

/** 快速判断 p（已放黑子）是否恰好五连获胜 */
export function isBlackFive(board: Board, p: Pos): boolean {
  return findWinningLine(board, p, BLACK, true) !== null
}
