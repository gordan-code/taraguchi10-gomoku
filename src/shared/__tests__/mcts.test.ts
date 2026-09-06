/**
 * MCTS 纯逻辑单元测试：注入 mock 网络（不依赖 onnxruntime），
 * 覆盖终局识别、强制挡点、PUCT 选路、价值回传方向。
 */
import { describe, expect, it } from 'vitest'
import { mctsSearch } from '../ai/mcts'
import { emptyBoard } from '../board'
import { idx } from '../types'
import { checkForbidden } from '../forbidden'

/** mock 网络：均匀策略（仅合法点）+ 简单价值：能一步成五 +1，对手能 +(-1)，否则 0 */
function makeUniformNet() {
  return async (board: import('../types').Board, color: 1 | 2) => {
    const policy = new Float32Array(229).fill(1)
    const canWin = (c: 1 | 2): boolean => {
      for (let i = 0; i < 225; i++) {
        if (board[i] !== 0) continue
        const p = { x: i % 15, y: Math.floor(i / 15) }
        board[i] = c
        const len = fiveLen(board, p, c)
        board[i] = 0
        if (c === 1 ? len === 5 : len >= 5) return true
      }
      return false
    }
    const value = canWin(color) ? 1 : canWin(color === 1 ? 2 : 1) ? -1 : 0
    return { policy, value }
  }
}

/** 与 board.ts runLength 同口径的连线长度（测试内独立实现，避免循环依赖误判） */
function fiveLen(board: number[], p: { x: number; y: number }, color: number): number {
  let best = 1
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
    let cnt = 1
    for (const s of [1, -1]) {
      let step = 1
      for (;;) {
        const x = p.x + dx * step * s
        const y = p.y + dy * step * s
        if (x < 0 || x > 14 || y < 0 || y > 14 || board[y * 15 + x] !== color) break
        cnt++
        step++
      }
    }
    if (cnt > best) best = cnt
  }
  return best
}

describe('MCTS（mock 网络）', () => {
  it('己方四连：1 次模拟即选中成五点', async () => {
    const b = emptyBoard()
    for (const [x, y] of [[7, 7], [8, 8], [9, 9], [10, 10]]) b[idx(x, y)] = 1
    b[idx(3, 3)] = 2
    b[idx(4, 3)] = 2
    const r = await mctsSearch(b, 1, { sims: 8, deadline: Date.now() + 5000 }, makeUniformNet())
    expect(r).toBeTruthy()
    // (6,6) 或 (11,11) 完成五连（黑恰好五；(6,6) 端外侧 (5,5) 空 ✓）
    expect(
      (r!.pos.x === 6 && r!.pos.y === 6) || (r!.pos.x === 11 && r!.pos.y === 11)
    ).toBe(true)
    expect(r!.q).toBe(1) // 终局价值精确回传
  })

  it('对手闭四：搜索应找到唯一挡点（活四挡不住，不用活四测）', async () => {
    const b = emptyBoard()
    // 白 (5,5)-(8,5) 四连，(4,5) 已被黑占 → 唯一成五点 (9,5)
    for (const [x, y] of [[5, 5], [6, 5], [7, 5], [8, 5]]) b[idx(x, y)] = 2
    b[idx(4, 5)] = 1
    b[idx(5, 6)] = 1
    b[idx(6, 6)] = 1
    const r = await mctsSearch(b, 1, { sims: 600, deadline: Date.now() + 10000 }, makeUniformNet())
    expect(r).toBeTruthy()
    // 不挡 (9,5) 则白成五（mock 价值让不挡分支 = -1）；挡后 = 0
    expect(r!.pos.x === 9 && r!.pos.y === 5).toBe(true)
    expect(r!.q).toBeGreaterThan(-0.5) // 挡住后不再必败
  })

  it('黑方不选禁手点', async () => {
    const b = emptyBoard()
    // 构造 (7,7) 为双三禁手：黑 (5,7)(6,7) 横三头 + (7,5)(7,6) 竖三头
    for (const [x, y] of [[5, 7], [6, 7], [7, 5], [7, 6]]) b[idx(x, y)] = 1
    b[idx(5, 5)] = 2
    const r = await mctsSearch(b, 1, { sims: 32, deadline: Date.now() + 5000 }, makeUniformNet())
    expect(r).toBeTruthy()
    const p = { x: r!.pos.x, y: r!.pos.y }
    b[idx(p.x, p.y)] = 1
    expect(checkForbidden(b, p)).toBeNull()
  })

  it('访问次数集中在成四分支（价值回传方向正确）', async () => {
    // 黑活三：冲四分支价值为正，其他 0 → 访问应集中在成四点
    const b = emptyBoard()
    for (const [x, y] of [[5, 7], [6, 7], [7, 7]]) b[idx(x, y)] = 1
    b[idx(5, 5)] = 2
    b[idx(6, 5)] = 2
    b[idx(9, 9)] = 2
    const r = await mctsSearch(b, 1, { sims: 600, deadline: Date.now() + 10000 }, makeUniformNet())
    expect(r).toBeTruthy()
    // 成四点：两端 (4,7)/(8,7) 与跳四 (3,7)
    const isFourMove = [3, 4, 8].some((x) => r!.pos.x === x && r!.pos.y === 7)
    expect(isFourMove).toBe(true)
    expect(r!.q).toBeGreaterThan(0.2) // 冲四价值为正（单四非必胜，不到 1）
  })
})
