import { describe, it, expect } from 'vitest'
import { encodeNnState, pickMoveFromPolicy, NN_CHANNELS, NN_POS } from '../ai/nn'
import { checkForbidden } from '../forbidden'
import { withStone } from '../board'
import { Board } from '../types'

function emptyBoard(): Board {
  return new Array(NN_POS).fill(0) as Board
}

describe('encodeNnState', () => {
  it('通道布局正确（my/opp/禁手/阶段）', () => {
    const board = emptyBoard()
    board[0] = 1 // 黑 (x=0,y=0)
    board[224] = 2 // 白 (x=14,y=14)
    const enc = encodeNnState(board, 1, true)
    expect(enc.length).toBe(NN_CHANNELS * NN_POS)
    // ch0 我的(黑)
    expect(enc[0]).toBe(1)
    expect(enc[224]).toBe(0)
    // ch1 对手(白)
    expect(enc[NN_POS + 0]).toBe(0)
    expect(enc[NN_POS + 224]).toBe(1)
    // ch2 禁手生效 = 1（黑）
    expect(enc[2 * NN_POS + 5]).toBe(1)
    // ch3 阶段 = 0
    expect(enc[3 * NN_POS + 5]).toBe(0)
  })

  it('交换视角（myColor=白）后 ch0/ch1 对调、禁手通道为 0', () => {
    const board = emptyBoard()
    board[0] = 1
    board[1] = 2
    const enc = encodeNnState(board, 2, false)
    expect(enc[0]).toBe(0) // 黑不是我的
    expect(enc[1]).toBe(1) // 白是我的
    expect(enc[NN_POS + 0]).toBe(1)
    expect(enc[NN_POS + 1]).toBe(0)
    expect(enc[2 * NN_POS + 0]).toBe(0) // 白无禁手
  })
})

describe('pickMoveFromPolicy', () => {
  it('选 argmax 合法点', () => {
    const board = emptyBoard()
    const policy = new Float32Array(229)
    policy[100] = 9
    policy[3] = 5
    const r = pickMoveFromPolicy(policy, board, 2)!
    expect(r.index).toBe(100)
    expect(r.pos).toEqual({ x: 100 % 15, y: Math.floor(100 / 15) })
  })

  it('跳过已占用点', () => {
    const board = emptyBoard()
    board[100] = 1
    const policy = new Float32Array(229)
    policy[100] = 9
    policy[3] = 5
    const r = pickMoveFromPolicy(policy, board, 2)!
    expect(r.index).toBe(3)
  })

  it('黑方跳过禁手点（双三）', () => {
    const board = emptyBoard()
    // 黑 (7,5)(7,6)(5,7)(6,7)，白若干；目标 (7,7)=idx112 为双三禁手
    board[82] = 1 // (7,5)
    board[97] = 1 // (7,6)
    board[110] = 1 // (5,7)
    board[111] = 1 // (6,7)
    board[0] = 2
    board[1] = 2
    board[15] = 2
    board[16] = 2
    board[30] = 2
    // 确认 (7,7) 确为禁手
    expect(checkForbidden(withStone(board, { x: 7, y: 7 }, 1), { x: 7, y: 7 })).not.toBeNull()

    const policy = new Float32Array(229)
    policy[112] = 999 // (7,7) 禁手，应被跳过
    policy[5] = 1
    const r = pickMoveFromPolicy(policy, board, 1)!
    expect(r.index).toBe(5) // 不应选禁手 112
  })
})
