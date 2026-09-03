import { describe, expect, it } from 'vitest'
import { Player, Pos, idx } from '../types'
import { applyEvent, currentActor, newGame, phaseLabel, regionRadius } from '../fsm'

const human: Player = { kind: 'human', name: '玩家' }
const ai: Player = { kind: 'ai', name: 'AI', aiLevel: 'amateur' }

function step(state: ReturnType<typeof newGame>, ev: Parameters<typeof applyEvent>[1]) {
  const { result, state: s } = applyEvent(state, ev)
  if (!result.ok) throw new Error(`事件失败: ${ev.type} → ${result.error}`)
  return s
}

function tryStep(state: ReturnType<typeof newGame>, ev: Parameters<typeof applyEvent>[1]) {
  return applyEvent(state, ev)
}

const P = (x: number, y: number): Pos => ({ x, y })

describe('塔拉山口-10 状态机：开局流程', () => {
  it('第 1 手必须落天元，其他点被拒绝', () => {
    let s = newGame([human, ai], 0)
    const bad = tryStep(s, { type: 'move', pos: P(7, 6) })
    expect(bad.result.ok).toBe(false)
    s = step(s, { type: 'move', pos: P(7, 7) })
    expect(s.phase).toBe('S1_SWAP')
  })

  it('第 2~4 手受 3×3/5×5/7×7 区域约束', () => {
    let s = newGame([human, ai], 0)
    s = step(s, { type: 'move', pos: P(7, 7) })
    s = step(s, { type: 'swap', accept: false })
    // 3×3 外拒绝
    expect(tryStep(s, { type: 'move', pos: P(9, 7) }).result.ok).toBe(false)
    s = step(s, { type: 'move', pos: P(8, 7) })
    s = step(s, { type: 'swap', accept: false })
    // 5×5 外拒绝
    expect(tryStep(s, { type: 'move', pos: P(10, 7) }).result.ok).toBe(false)
    s = step(s, { type: 'move', pos: P(8, 8) })
    s = step(s, { type: 'swap', accept: false })
    // 7×7 外拒绝
    expect(tryStep(s, { type: 'move', pos: P(11, 7) }).result.ok).toBe(false)
    s = step(s, { type: 'move', pos: P(9, 8) })
    expect(s.phase).toBe('VARIANT_CHOICE')
  })

  it('交换改变执黑方', () => {
    let s = newGame([human, ai], 0)
    expect(s.blackOwner).toBe(0)
    s = step(s, { type: 'move', pos: P(7, 7) })
    s = step(s, { type: 'swap', accept: true })
    expect(s.blackOwner).toBe(1)
    expect(s.phase).toBe('S2_MOVE')
  })

  it('走法一：E4 交换 → 9×9 内落第 5 手 → E5 交换 → 第 6 手任意', () => {
    let s = newGame([human, ai], 0)
    s = step(s, { type: 'move', pos: P(7, 7) })
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(8, 7) })
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(8, 8) })
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(9, 8) })
    expect(s.phase).toBe('VARIANT_CHOICE')
    s = step(s, { type: 'variant', variant: 1 })
    expect(s.phase).toBe('S4_SWAP') // 走法一的 E4 交换
    s = step(s, { type: 'swap', accept: false })
    expect(s.phase).toBe('V1_S5_MOVE')
    // 9×9 外拒绝（|x-7|>4）
    expect(tryStep(s, { type: 'move', pos: P(12, 7) }).result.ok).toBe(false)
    s = step(s, { type: 'move', pos: P(10, 7) })
    expect(s.phase).toBe('V1_S5_SWAP')
    s = step(s, { type: 'swap', accept: true })
    expect(s.phase).toBe('S6_MOVE')
    // 第 6 手任意位置
    s = step(s, { type: 'move', pos: P(3, 3) })
    expect(s.phase).toBe('PLAY')
    expect(s.moves.length).toBe(6)
  })

  it('走法二：十打点 → 十选一 → 第 6 手（无第 4/5 手交换）', () => {
    let s = newGame([human, ai], 0)
    s = step(s, { type: 'move', pos: P(7, 7) })
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(8, 7) })
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(8, 8) })
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(9, 8) })
    expect(s.phase).toBe('VARIANT_CHOICE')
    s = step(s, { type: 'variant', variant: 2 })
    expect(s.phase).toBe('V2_TEN_OFFER')

    // 中心对称对不允许（(7,7) 与自身对称除外，取 (7,7) 已被占用）
    const badPoints = Array.from({ length: 10 }, (_, i) => P(i + 3, 3))
    badPoints[0] = P(4, 4)
    badPoints[1] = P(10, 10) // 与 (4,4) 关于天元对称
    expect(tryStep(s, { type: 'offers', points: badPoints }).result.ok).toBe(false)

    // 数量不足 10 拒绝
    expect(tryStep(s, { type: 'offers', points: [P(5, 5), P(6, 6)] }).result.ok).toBe(false)

    // 落在已有棋子上的打点拒绝
    const occupied = Array.from({ length: 10 }, (_, i) => P(i + 3, 4))
    occupied[9] = P(7, 7) // 已有黑子
    expect(tryStep(s, { type: 'offers', points: occupied }).result.ok).toBe(false)

    const points = Array.from({ length: 10 }, (_, i) => P(i + 3, 4))
    const r = tryStep(s, { type: 'offers', points })
    expect(r.result.ok).toBe(true)
    s = r.state!
    expect(s.phase).toBe('V2_TEN_PICK')

    // 白方十选一：选第 4 个点 → 成为实际第 5 手黑子
    s = step(s, { type: 'pick', index: 3 })
    expect(s.moves.length).toBe(5)
    expect(s.board[idx(6, 4)]).toBe(1) // points[3] = (6,4)
    expect(s.phase).toBe('S6_MOVE')
    s = step(s, { type: 'move', pos: P(3, 3) })
    expect(s.phase).toBe('PLAY')
  })
})

