import { describe, expect, it } from 'vitest'
import { AiLevel, Board, Player, Pos, idx } from '../types'
import { GameState, newGame, applyEvent } from '../fsm'
import { decideAiAction } from '../ai/opening'
import { evaluate, searchBestMove, LEVELS, fourWinningPoints, threeFourPoints, dynamicTimeMs, rootCandidates } from '../ai/engine'
import { lookupOpeningBook } from '../ai/opening-book'
import { emptyBoard } from '../board'

const p = (name: string, level?: AiLevel): Player =>
  level ? { kind: 'ai', name, aiLevel: level } : { kind: 'human', name }

describe('评估函数', () => {
  it('空局面评估为 0', () => {
    expect(evaluate(emptyBoard())).toBe(0)
  })

  it('黑方活三对黑为正分', () => {
    const b = emptyBoard()
    for (const [x, y] of [[6, 7], [7, 7], [8, 7]]) b[idx(x, y)] = 1
    expect(evaluate(b)).toBeGreaterThan(0)
  })

  it('黑白对称局面评估接近 0', () => {
    const b = emptyBoard()
    b[idx(6, 7)] = 1
    b[idx(8, 9)] = 2
    expect(Math.abs(evaluate(b))).toBeLessThan(50)
  })
})

describe('搜索', () => {
  it('能找到一步取胜', () => {
    const b = emptyBoard()
    // 黑四连 (7,7)(8,8)(9,9)(10,10)，缺 (11,11)
    for (const [x, y] of [[7, 7], [8, 8], [9, 9], [10, 10]]) b[idx(x, y)] = 1
    b[idx(3, 3)] = 2
    b[idx(4, 3)] = 2
    const r = searchBestMove(b, 1, { maxDepth: 2, timeMs: 1000, width: 10, noise: 0 })
    // (6,6) 与 (11,11) 均可完成五连
    expect(
      (r.move!.x === 6 && r.move!.y === 6) || (r.move!.x === 11 && r.move!.y === 11)
    ).toBe(true)
  })

  it('能挡住对方一步取胜点', () => {
    const b = emptyBoard()
    // 白四连，黑必须挡
    for (const [x, y] of [[5, 5], [6, 5], [7, 5], [8, 5]]) b[idx(x, y)] = 2
    for (const [x, y] of [[5, 6], [6, 6]]) b[idx(x, y)] = 1
    const r = searchBestMove(b, 1, { maxDepth: 2, timeMs: 2000, width: 12, noise: 0 })
    expect(r.move).toBeTruthy()
    // 黑自身无法一步取胜，最佳应对是挡在 (4,5) 或 (9,5)
    expect(
      (r.move!.x === 4 || r.move!.x === 9) && r.move!.y === 5
    ).toBe(true)
  })

  it('黑方不会选择禁手点', () => {
    const b = emptyBoard()
    // 构造黑双三点 (7,7)：黑已有 (5,7)(6,7)(7,5)(7,6)
    for (const [x, y] of [[5, 7], [6, 7], [7, 5], [7, 6]]) b[idx(x, y)] = 1
    // 白子远离
    for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]]) b[idx(x, y)] = 2
    const r = searchBestMove(b, 1, { maxDepth: 2, timeMs: 1000, width: 16, noise: 0 })
    expect(r.move).toBeTruthy()
    expect(r.move!.x === 7 && r.move!.y === 7).toBe(false)
  })
})

describe('VCF 威胁检测与连续冲四', () => {
  it('活四返回两个成五点', () => {
    const b = emptyBoard()
    for (const [x, y] of [[5, 5], [6, 5], [7, 5]]) b[idx(x, y)] = 2
    b[idx(8, 5)] = 2 // 已落 (8,5)，形成 (5..8) 活四
    const fp = fourWinningPoints(b, { x: 8, y: 5 }, 2)
    expect(fp.sort()).toEqual([idx(4, 5), idx(9, 5)].sort())
  })

  it('冲四返回一个成五点', () => {
    const b = emptyBoard()
    for (const [x, y] of [[5, 5], [6, 5], [7, 5]]) b[idx(x, y)] = 2
    b[idx(4, 5)] = 1 // 黑挡一端
    b[idx(8, 5)] = 2 // 落 (8,5) 形成冲四
    const fp = fourWinningPoints(b, { x: 8, y: 5 }, 2)
    expect(fp).toEqual([idx(9, 5)])
  })

  it('三的延伸点包含两端的成四点', () => {
    const b = emptyBoard()
    for (const [x, y] of [[5, 5], [6, 5], [7, 5]]) b[idx(x, y)] = 2
    const tp = threeFourPoints(b, { x: 7, y: 5 }, 2)
    expect(tp).toContain(idx(4, 5))
    expect(tp).toContain(idx(8, 5))
  })

  it('VCF：找到形成活四的必胜着（判 MATE）', () => {
    const b = emptyBoard()
    for (const [x, y] of [[5, 5], [6, 5], [7, 5]]) b[idx(x, y)] = 2 // 白三连
    for (const [x, y] of [[0, 0], [1, 0]]) b[idx(x, y)] = 1 // 黑远离
    const r = searchBestMove(b, 2, { maxDepth: 2, timeMs: 1000, width: 10, noise: 0 })
    expect(r.move).toBeTruthy()
    // 白应下 (4,5) 或 (8,5) 形成活四；VCT 直接判胜
    expect(r.score).toBeGreaterThan(500000)
    expect((r.move!.x === 4 || r.move!.x === 8) && r.move!.y === 5).toBe(true)
  })
})

