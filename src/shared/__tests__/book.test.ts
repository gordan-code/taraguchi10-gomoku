/**
 * 开局库单测：对称规范化的不变量 + 真实库文件的查询合法性。
 */
import { describe, expect, it } from 'vitest'
import { canonicalKey, lookupBookMove, SYMS, bookSize } from '../ai/book'
import rawBook from '../ai/opening-book.json'
import { emptyBoard } from '../board'
import { Board, Player } from '../types'

function rot90Idx(i: number): number {
  const x = i % 15
  const y = Math.floor(i / 15)
  return x * 15 + (14 - y)
}

describe('开局库', () => {
  it('库文件已生成且非空', () => {
    expect(bookSize()).toBeGreaterThan(0)
  })

  it('规范化键的对称不变量：旋转后的局面映射到同一键', () => {
    const b = emptyBoard()
    b[7 * 15 + 7] = 1 // 天元
    b[8 * 15 + 6] = 2
    b[6 * 15 + 8] = 1
    const k1 = canonicalKey(b, 1)
    const b2 = emptyBoard()
    for (let i = 0; i < 225; i++) if (b[i] !== 0) b2[rot90Idx(i)] = b[i]
    const k2 = canonicalKey(b2, 1)
    expect(k2).toBe(k1)
  })

  it('canonicalKey 幂等：规范局面再次规范化得到自身', () => {
    const keys = Object.keys(rawBook)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys.slice(0, 10)) {
      const [boardStr, turnStr] = key.split('|')
      const board = boardStr.split('').map((c) => Number(c)) as Board
      expect(canonicalKey(board, Number(turnStr) as 1 | 2)).toBe(key)
    }
  })

  it('库内条目查询：构造对应局面应命中合法着法', () => {
    const players: Player[] = [
      { kind: 'ai', name: '黑', aiLevel: 'master' },
      { kind: 'ai', name: '白', aiLevel: 'master' }
    ]
    let hit = 0
    for (const [key, entries] of Object.entries(rawBook).slice(0, 30)) {
      const [boardStr, turnStr] = key.split('|')
      const board = boardStr.split('').map((c) => Number(c)) as Board
      const turn = Number(turnStr) as 1 | 2
      const moves = board
        .map((c, i) => (c !== 0 ? { x: i % 15, y: Math.floor(i / 15) } : null))
        .filter((m): m is { x: number; y: number } => m !== null)
      if (moves.length < 4) continue
      const parity = moves.length % 2
      const blackOwner = parity as 0 | 1
      if (turn !== (parity === blackOwner ? 1 : 2)) continue
      const state = {
        players: [players[0], players[1]] as [Player, Player],
        blackOwner,
        phase: 'PLAY' as const,
        board,
        moves,
        offers: [],
        opening: []
      }
      const pos = lookupBookMove(state as never)
      if (pos) {
        hit++
        expect(pos.x).toBeGreaterThanOrEqual(0)
        expect(pos.x).toBeLessThan(15)
        expect(board[pos.y * 15 + pos.x]).toBe(0)
      }
    }
    expect(hit).toBeGreaterThan(0)
  })

  it('中盘（≥6 手）不再查库', () => {
    const b = emptyBoard()
    for (let i = 0; i < 6; i++) b[(7 + i) * 15 + 7] = (i % 2) + 1
    const state = {
      players: [] as unknown as [Player, Player],
      blackOwner: 0 as const,
      phase: 'PLAY' as const,
      board: b,
      moves: Array.from({ length: 6 }, (_, i) => ({ x: 7, y: 7 + i })),
      offers: [],
      opening: []
    }
    expect(lookupBookMove(state as never)).toBeNull()
  })

  it('SYMS 共 8 种且互逆配对正确', () => {
    expect(SYMS.length).toBe(8)
    for (const s of SYMS) {
      const [x, y] = s.inv(...s.f(3, 5))
      expect([x, y]).toEqual([3, 5])
    }
  })
})