describe('状态机：行动者与区域信息', () => {
  it('各阶段 currentActor 正确指向决策方', () => {
    let s = newGame([human, ai], 0)
    expect(currentActor(s)).toEqual({ player: 0, kind: 'move' })
    s = step(s, { type: 'move', pos: P(7, 7) })
    expect(currentActor(s)).toEqual({ player: 1, kind: 'swap' })
    s = step(s, { type: 'swap', accept: true })
    // 交换后 AI 执黑，轮到白（玩家0）落第 2 手
    expect(currentActor(s)).toEqual({ player: 0, kind: 'move' })
  })

  it('交换权归属：E1/E3 归白方，E2/E4 归黑方（玩家0 执黑）', () => {
    let s = newGame([human, ai], 0)
    s = step(s, { type: 'move', pos: P(7, 7) }) // 第 1 手黑
    expect(currentActor(s)).toEqual({ player: 1, kind: 'swap' }) // E1 → 白
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(8, 7) }) // 第 2 手白
    expect(currentActor(s)).toEqual({ player: 0, kind: 'swap' }) // E2 → 黑
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(8, 8) }) // 第 3 手黑
    expect(currentActor(s)).toEqual({ player: 1, kind: 'swap' }) // E3 → 白
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(9, 8) }) // 第 4 手白
    expect(currentActor(s)).toEqual({ player: 0, kind: 'variant' }) // 走法选择 → 黑
    s = step(s, { type: 'variant', variant: 1 })
    expect(currentActor(s)).toEqual({ player: 0, kind: 'swap' }) // E4 → 黑（走法一）
  })

  it('regionRadius 反映各手区域约束', () => {
    const s = newGame([human, ai], 0)
    expect(regionRadius(s)).toBe(0)
  })
})