describe('时间管理与开局库（阶段三）', () => {
  it('动态时间：空局面少花时间', () => {
    expect(dynamicTimeMs(emptyBoard(), 1, 1000)).toBe(500)
  })

  it('动态时间：有杀棋威胁多花时间', () => {
    const b = emptyBoard()
    for (const [x, y] of [[5, 5], [6, 5], [7, 5]]) b[idx(x, y)] = 2
    expect(dynamicTimeMs(b, 1, 1000)).toBe(1500)
  })

  it('开局库：中盘（PLAY）阶段不查询', () => {
    const s = newGame([p('AI', 'novice'), p('玩家')], 0)
    s.phase = 'PLAY'
    expect(lookupOpeningBook(s)).toBeNull()
  })
})

describe('并行根拆分（阶段四）', () => {
  it('根候选：黑方不含禁手点', () => {
    const b = emptyBoard()
    for (const [x, y] of [[5, 7], [6, 7], [7, 5], [7, 6]]) b[idx(x, y)] = 1 // 构造黑双三
    for (const [x, y] of [[0, 0], [0, 1], [1, 0]]) b[idx(x, y)] = 2
    const cands = rootCandidates(b, 1, 16)
    expect(cands.length).toBeGreaterThan(0)
    expect(cands.some((p) => p.x === 7 && p.y === 7)).toBe(false) // 禁手点 (7,7) 被过滤
  })

  it('rootMoves：把根候选限制到指定子集', () => {
    const b = emptyBoard()
    for (const [x, y] of [[5, 5], [6, 5]]) b[idx(x, y)] = 2
    for (const [x, y] of [[0, 0]]) b[idx(x, y)] = 1
    const subset = [{ x: 10, y: 10 }]
    const r = searchBestMove(b, 2, { maxDepth: 2, timeMs: 500, width: 10, noise: 0, rootMoves: subset })
    expect(r.move).toEqual({ x: 10, y: 10 })
  })
})

describe('塔拉山口-10 开局决策', () => {
  it('第 1 手落在天元', () => {
    const s = newGame([p('AI', 'novice'), p('玩家')], 0)
    const d = decideAiAction(s, 'novice')
    expect(d.event).toEqual({ type: 'move', pos: { x: 7, y: 7 } })
    expect(d.report?.engine).toBe('static-eval')
    expect(d.report?.elapsedMs).toEqual(expect.any(Number))
  })

  it('交换/走法/打点/选点决策均可被 FSM 接受（完整开局流程）', () => {
    let s = newGame([p('AI黑', 'novice'), p('AI白', 'novice')], 0)
    let guard = 0
    while (s.phase !== 'PLAY' && s.phase !== 'OVER' && guard++ < 30) {
      const d = decideAiAction(s, 'novice')
      const r = applyEvent(s, d.event)
      expect(r.result.ok).toBe(true)
      s = r.state
    }
    expect(s.phase).toBe('PLAY')
    expect(s.moves.length).toBe(6)
    // 走法一有 5 次交换决策；走法二（十打点）只有 3 次（无第 4/5 手交换）
    const swaps = s.opening.filter((e) => e.action === 'swap-offer').length
    expect([3, 5]).toContain(swaps)
    expect(s.variant).toBeTruthy()
  })

  it('交换方向：黑优局面下白方交换、黑方不交换', () => {
    const board: Board = emptyBoard()
    board[idx(6, 7)] = 1
    board[idx(7, 7)] = 1
    board[idx(8, 7)] = 1
    board[idx(0, 0)] = 2

    const mkState = (phase: 'S1_SWAP' | 'S2_SWAP', moveLen: number): GameState => ({
      players: [p('AI黑', 'master'), p('AI白', 'master')],
      blackOwner: 0,
      phase,
      board: board.slice(),
      moves: Array.from({ length: moveLen }, (_, i) => ({ x: i, y: i })),
      offers: [],
      opening: []
    })

    // S1_SWAP：白方（index 1）行使交换权，黑优 → 交换接管黑棋
    const dWhite = decideAiAction(mkState('S1_SWAP', 1), 'master')
    expect(dWhite.event).toEqual({ type: 'swap', accept: true })

    // S2_SWAP：黑方（index 0）行使交换权，黑优 → 不交换维持执黑
    const dBlack = decideAiAction(mkState('S2_SWAP', 2), 'master')
    expect(dBlack.event).toEqual({ type: 'swap', accept: false })
  })
})

describe('AI 全自动对局（集成冒烟）', () => {
  it('novice 双 AI 从开局到终局全程合法', () => {
    let s = newGame([p('AI甲', 'novice'), p('AI乙', 'novice')], 0)
    let guard = 0
    while (s.phase !== 'OVER' && guard++ < 250) {
      const d = decideAiAction(s, 'novice')
      const r = applyEvent(s, d.event)
      expect(r.result.ok, `第 ${guard} 步失败: ${r.result.error}`).toBe(true)
      s = r.state
    }
    expect(s.phase).toBe('OVER')
    expect(s.result).toBeTruthy()
    expect(s.moves.length).toBeGreaterThan(8)
    // novice 噪声大，可能下满棋盘和棋（225 手）；上界只需保证不无限循环
    expect(s.moves.length).toBeLessThanOrEqual(225)
  }, 120000)
})
