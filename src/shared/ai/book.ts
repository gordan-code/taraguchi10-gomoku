/**
 * 开局库（book）：塔拉山口-10 开局前几手（第 5、6 手）的策略查询表。
 *
 * - 由 scripts/gen-opening-book.mjs 生成：驱动应用 FSM 枚举开局决策树
 *   （交换/走法选择按应用自身决策、落子按策略 top-2 分支），
 *   在每个 PLAY 落子节点用价值微调后的策略网络记录最佳着。
 * - 键 = 棋盘 + 行棋方在 8 种对称变换下的规范化串（覆盖率 ×8）；
 *   着法存储在规范坐标系，查询时经逆变换还原，再做合法性兜底校验。
 * - 命中即直接落子（毫秒级），未命中回退正常引擎流程。
 */
import { Board, Color, Pos, SIZE, idx } from '../types'
import { GameState, movePlacementLegal } from '../fsm'
import rawBook from './opening-book.json'

export interface BookMove {
  /** 规范坐标系下的 cell index（y*15+x） */
  i: number
  /** 生成时的策略权重（top1=2, top2=1），越大越优先 */
  w: number
}

export type BookData = Record<string, BookMove[]>

const book: BookData = rawBook as BookData

// ---------------------------------------------------------------- 对称变换（15×15）

interface Sym {
  /** (x,y) -> (x',y') */
  f: (x: number, y: number) => [number, number]
  /** 逆变换（同名字段成对互逆） */
  inv: (x: number, y: number) => [number, number]
}

const id: Sym = { f: (x, y) => [x, y], inv: (x, y) => [x, y] }
const rot90: Sym = { f: (x, y) => [14 - y, x], inv: (x, y) => [y, 14 - x] }
const rot180: Sym = { f: (x, y) => [14 - x, 14 - y], inv: (x, y) => [14 - x, 14 - y] }
const rot270: Sym = { f: (x, y) => [y, 14 - x], inv: (x, y) => [14 - y, x] }
const flipX: Sym = { f: (x, y) => [x, 14 - y], inv: (x, y) => [x, 14 - y] }
const flipY: Sym = { f: (x, y) => [14 - x, y], inv: (x, y) => [14 - x, y] }
const transpose: Sym = { f: (x, y) => [y, x], inv: (x, y) => [y, x] }
const anti: Sym = { f: (x, y) => [14 - y, 14 - x], inv: (x, y) => [14 - y, 14 - x] }

export const SYMS: Sym[] = [id, rot90, rot180, rot270, flipX, flipY, transpose, anti]

function applySym(s: Sym, board: Board): string {
  const out = new Array<string>(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [tx, ty] = s.f(x, y)
      out[ty * SIZE + tx] = String(board[y * SIZE + x])
    }
  }
  return out.join('')
}

/**
 * 规范键：8 种对称变换下棋盘串的最小值 + 行棋方。
 * inverseOut 若传入，写入「规范坐标系 → 实际坐标系」的变换
 * （即把实际局面映射到规范系的那个变换的逆）。
 */
export function canonicalKey(board: Board, turn: Color, inverseOut?: { sym: Sym }): string {
  let best = ''
  let bestSym: Sym = id
  for (const s of SYMS) {
    const k = applySym(s, board)
    if (best === '' || k < best) {
      best = k
      bestSym = s
    }
  }
  if (inverseOut) inverseOut.sym = { f: bestSym.inv, inv: bestSym.f }
  return best + '|' + turn
}

// ---------------------------------------------------------------- 查询

const BOOK_MAX_MOVES = 6 // 只在开局前 6 手内生效

/** 开局库查询：命中返回合法着法，未命中/不合法返回 null。state 不会被修改。 */
export function lookupBookMove(state: GameState): Pos | null {
  if (state.moves.length >= BOOK_MAX_MOVES || state.phase !== 'PLAY') return null
  // 行棋方色：交换会改变 blackOwner，不能按手数奇偶硬算
  // （第 5 手必为黑方行动：黑方拥有者索引与手数同奇偶时执黑者行动）
  const turn: Color = state.moves.length % 2 === state.blackOwner ? 1 : 2
  const inv: { sym: Sym } = { sym: id }
  const key = canonicalKey(state.board, turn, inv)
  const entries = book[key]
  if (!entries || entries.length === 0) return null
  // 权重降序取第一个合法的（变换回实际坐标系后校验）
  for (const e of [...entries].sort((a, b) => b.w - a.w)) {
    const [rx, ry] = inv.sym.f(Math.floor(e.i / SIZE), e.i % SIZE)
    const pos: Pos = { x: rx, y: ry }
    if (state.board[idx(pos.x, pos.y)] !== 0) continue
    if (movePlacementLegal(state, pos) !== null) continue
    return pos
  }
  return null
}

/** 测试/调试辅助：键数量 */
export function bookSize(): number {
  return Object.keys(book).length
}
