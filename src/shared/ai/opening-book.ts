/**
 * 塔拉山口-10 开局库（框架）：按「阶段 + 对称归一化着法序列」查询推荐决策。
 *
 * 目前仅实现框架与对称归一化；完整的开局理论谱（哪些 3×3/5×5/7×7 点该下、何时交换、
 * 走法一/二优劣、十打点报价）需要外部权威数据填充 BOOK。命中返回推荐决策，未命中
 * 返回 null，由调用方回退到现有静态评估。
 */
import { GameEvent, GameState } from '../fsm'
import { Pos, posName } from '../types'

export interface BookEntry {
  event: Exclude<GameEvent, { type: 'resign' } | { type: 'timeout' }>
  reason: string
}

// key = 阶段 + ':' + 对称归一化后的着法序列
const BOOK = new Map<string, BookEntry>()

// —— 种子条目（待填充权威 Taraguchi-10 理论数据）——
// 例：BOOK.set('S1_SWAP:h8', { event: { type: 'swap', accept: false }, reason: '开局库：天元后不交换' })

/** 8 个对称（4 旋转 × 2 翻转）下的着法序列，取字典序最小者为规范形。 */
function canonicalKey(state: GameState): string {
  const variants: string[] = []
  for (let k = 0; k < 4; k++) {
    const rot = state.moves.map((p) => rotate(p, k))
    variants.push(rot.map(posName).join(''))
    variants.push(rot.map((p) => posName({ x: 14 - p.x, y: p.y })).join(''))
  }
  variants.sort()
  return state.phase + ':' + variants[0]
}

function rotate(p: Pos, k: number): Pos {
  let x = p.x
  let y = p.y
  for (let i = 0; i < k; i++) {
    const nx = 14 - y
    y = x
    x = nx
  }
  return { x, y }
}

/** 查询开局库：仅开局阶段生效；命中返回决策，未命中返回 null。 */
export function lookupOpeningBook(state: GameState): BookEntry | null {
  if (state.phase === 'PLAY' || state.phase === 'OVER') return null
  const key = canonicalKey(state)
  return BOOK.get(key) ?? null
}
