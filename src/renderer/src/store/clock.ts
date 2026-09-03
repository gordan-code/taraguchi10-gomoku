/**
 * 对局棋钟：按玩家身份索引累计，不按黑白颜色索引。
 * AI 的搜索耗时属于 AiReport，不能直接替代这里的双方总棋钟。
 */

export const CLOCK_INITIAL_MS = 30 * 60 * 1000
export type PlayerIndex = 0 | 1

export interface ClockSnapshot {
  remainingMs: [number, number]
  activePlayer: PlayerIndex | null
  startedAtMs: number | null
  paused: boolean
}

export type ClockAlert = 'normal' | 'warning' | 'danger' | 'expired'

const clampMs = (ms: number): number => Math.max(0, Math.round(ms))

export function createClock(): ClockSnapshot {
  return {
    remainingMs: [CLOCK_INITIAL_MS, CLOCK_INITIAL_MS],
    activePlayer: null,
    startedAtMs: null,
    paused: false
  }
}

/** 返回某一时刻的显示余额，不修改输入对象。 */
export function remainingAt(clock: ClockSnapshot, now = Date.now()): [number, number] {
  const remaining: [number, number] = [clampMs(clock.remainingMs[0]), clampMs(clock.remainingMs[1])]
  if (clock.paused || clock.activePlayer === null || clock.startedAtMs === null) return remaining

  const elapsed = Math.max(0, now - clock.startedAtMs)
  const player = clock.activePlayer
  remaining[player] = clampMs(remaining[player] - elapsed)
  return remaining
}

/** 结算当前行动方到 now，并把结算后的余额作为新的基准。 */
export function settleClock(clock: ClockSnapshot, now = Date.now()): {
  clock: ClockSnapshot
  elapsedMs: number
  expiredPlayer: PlayerIndex | null
} {
  const elapsedMs =
    !clock.paused && clock.activePlayer !== null && clock.startedAtMs !== null
      ? Math.max(0, now - clock.startedAtMs)
      : 0
  const remainingMs = remainingAt(clock, now)
  const activePlayer = clock.activePlayer
  const expiredPlayer =
    activePlayer !== null && remainingMs[activePlayer] <= 0 ? activePlayer : null

  return {
    clock: {
      remainingMs,
      activePlayer,
      startedAtMs: activePlayer === null || clock.paused ? null : now,
      paused: clock.paused
    },
    elapsedMs,
    expiredPlayer
  }
}

export function startClock(clock: ClockSnapshot, player: PlayerIndex, now = Date.now()): ClockSnapshot {
  return {
    remainingMs: [clampMs(clock.remainingMs[0]), clampMs(clock.remainingMs[1])],
    activePlayer: player,
    startedAtMs: clock.paused ? null : now,
    paused: clock.paused
  }
}

export function pauseClock(clock: ClockSnapshot, now = Date.now()): ClockSnapshot {
  const settled = settleClock(clock, now).clock
  return { ...settled, startedAtMs: null, paused: true }
}

export function resumeClock(clock: ClockSnapshot, now = Date.now()): ClockSnapshot {
  return {
    remainingMs: [clampMs(clock.remainingMs[0]), clampMs(clock.remainingMs[1])],
    activePlayer: clock.activePlayer,
    startedAtMs: clock.activePlayer === null ? null : now,
    paused: false
  }
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function clockAlert(ms: number): ClockAlert {
  const remaining = clampMs(ms)
  if (remaining <= 0) return 'expired'
  if (remaining <= 10_000) return 'danger'
  if (remaining <= 60_000) return 'warning'
  return 'normal'
}
