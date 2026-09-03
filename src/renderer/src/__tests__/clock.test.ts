import { describe, expect, it } from 'vitest'
import {
  CLOCK_INITIAL_MS,
  clockAlert,
  createClock,
  formatClock,
  pauseClock,
  remainingAt,
  resumeClock,
  settleClock,
  startClock
} from '../store/clock'

describe('对局棋钟', () => {
  it('新局双方均为 30:00', () => {
    const clock = createClock()
    expect(clock.remainingMs).toEqual([CLOCK_INITIAL_MS, CLOCK_INITIAL_MS])
    expect(formatClock(clock.remainingMs[0])).toBe('30:00')
  })

  it('只扣当前行动方，且结算后不漂移', () => {
    const t0 = 1_000_000
    const running = startClock(createClock(), 0, t0)
    expect(remainingAt(running, t0 + 1_250)).toEqual([CLOCK_INITIAL_MS - 1_250, CLOCK_INITIAL_MS])

    const settled = settleClock(running, t0 + 1_250)
    expect(settled.elapsedMs).toBe(1_250)
    expect(settled.clock.remainingMs).toEqual([CLOCK_INITIAL_MS - 1_250, CLOCK_INITIAL_MS])
    expect(remainingAt(settled.clock, t0 + 1_250)).toEqual(settled.clock.remainingMs)
  })

  it('暂停和恢复不会把暂停期间计入棋钟', () => {
    const t0 = 2_000_000
    const running = startClock(createClock(), 1, t0)
    const paused = pauseClock(running, t0 + 2_000)
    expect(paused.remainingMs).toEqual([CLOCK_INITIAL_MS, CLOCK_INITIAL_MS - 2_000])
    expect(remainingAt(paused, t0 + 20_000)).toEqual(paused.remainingMs)

    const resumed = resumeClock(paused, t0 + 20_000)
    expect(remainingAt(resumed, t0 + 21_000)).toEqual([
      CLOCK_INITIAL_MS,
      CLOCK_INITIAL_MS - 3_000
    ])
  })

  it('格式化、低时告警和归零稳定', () => {
    expect(formatClock(30 * 60 * 1000)).toBe('30:00')
    expect(formatClock(59_001)).toBe('01:00')
    expect(formatClock(1)).toBe('00:01')
    expect(formatClock(-1)).toBe('00:00')
    expect(clockAlert(61_000)).toBe('normal')
    expect(clockAlert(60_000)).toBe('warning')
    expect(clockAlert(10_000)).toBe('danger')
    expect(clockAlert(0)).toBe('expired')
  })
})
