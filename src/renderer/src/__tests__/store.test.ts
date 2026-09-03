/**
 * 游戏仓库端到端集成测试：
 * 用假 Worker（同步调用 AI 决策，并强制 AI 拒绝交换）驱动完整对局，
 * 覆盖：开局全流程（走法一/走法二）、AI 调度、快照/回放、悔棋、自动保存容错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiLevel } from '@shared/types'
import { GameEvent, GameState } from '@shared/fsm'
import { decideAiAction } from '@shared/ai/opening'
import { forbiddenAt } from '@shared/index'

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null
  postMessage(req: { id: number; state: GameState; level: AiLevel }): void {
    let resp: unknown
    try {
      // 统一为大师难度后，测试用快速浅搜（novice）驱动对局，避免每步跑 10s 的满深度搜索
      const d = decideAiAction(req.state, 'novice')
      let event = d.event as GameEvent
      // 测试确定性：AI 一律拒绝交换（保持假黑/假白身份不变）
      if (event.type === 'swap') event = { type: 'swap', accept: false }
      resp = { id: req.id, ok: true as const, event, reason: d.reason }
    } catch (err) {
      resp = { id: req.id, ok: false as const, error: String(err) }
    }
    setTimeout(() => this.onmessage?.({ data: resp }), 0)
  }
  terminate(): void {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function drainUntil(cond: () => boolean, timeoutMs = 30000, stepMs = 20): Promise<boolean> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false
    await sleep(stepMs)
  }
  return true
}

/** 等到轮到人类落子时点击第一个空着的候选点（AI 落点有随机性，必须动态选点） */
async function humanClickAny(
  mod: typeof import('../store/game'),
  candidates: Array<[number, number]>
): Promise<void> {
  const ok = await drainUntil(() => {
    const a = mod.actor.value
    return a !== null && mod.game.value.players[a.player].kind === 'human' && a.kind === 'move'
  })
  if (!ok) {
    throw new Error(
      `humanClickAny 超时（phase=${mod.game.value.phase}, moves=${mod.game.value.moves.length}）`
    )
  }
  for (const [x, y] of candidates) {
    if (mod.game.value.board[y * 15 + x] === 0) {
      mod.clickCell({ x, y })
      return
    }
  }
  throw new Error('humanClickAny：候选点全部被占用')
}