describe('状态机：中盘与终局', () => {
  function playToS6(): ReturnType<typeof newGame> {
    let s = newGame([human, ai], 0)
    s = step(s, { type: 'move', pos: P(7, 7) })
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(8, 7) })
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(8, 8) })
    s = step(s, { type: 'swap', accept: false })
    s = step(s, { type: 'move', pos: P(9, 8) })
    s = step(s, { type: 'variant', variant: 1 }) // 走法一 → E4
    s = step(s, { type: 'swap', accept: false }) // E4
    s = step(s, { type: 'move', pos: P(10, 7) }) // 第 5 手
    s = step(s, { type: 'swap', accept: false }) // E5
    s = step(s, { type: 'move', pos: P(3, 3) }) // 第 6 手
    return s
  }

  it('黑方五连获胜：开局黑三子布成对角线后连五', () => {
    let s = playToS6()
    // 黑子：(7,7)(8,8)(10,7)；白子：(8,7)(9,8)(3,3)
    // 黑沿对角线 (7,7)(8,8) 补 (9,9)(6,6)(10,10) 成五连
    s = step(s, { type: 'move', pos: P(9, 9) }) // 黑
    s = step(s, { type: 'move', pos: P(4, 3) }) // 白
    s = step(s, { type: 'move', pos: P(6, 6) }) // 黑：(6,6)(7,7)(8,8)(9,9)
    s = step(s, { type: 'move', pos: P(5, 3) }) // 白
    const fin = tryStep(s, { type: 'move', pos: P(10, 10) })
    expect(fin.result.ok).toBe(true)
    expect(fin.state!.phase).toBe('OVER')
    expect(fin.state!.result!.reason).toBe('five')
    expect(fin.state!.result!.winner).toBe(0)
    expect(fin.state!.result!.line!.length).toBe(5)
  })

  it('黑方禁手落子直接判负（白胜，reason=forbidden）', () => {
    let s = playToS6()
    // 黑方布双三：黑已有 (7,7)(8,8)(10,7)
    // 黑依次下 (5,6)(4,6)(6,5)(6,4)（白配合走无关点），
    // 最后黑下 (6,6)：横向 (4,6)(5,6)(6,6) 与纵向 (6,4)(6,5)(6,6) 两个活三
    // （另有斜向 (6,6)(7,7)(8,8) 第三活三）→ 三三禁手 → 白胜
    const blackSetup: Pos[] = [P(5, 6), P(4, 6), P(6, 5), P(6, 4)]
    const whiteFiller: Pos[] = [P(0, 0), P(0, 1), P(0, 2), P(0, 3)]
    for (let i = 0; i < blackSetup.length; i++) {
      s = step(s, { type: 'move', pos: blackSetup[i] })
      s = step(s, { type: 'move', pos: whiteFiller[i] })
    }
    const fin = tryStep(s, { type: 'move', pos: P(6, 6) })
    expect(fin.result.ok).toBe(true)
    expect(fin.state!.phase).toBe('OVER')
    expect(fin.state!.result!.reason).toBe('forbidden')
    expect(fin.state!.result!.forbiddenKind).toBe('double-three')
    expect(fin.state!.result!.winner).toBe(1) // 白 = players[1]
    expect(fin.state!.result!.forbiddenPos).toEqual(P(6, 6))
  })

  it('白方五连获胜（白胜 reason=five）', () => {
    let s = playToS6()
    // 白子：(8,7)(9,8)(3,3)；白布横向 (8,7)(9,8)? 不同行——
    // 简单方案：白沿列 3 纵向连五：(3,3) 已有，白补 (3,4)(3,5)(3,6)(3,7)
    const whiteSetup: Pos[] = [P(3, 4), P(3, 5), P(3, 6)]
    const blackFiller: Pos[] = [P(13, 13), P(13, 12), P(13, 11)]
    for (let i = 0; i < whiteSetup.length; i++) {
      s = step(s, { type: 'move', pos: blackFiller[i] })
      s = step(s, { type: 'move', pos: whiteSetup[i] })
    }
    // 白第 4 子后黑先走，白再走 (3,7) 成五连
    s = step(s, { type: 'move', pos: P(13, 10) })
    const fin = tryStep(s, { type: 'move', pos: P(3, 7) })
    expect(fin.state!.phase).toBe('OVER')
    expect(fin.state!.result!.reason).toBe('five')
    expect(fin.state!.result!.winner).toBe(1)
  })

  it('认输立即结束对局', () => {
    const s = playToS6()
    const r = tryStep(s, { type: 'resign', player: 1 })
    expect(r.result.ok).toBe(true)
    expect(r.state!.phase).toBe('OVER')
    expect(r.state!.result!.reason).toBe('resign')
    expect(r.state!.result!.winner).toBe(0)
  })

  it('只有当前行动方可以触发超时，超时后对手获胜', () => {
    const s = playToS6()
    const current = currentActor(s)!
    const wrong = tryStep(s, { type: 'timeout', player: current.player === 0 ? 1 : 0 })
    expect(wrong.result.ok).toBe(false)

    const timedOut = tryStep(s, { type: 'timeout', player: current.player })
    expect(timedOut.result.ok).toBe(true)
    expect(timedOut.state!.phase).toBe('OVER')
    expect(timedOut.state!.result).toMatchObject({
      reason: 'timeout',
      winner: current.player === 0 ? 1 : 0
    })
    expect(tryStep(timedOut.state!, { type: 'timeout', player: current.player }).result.ok).toBe(false)
  })

  it('对局结束后拒绝再落子', () => {
    const s = playToS6()
    const over = step(s, { type: 'resign', player: 0 })
    expect(tryStep(over, { type: 'move', pos: P(5, 5) }).result.ok).toBe(false)
  })

  it('phaseLabel 输出中文阶段描述', () => {
    const s = newGame([human, ai], 0)
    expect(phaseLabel(s)).toContain('第 1 手')
  })
})
