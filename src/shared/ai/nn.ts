/**
 * 神经网络引擎（纯逻辑，不依赖 onnxruntime）：
 * - encodeNnState：把局面编码成 4 通道，与 Python 端 get_encoded_state 完全一致
 *   ch0=我的棋子, ch1=对手棋子, ch2=禁手生效(0/1), ch3=阶段(中盘恒 0)
 * - pickMoveFromPolicy：从 229 维 logits 里选当前棋手的最优合法落点（跳过占用与黑方禁手）
 */
import { Board, Color, Pos, SIZE } from '../types'
import { checkForbidden } from '../forbidden'
import { withStone } from '../board'

export const NN_CHANNELS = 4
export const NN_POS = SIZE * SIZE // 225
export const NN_ACTION = NN_POS + 4 // 229（225 落子 + 2 交换 + 2 走法）

/**
 * 编码局面为 (4,15,15) 通道优先的 Float32Array。
 * myColor 为当前棋手执子色（1 黑 / 2 白）；forbiddenActive 表示该手是否受禁手约束。
 */
export function encodeNnState(board: Board, myColor: Color, forbiddenActive: boolean): Float32Array {
  const oppColor: Color = myColor === 1 ? 2 : 1
  const n = NN_POS
  const out = new Float32Array(NN_CHANNELS * n)
  const fb = forbiddenActive ? 1 : 0
  for (let i = 0; i < n; i++) {
    const s = board[i]
    out[i] = s === myColor ? 1 : 0 // ch0 我的棋子
    out[n + i] = s === oppColor ? 1 : 0 // ch1 对手棋子
    out[2 * n + i] = fb // ch2 禁手生效
    out[3 * n + i] = 0 // ch3 阶段（中盘=0）
  }
  return out
}

export interface PickedMove {
  index: number
  pos: Pos
  logit: number
}

/**
 * 从 229 维 policy logits 里选出最优合法落点（argmax）。
 * 跳过已占用点；黑方跳过禁手点（五连优先，checkForbidden 已处理）。
 */
export function pickMoveFromPolicy(
  policy: Float32Array | number[],
  board: Board,
  myColor: Color
): PickedMove | null {
  let bestIndex = -1
  let bestLogit = -Infinity
  for (let i = 0; i < NN_POS; i++) {
    if (board[i] !== 0) continue // 已占用
    const x = i % SIZE
    const y = Math.floor(i / SIZE)
    if (myColor === 1) {
      const b = withStone(board, { x, y }, 1)
      if (checkForbidden(b, { x, y }) !== null) continue // 黑方禁手
    }
    const lg = policy[i]
    if (lg > bestLogit) {
      bestLogit = lg
      bestIndex = i
    }
  }
  if (bestIndex < 0) return null
  return { index: bestIndex, pos: { x: bestIndex % SIZE, y: Math.floor(bestIndex / SIZE) }, logit: bestLogit }
}