describe('游戏仓库端到端', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker)
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('AI 观战模式：完整对局自动进行到终局', async () => {
    const mod = await import('../store/game')
    const { store, startNewGame, game } = mod
    startNewGame({ mode: 'ai-vs-ai', side: 'black', engine: 'negamax' })
    store.speed = 0
    const ok = await drainUntil(() => game.value.phase === 'OVER')
    expect(ok).toBe(true)
    expect(game.value.result).toBeTruthy()
    expect(game.value.moves.length).toBeGreaterThan(8)
    expect(store.snapshots.length).toBe(store.history.length + 1)
    const swaps = game.value.opening.filter((e) => e.action === 'swap-offer')
    expect([3, 5]).toContain(swaps.length)
    expect(game.value.variant).toBeTruthy()
  })

  it('人机模式（走法一）：完整开局 → 中盘 → 终局 → 回放', async () => {
    const mod = await import('../store/game')
    const { store, startNewGame, game, humanSwap, humanVariant, replayGo, displayState } = mod
    startNewGame({ mode: 'human-vs-ai', side: 'black', engine: 'negamax' })

    // 第 1 手：人（黑）落天元（天元必空）
    await humanClickAny(mod, [[7, 7]])
    // S1_SWAP：AI 拒绝 → S2_MOVE：AI（白）落子 → S2_SWAP：人决定不交换
    await drainUntil(() => game.value.phase === 'S2_SWAP')
    humanSwap(false)
    // 第 3 手：人（黑），5×5 内（AI 第 2 手可能在 3×3 任意处，动态避让）
    await humanClickAny(mod, [
      [8, 8],
      [8, 6],
      [6, 8],
      [6, 6],
      [7, 8],
      [8, 7],
      [7, 6],
      [6, 7],
      [7, 5],
      [5, 7]
    ])
    // 第 4 手后进入走法选择（走法一的 E4 交换在选完走法之后）
    await drainUntil(() => game.value.phase === 'VARIANT_CHOICE')
    humanVariant(1)
    await drainUntil(() => game.value.phase === 'S4_SWAP')
    humanSwap(false)
    // 第 5 手：人（黑），9×9 内（AI 第 4 手可能在 7×7 任意处，动态避让）
    await humanClickAny(mod, [
      [10, 7],
      [7, 10],
      [10, 10],
      [9, 7],
      [7, 9],
      [10, 8],
      [8, 10],
      [9, 6],
      [6, 9],
      [10, 6]
    ])
    // V1_S5_SWAP：AI 拒绝 → S6_MOVE：AI（白）→ PLAY
    const reachedPlay = await drainUntil(() => game.value.phase === 'PLAY', 30000)
    expect(reachedPlay).toBe(true)
    expect(game.value.moves.length).toBe(6)
    expect(game.value.variant).toBe(1)

    // 中盘：轮到人就下（避开禁手点）
    const finished = await drainUntil(() => {
      if (game.value.phase === 'OVER') return true
      const a = mod.actor.value
      if (a && game.value.players[a.player].kind === 'human' && a.kind === 'move') {
        for (let y = 4; y <= 10; y++) {
          for (let x = 4; x <= 10; x++) {
            const p = { x, y }
            if (game.value.board[y * 15 + x] !== 0) continue
            if (forbiddenAt(game.value, p)) continue
            mod.clickCell(p)
            return false
          }
        }
      }
      return false
    }, 60000)
    expect(finished).toBe(true)

    // 回放
    replayGo(0)
    expect(displayState.value.moves.length).toBe(0)
    replayGo(store.snapshots.length - 1)
    expect(displayState.value.moves.length).toBe(game.value.moves.length)
  })

  it('人机模式（走法二）：人执黑摆十打点 → AI 十选一', async () => {
    const mod = await import('../store/game')
    const { store, startNewGame, game, humanSwap, humanVariant, humanConfirmOffers } = mod
    startNewGame({ mode: 'human-vs-ai', side: 'black', engine: 'negamax' })

    // 第 1 手：人（黑）落天元
    await humanClickAny(mod, [[7, 7]])
    await drainUntil(() => game.value.phase === 'S2_SWAP')
    humanSwap(false)
    // 第 3 手：动态避让 AI 第 2 手
    await humanClickAny(mod, [
      [8, 8],
      [8, 6],
      [6, 8],
      [6, 6],
      [7, 8],
      [8, 7],
      [7, 6],
      [6, 7]
    ])
    // 第 4 手后直接走法选择，走法二无第 4 手交换
    await drainUntil(() => game.value.phase === 'VARIANT_CHOICE')
    humanVariant(2)
    expect(game.value.phase).toBe('V2_TEN_OFFER')

    // 摆 10 个点：动态选取 x≤6 区域的空点（对称点 x≥8，永不冲突）
    const picked: Array<[number, number]> = []
    for (let y = 3; y <= 11 && picked.length < 10; y++) {
      for (let x = 3; x <= 6 && picked.length < 10; x++) {
        if (game.value.board[y * 15 + x] === 0) picked.push([x, y])
      }
    }
    expect(picked.length).toBe(10)
    for (const [x, y] of picked) mod.clickCell({ x, y })
    expect(store.offerDraft.length).toBe(10)
    humanConfirmOffers()
    expect(game.value.phase).toBe('V2_TEN_PICK')
    const reachedPlay = await drainUntil(() => game.value.phase === 'PLAY', 30000)
    expect(reachedPlay).toBe(true)
    expect(game.value.moves.length).toBe(6)
    expect(game.value.variant).toBe(2)
    const offersEntry = game.value.opening.find((e) => e.action === 'ten-offers')
    expect(offersEntry && 'points' in offersEntry ? offersEntry.points.length : 0).toBe(10)
  })

  it('人机模式：悔棋回退到人最近一次决策之前', async () => {
    const mod = await import('../store/game')
    const { store, startNewGame, game, clickCell, undoLast, actor } = mod
    startNewGame({ mode: 'human-vs-ai', side: 'black', engine: 'negamax' })
    await humanClickAny(mod, [[7, 7]])
    await drainUntil(() => game.value.moves.length >= 2)
    undoLast()
    expect(game.value.moves.length).toBe(0)
    expect(store.history.length).toBe(0)
    expect(actor.value?.kind).toBe('move')
    expect(actor.value?.player).toBe(0)
    void clickCell
  })

  it('人机模式：人类执白时 AI 先落天元', async () => {
    const mod = await import('../store/game')
    const { startNewGame, game } = mod
    startNewGame({ mode: 'human-vs-ai', side: 'white', engine: 'negamax' })
    const ok = await drainUntil(() => game.value.moves.length >= 1)
    expect(ok).toBe(true)
    expect(game.value.moves[0]).toEqual({ x: 7, y: 7 })
    expect(game.value.players[0].kind).toBe('ai')
  })
})
