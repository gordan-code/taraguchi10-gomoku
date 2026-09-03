import { Board, Color, Pos, Stone, idx, inBounds, SIZE } from './types'

export function emptyBoard(): Board {
  return new Array(SIZE * SIZE).fill(0) as Board
}

export function cloneBoard(b: Board): Board {
  return b.slice() as Board
}

export function stoneAt(b: Board, p: Pos): Stone {
  return b[idx(p.x, p.y)]
}

export function withStone(b: Board, p: Pos, c: Color): Board {
  const n = cloneBoard(b)
  n[idx(p.x, p.y)] = c
  return n
}

/** 4 个方向：横、竖、两条对角线 */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1]
]

/**
 * 落子于 p 后，p 所在方向上连续同色棋子的最大长度（含 p）。
 */
export function runLength(b: Board, p: Pos, color: Color): number {
  let best = 1
  for (const [dx, dy] of DIRS) {
    let n = 1
    for (let s = 1; s < 8; s++) {
      const x = p.x + dx * s
      const y = p.y + dy * s
      if (!inBounds(x, y) || b[idx(x, y)] !== color) break
      n++
    }
    for (let s = 1; s < 8; s++) {
      const x = p.x - dx * s
      const y = p.y - dy * s
      if (!inBounds(x, y) || b[idx(x, y)] !== color) break
      n++
    }
    if (n > best) best = n
  }
  return best
}

/**
 * 落子后某方向上恰好五连的连线坐标（含 p），若无则返回 null。
 * 黑方要求恰好 5（长连不算五连）；白方 >=5 均可。
 */
export function findWinningLine(
  b: Board,
  p: Pos,
  color: Color,
  exact: boolean
): Pos[] | null {
  for (const [dx, dy] of DIRS) {
    const cells: Pos[] = [{ ...p }]
    for (let s = 1; s < 5; s++) {
      const x = p.x + dx * s
      const y = p.y + dy * s
      if (!inBounds(x, y) || b[idx(x, y)] !== color) break
      cells.push({ x, y })
    }
    for (let s = 1; s < 5; s++) {
      const x = p.x - dx * s
      const y = p.y - dy * s
      if (!inBounds(x, y) || b[idx(x, y)] !== color) break
      cells.unshift({ x, y })
    }
    const len = cells.length
    const ok = exact ? len === 5 : len >= 5
    if (ok) return cells
  }
  return null
}

/** 点 p 是否位于以天元为中心的 (2r+1)x(2r+1) 区域内 */
export function withinCentral(p: Pos, r: number): boolean {
  return Math.abs(p.x - 7) <= r && Math.abs(p.y - 7) <= r
}

/** p 与 q 是否关于天元中心对称 */
export function isCenterSymmetric(p: Pos, q: Pos): boolean {
  return p.x + q.x === 14 && p.y + q.y === 14
}
