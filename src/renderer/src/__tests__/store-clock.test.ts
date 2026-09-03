import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initialMs = 30 * 60 * 1000

describe('游戏仓库棋钟集成', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('新局双方 30:00，只有当前行动方倒计时', async () => {
    const mod = await import('../store/game')
    const { clockRemainingMs, startNewGame, store } = mod
    startNewGame({ mode: 'human-vs-ai', side: 'black', engine: 'negamax' })

    expect(clockRemainingMs.value).toEqual([initialMs, initialMs])
    vi.advanceTimersByTime(5_000)
    expect(clockRemainingMs.value[0]).toBe(initialMs - 5_000)
    expect(clockRemainingMs.value[1]).toBe(initialMs)

    mod.pauseGame()
    const frozen = [...clockRemainingMs.value]
    vi.advanceTimersByTime(20_000)
    expect(clockRemainingMs.value).toEqual(frozen)
    expect(store.clockPaused).toBe(true)
  })

  it('当前方归零后只触发一次 timeout 并结束对局', async () => {
    const mod = await import('../store/game')
    const { clockRemainingMs, game, startNewGame, store } = mod
    startNewGame({ mode: 'human-vs-ai', side: 'black', engine: 'negamax' })
    store.clock.remainingMs[0] = 100

    vi.advanceTimersByTime(250)
    expect(clockRemainingMs.value[0]).toBe(0)
    expect(game.value.phase).toBe('OVER')
    expect(game.value.result).toMatchObject({ winner: 1, reason: 'timeout' })

    vi.advanceTimersByTime(2_000)
    expect(game.value.result).toMatchObject({ winner: 1, reason: 'timeout' })
  })
})
