/**
 * 游戏状态仓库：驱动 FSM、调度 AI Worker、悔棋、自动保存、导入导出、回放。
 */
import { computed, reactive } from 'vue'
import {
  AiEngine,
  AiLevel,
  Board,
  GameEvent,
  GameState,
  Player,
  Pos,
  Variant,
  applyEvent,
  currentActor,
  forbiddenAt,
  idx,
  movePlacementLegal,
  newGame,
  phaseLabel,
  regionRadius
} from '@shared/index'
import { GameRecord, deserializeRecord, serializeRecord } from '@shared/record'
import { exportPsq, parsePsq } from '@shared/psq'
import { playStoneClick } from '../sound'
import type { AiProgress, AiResponse } from '../ai/worker'
import type { AiReport } from '@shared/ai/report'
import {
  ClockSnapshot,
  PlayerIndex,
  createClock,
  remainingAt,
  resumeClock as resumeClockState,
  settleClock,
  startClock
} from './clock'

export type Mode = 'human-vs-ai' | 'ai-vs-ai'
export type SideChoice = 'black' | 'white' | 'random'

export const LEVEL_NAMES: Record<AiLevel, string> = {
  novice: '入门',
  amateur: '业余',
  advanced: '进阶',
  master: '大师'
}

interface HistoryEntry {
  stateBefore: GameState
  event: GameEvent
  by: 0 | 1
  elapsedMs?: number
  clockBefore: ClockSnapshot
  clockAfter: ClockSnapshot
  report?: AiReport | null
}

const LS_KEY = 'renju-master:autosave'

const levelOf = (p: Player): AiLevel => p.aiLevel ?? 'master'

function makeHuman(): Player {
  return { kind: 'human', name: '你' }
}
function makeAi(): Player {
  return { kind: 'ai', name: 'AI·大师', aiLevel: 'master' }
}

export interface NewGameConfig {
  mode: Mode
  side: SideChoice
  engine: AiEngine
}

/** 评估曲线上的一个采样点：ply = 手数（0 基），score = 黑方视角估值 */
export interface EvalPoint {
  ply: number
  score: number
}

interface Store {
  mode: Mode
  game: GameState
  history: HistoryEntry[]
  snapshots: GameState[]
  clockSnapshots: ClockSnapshot[]
  replayIndex: number | null
  aiThinking: 0 | 1 | null
  lastReason: string
  lastReport: AiReport | null
  evalTrail: EvalPoint[]
  gameEngine: AiEngine
  turnStartedAt: number
  clock: ClockSnapshot
  clockNow: number
  clockPaused: boolean
  offerDraft: Pos[]
  confirmForbidden: Pos | null
  toast: string
  autoplay: boolean
  speed: 1 | 2 | 4 | 0
  lastConfig: NewGameConfig
  settings: {
    showForbidden: boolean
    sound: boolean
    searchThreads: number
  }
}

const initialPlayers = (): [Player, Player] => [makeHuman(), makeAi()]

export const store = reactive<Store>({
  mode: 'human-vs-ai',
  game: newGame(initialPlayers(), 0),
  history: [],
  snapshots: [],
  clockSnapshots: [],
  replayIndex: null,
  aiThinking: null,
  lastReason: '',
  lastReport: null,
  evalTrail: [],
  gameEngine: 'onnx',
  turnStartedAt: Date.now(),
  clock: createClock(),
  clockNow: Date.now(),
  clockPaused: false,
  offerDraft: [],
  confirmForbidden: null,
  toast: '',
  autoplay: false,
  speed: 1,
  lastConfig: { mode: 'human-vs-ai', side: 'black', engine: 'onnx' },
  settings: { showForbidden: true, sound: false, searchThreads: 4 }
})

// ---------------------------------------------------------------- 派生状态

export const actor = computed(() => currentActor(store.game))
export const game = computed(() => store.game)
export const phaseText = computed(() => phaseLabel(store.game))
export const gameOver = computed(() => store.game.phase === 'OVER')
export const displayState = computed<GameState>(() =>
  store.replayIndex === null ? store.game : store.snapshots[store.replayIndex] ?? store.game
)
export const humanIndex = computed<0 | 1 | null>(() => {
  const i = store.game.players.findIndex((p) => p.kind === 'human')
  return i === -1 ? null : (i as 0 | 1)
})
export const isHumanTurn = computed(() => {
  const a = actor.value
  return a !== null && store.game.players[a.player].kind === 'human' && store.replayIndex === null
})
export const blackOwnerName = computed(() => store.game.players[store.game.blackOwner].name)
export const whiteOwnerName = computed(() => store.game.players[store.game.blackOwner === 0 ? 1 : 0].name)

/** 当前展示局面下的禁手标记（黑方行棋时） */
export const forbiddenMarks = computed<Pos[]>(() => {
  if (!store.settings.showForbidden) return []
  const s = displayState.value
  if (s.phase !== 'PLAY' || s.moves.length % 2 !== 0) return []
  const marks: Pos[] = []
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (s.board[idx(x, y)] !== 0) continue
      if (forbiddenAt(s, { x, y })) marks.push({ x, y })
    }
  }
  // 全盘扫描过重时限流：标记最多 40 个
  return marks.slice(0, 40)
})

export const canUndo = computed(
  () => humanIndex.value !== null && store.history.some((h) => h.by === humanIndex.value)
)

export const clockRemainingMs = computed<[number, number]>(() => remainingAt(store.clock, store.clockNow))
export const displayClockRemainingMs = computed<[number, number]>(() => {
  if (store.replayIndex !== null) {
    return store.clockSnapshots[store.replayIndex]?.remainingMs ?? clockRemainingMs.value
  }
  return clockRemainingMs.value
})
export const displayClockActivePlayer = computed<PlayerIndex | null>(() => {
  if (store.replayIndex !== null) return store.clockSnapshots[store.replayIndex]?.activePlayer ?? null
  return store.clock.activePlayer
})
export const clockIsPaused = computed(() => store.clockPaused || store.replayIndex !== null)

export const isClockActive = computed(() =>
  store.replayIndex === null &&
  !store.clockPaused &&
  store.game.phase !== 'OVER' &&
  store.clock.activePlayer !== null
)

export function remainingForPlayer(player: PlayerIndex): number {
  return displayClockRemainingMs.value[player]
}

function cloneClock(clock: ClockSnapshot): ClockSnapshot {
  return {
    remainingMs: [clock.remainingMs[0], clock.remainingMs[1]],
    activePlayer: clock.activePlayer,
    startedAtMs: clock.startedAtMs,
    paused: clock.paused
  }
}

function unrefTimer(timer: unknown): void {
  ;(timer as { unref?: () => void } | null)?.unref?.()
}

let clockTimer: ReturnType<typeof setInterval> | null = null
let clockTimeout: ReturnType<typeof setTimeout> | null = null
let timeoutInFlight = false

function stopClockTicker(): void {
  if (clockTimer) {
    clearInterval(clockTimer)
    clockTimer = null
  }
  if (clockTimeout) {
    clearTimeout(clockTimeout)
    clockTimeout = null
  }
}

function scheduleClockTimeout(): void {
  if (clockTimeout) {
    clearTimeout(clockTimeout)
    clockTimeout = null
  }
  if (
    store.clockPaused ||
    store.replayIndex !== null ||
    store.game.phase === 'OVER' ||
    store.clock.activePlayer === null
  ) {
    return
  }
  const player = store.clock.activePlayer
  const remaining = remainingAt(store.clock, Date.now())[player]
  if (remaining <= 0) {
    triggerClockTimeout(player)
    return
  }
  clockTimeout = setTimeout(() => triggerClockTimeout(player), remaining + 2)
  unrefTimer(clockTimeout)
}

function startClockTicker(): void {
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      const now = Date.now()
      store.clockNow = now
      if (
        !store.clockPaused &&
        store.replayIndex === null &&
        store.game.phase !== 'OVER' &&
        store.clock.activePlayer !== null &&
        remainingAt(store.clock, now)[store.clock.activePlayer] <= 0
      ) {
        triggerClockTimeout(store.clock.activePlayer)
      }
    }, 250)
    unrefTimer(clockTimer)
  }
  scheduleClockTimeout()
}

function triggerClockTimeout(player: PlayerIndex): void {
  if (timeoutInFlight || store.clockPaused || store.replayIndex !== null || store.game.phase === 'OVER') return
  const actorNow = currentActor(store.game)
  if (!actorNow || actorNow.player !== player || store.clock.activePlayer !== player) return
  if (remainingAt(store.clock, Date.now())[player] > 0) {
    scheduleClockTimeout()
    return
  }
  timeoutInFlight = true
  epoch++
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  disposeWorker()
  store.aiThinking = null
  applyEventToGame({ type: 'timeout', player }, player, { forceTimeout: true })
  timeoutInFlight = false
}

function setClock(clock: ClockSnapshot, syncPaused = true): void {
  store.clock = cloneClock(clock)
  if (syncPaused) store.clockPaused = clock.paused
}

function startClockForState(state: GameState, now = Date.now()): void {
  const next = currentActor(state)?.player ?? null
  store.clockNow = now
  if (state.phase === 'OVER' || next === null || store.replayIndex !== null) {
    setClock(
      { ...store.clock, activePlayer: null, startedAtMs: null, paused: store.clockPaused || store.replayIndex !== null },
      store.replayIndex === null
    )
    stopClockTicker()
    return
  }
  if (store.clockPaused) {
    setClock({ ...store.clock, activePlayer: next, startedAtMs: null, paused: true })
    stopClockTicker()
    return
  }
  setClock(startClock({ ...store.clock, paused: false }, next, now))
  startClockTicker()
}

let replayClockWasPaused = false

function freezeClockForReplay(now = Date.now()): void {
  replayClockWasPaused = store.clockPaused
  const settled = settleClock(store.clock, now).clock
  setClock({ ...settled, startedAtMs: null, paused: true }, false)
  store.clockPaused = true
  store.clockNow = now
  epoch++
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  disposeWorker()
  store.aiThinking = null
  stopClockTicker()
}

export function pauseGame(): void {
  if (store.replayIndex !== null || store.game.phase === 'OVER' || store.clockPaused) return
  const now = Date.now()
  const settled = settleClock(store.clock, now).clock
  setClock({ ...settled, startedAtMs: null, paused: true })
  store.clockNow = now
  store.clockPaused = true
  epoch++
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  disposeWorker()
  store.aiThinking = null
  autosave()
}

export function resumeGame(): void {
  if (store.replayIndex !== null || store.game.phase === 'OVER' || !store.clockPaused) return
  const now = Date.now()
  store.clockPaused = false
  setClock(resumeClockState({ ...store.clock, activePlayer: currentActor(store.game)?.player ?? null, paused: true }, now))
  store.clockNow = now
  store.turnStartedAt = now
  startClockForState(store.game, now)
  scheduleAi()
}

// ---------------------------------------------------------------- AI Worker

let worker: Worker | null = null
let epoch = 0
let aiTimer: ReturnType<typeof setTimeout> | null = null
let aiWatchdog: ReturnType<typeof setTimeout> | null = null

function clearAiWatchdog(): void {
  if (aiWatchdog) {
    clearTimeout(aiWatchdog)
    aiWatchdog = null
  }
}

function disposeWorker(): void {
  clearAiWatchdog()
  worker?.terminate()
  worker = null
}

/** 类型收窄：是否为 AI 搜索实时进度消息（区别于最终结果/错误） */
function isAiProgress(r: AiResponse | AiProgress): r is AiProgress {
  return 'type' in r && r.type === 'progress'
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../ai/worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<AiResponse | AiProgress>) => {
      const resp = e.data
      if (resp.id !== epoch) return
      if (isAiProgress(resp)) {
        // 搜索实时进度：仅更新展示数字，不落子、不计时结算
        if (store.aiThinking !== null) store.lastReport = resp.report
        return
      }
      clearAiWatchdog()
      store.aiThinking = null
      if (!resp.ok) {
        showToast(`AI 决策失败，已启用安全走法：${resp.error}`)
        aiFallback()
        return
      }
      const a = currentActor(store.game)
      if (!a || store.game.players[a.player].kind !== 'ai') return
      store.lastReason = resp.reason
      store.lastReport = resp.report ?? null
      if (applyEventToGame(resp.event, a.player, { report: resp.report })) aiFallbackCount = 0
      else aiFallback()
    }
    worker.onerror = (e) => {
      e.preventDefault()
      store.aiThinking = null
      disposeWorker()
      showToast(`AI Worker 加载失败，已启用安全走法：${e.message || '未知错误'}`)
      aiFallback()
    }
  }
  return worker
}

/** Worker 不可用时按当前规则阶段执行确定性的合法动作，保证流程不会永久卡住。 */
let aiFallbackCount = 0
function aiFallback(): void {
  const a = currentActor(store.game)
  if (!a || store.game.players[a.player].kind !== 'ai') return
  if (++aiFallbackCount > 20) {
    showToast('AI 连续决策失败，请开始新对局')
    return
  }

  if (a.kind === 'swap') {
    applyEventToGame({ type: 'swap', accept: false }, a.player)
    return
  }
  if (a.kind === 'variant') {
    applyEventToGame({ type: 'variant', variant: 1 }, a.player)
    return
  }
  if (a.kind === 'pick') {
    applyEventToGame({ type: 'pick', index: 0 }, a.player)
    return
  }
  if (a.kind === 'offers') {
    const points: Pos[] = []
    for (let y = 0; y < 15 && points.length < 10; y++) {
      for (let x = 0; x < 15 && points.length < 10; x++) {
        const p = { x, y }
        if (store.game.board[idx(x, y)] !== 0) continue
        if (points.some((q) => q.x + p.x === 14 && q.y + p.y === 14)) continue
        points.push(p)
      }
    }
    if (points.length === 10) applyEventToGame({ type: 'offers', points }, a.player)
    return
  }

  const s = store.game
  const color = s.moves.length % 2 === 0 ? 1 : 2
  const pool: Pos[] = []
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (s.board[idx(x, y)] === 0) pool.push({ x, y })
    }
  }
  pool.sort(
    (p, q) =>
      Math.abs(p.x - 7) + Math.abs(p.y - 7) - (Math.abs(q.x - 7) + Math.abs(q.y - 7))
  )
  for (const p of pool) {
    if (movePlacementLegal(s, p) === null && !(color === 1 && forbiddenAt(s, p))) {
      applyEventToGame({ type: 'move', pos: p }, a.player)
      return
    }
  }
}

function scheduleAi(): void {
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  clearAiWatchdog()
  if (store.replayIndex !== null || store.clockPaused || store.clock.paused) return
  const a = currentActor(store.game)
  if (!a || store.game.players[a.player].kind !== 'ai') return
  const player = a.player
  const level = levelOf(store.game.players[player])
  const delay = store.mode === 'ai-vs-ai' ? (store.speed === 0 ? 40 : Math.round(900 / store.speed)) : 120
  aiTimer = setTimeout(() => {
    aiTimer = null
    if (store.replayIndex !== null || store.clockPaused) return
    const a2 = currentActor(store.game)
    if (!a2 || a2.player !== player || store.game.players[a2.player].kind !== 'ai') return
    const now = Date.now()
    const remaining = remainingAt(store.clock, now)[a2.player]
    if (remaining <= 0) {
      triggerClockTimeout(a2.player)
      return
    }
    // 棋钟从当前行动方获得回合时开始计时；AI 搜索耗时另由 AiReport.elapsedMs 展示。
    store.clockNow = now
    startClockTicker()
    epoch++
    const requestId = epoch
    store.aiThinking = a2.player
    try {
      // 传给 Worker 前脱去 Vue 响应式代理，否则 structured clone 会抛 DataCloneError
      const plainState = JSON.parse(JSON.stringify(store.game)) as GameState
      ensureWorker().postMessage({ id: requestId, state: plainState, level, engine: store.gameEngine, threads: store.settings.searchThreads })
      aiWatchdog = setTimeout(() => {
        if (requestId !== epoch || store.aiThinking === null) return
        store.aiThinking = null
        disposeWorker()
        showToast('AI 响应超时，已启用安全走法')
        aiFallback()
      }, 60000)
    } catch (err) {
      store.aiThinking = null
      disposeWorker()
      showToast(`AI Worker 启动失败，已启用安全走法：${String(err)}`)
      aiFallback()
    }
  }, delay)
}

// ---------------------------------------------------------------- 对局操作

function pushSnapshot(clock = store.clock): void {
  store.snapshots.push(JSON.parse(JSON.stringify(store.game)) as GameState)
  store.clockSnapshots.push(cloneClock(clock))
}

function autosave(): void {
  try {
    const now = Date.now()
    const savedClock = settleClock(store.clock, now).clock
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        record: serializeRecord(store.game),
        mode: store.mode,
        engine: store.gameEngine,
        clock: { ...savedClock, startedAtMs: null, paused: true }
      })
    )
  } catch {
    /* 忽略存储失败 */
  }
}

export function autosaveNow(): void {
  autosave()
}

interface ApplyEventOptions {
  forceTimeout?: boolean
  report?: AiReport | null
}

function applyEventToGame(ev: GameEvent, by: 0 | 1, options: ApplyEventOptions = {}): boolean {
  const now = Date.now()
  const activeBefore = currentActor(store.game)
  const clockPlayer = ev.type === 'timeout' ? ev.player : activeBefore?.player ?? null
  if (
    !options.forceTimeout &&
    store.replayIndex === null &&
    !store.clockPaused &&
    clockPlayer !== null &&
    remainingAt(store.clock, now)[clockPlayer] <= 0
  ) {
    triggerClockTimeout(clockPlayer)
    return false
  }

  const clockBefore = cloneClock(store.clock)
  const settled = settleClock(store.clock, now)
  const elapsedMs = Math.max(0, now - store.turnStartedAt)
  const { result, state } = applyEvent(store.game, ev)
  if (!result.ok) {
    showToast(result.error ?? '操作非法')
    return false
  }

  let clockAfter = settled.clock
  if (state.phase === 'OVER' || store.replayIndex !== null) {
    clockAfter = { ...clockAfter, activePlayer: null, startedAtMs: null, paused: store.replayIndex !== null }
    stopClockTicker()
  } else if (store.clockPaused) {
    const nextPlayer = currentActor(state)?.player ?? null
    clockAfter = { ...clockAfter, activePlayer: nextPlayer, startedAtMs: null, paused: true }
    stopClockTicker()
  } else {
    const nextPlayer = currentActor(state)?.player ?? null
    clockAfter =
      nextPlayer === null
        ? { ...clockAfter, activePlayer: null, startedAtMs: null, paused: false }
        : startClock({ ...clockAfter, paused: false }, nextPlayer, now)
  }

  store.history.push({
    stateBefore: store.game,
    event: ev,
    by,
    elapsedMs,
    clockBefore,
    clockAfter: cloneClock(clockAfter),
    report: options.report ?? null
  })
  store.game = state
  setClock(clockAfter)
  store.clockNow = now
  pushSnapshot(clockAfter)
  // 评估曲线采样：仅中盘（PLAY）AI 落子——开局静态评估（±几百分）与 NN 估值（±1）
  // 量纲不同，混在一条曲线里会把纵轴撑爆，故开局手不采样
  if (ev.type === 'move' && state.phase === 'PLAY' && options.report?.score != null) {
    store.evalTrail.push({ ply: state.moves.length - 1, score: options.report.score })
  }
  // 交换发生身份互换时，明确告知用户当前执子色（消除"我明明是黑方"的困惑）
  if (ev.type === 'swap' && ev.accept) {
    const hi = humanIndex.value
    if (hi !== null) {
      const who = by === hi ? '你' : 'AI'
      showToast(`${who}选择交换：你现在${store.game.blackOwner === hi ? '执黑' : '执白'}`)
    }
  }
  if (store.game.phase !== 'V2_TEN_OFFER') store.offerDraft = []
  store.confirmForbidden = null
  store.turnStartedAt = now
  autosave()
  if (store.game.phase === 'OVER') {
    store.autoplay = false
    store.replayIndex = null
    store.aiThinking = null
    stopClockTicker()
  } else {
    startClockTicker()
    scheduleAi()
  }
  return true
}

export function clickCell(pos: Pos): void {
  if (store.replayIndex !== null || store.clockPaused) return
  const a = actor.value
  if (!a || store.game.players[a.player].kind !== 'human') return
  switch (a.kind) {
    case 'move': {
      if (store.game.board[idx(pos.x, pos.y)] !== 0) return
      // 黑方禁手点：确认后落子判负
      if (forbiddenAt(store.game, pos)) {
        store.confirmForbidden = pos
        return
      }
      applyEventToGame({ type: 'move', pos }, a.player)
      break
    }
    case 'offers': {
      // 摆点模式：点击切换候选点
      const i = store.offerDraft.findIndex((p) => p.x === pos.x && p.y === pos.y)
      if (i >= 0) {
        store.offerDraft.splice(i, 1)
        return
      }
      if (store.game.board[idx(pos.x, pos.y)] !== 0) return
      if (store.offerDraft.length >= 10) {
        showToast('最多摆 10 个候选点')
        return
      }
      // 中心对称检查
      const sym = store.offerDraft.some((p) => p.x + pos.x === 14 && p.y + pos.y === 14)
      if (sym) {
        showToast('该点与已选点关于天元对称，不允许')
        return
      }
      store.offerDraft.push(pos)
      break
    }
    case 'pick': {
      const i = store.game.offers.findIndex((p) => p.x === pos.x && p.y === pos.y)
      if (i < 0) {
        showToast('请点击 10 个候选点之一')
        return
      }
      applyEventToGame({ type: 'pick', index: i }, a.player)
      break
    }
    default:
      break
  }
}

export function humanSwap(accept: boolean): void {
  if (store.clockPaused) return
  const a = actor.value
  if (!a || a.kind !== 'swap' || store.game.players[a.player].kind !== 'human') return
  applyEventToGame({ type: 'swap', accept }, a.player)
}

export function humanVariant(variant: Variant): void {
  if (store.clockPaused) return
  const a = actor.value
  if (!a || a.kind !== 'variant' || store.game.players[a.player].kind !== 'human') return
  applyEventToGame({ type: 'variant', variant }, a.player)
}

export function humanConfirmOffers(): void {
  if (store.clockPaused) return
  const a = actor.value
  if (!a || a.kind !== 'offers' || store.game.players[a.player].kind !== 'human') return
  if (store.offerDraft.length !== 10) {
    showToast(`需要恰好 10 个候选点（当前 ${store.offerDraft.length} 个）`)
    return
  }
  applyEventToGame({ type: 'offers', points: [...store.offerDraft] }, a.player)
}

export function confirmForbiddenMove(): void {
  if (store.clockPaused) return
  const pos = store.confirmForbidden
  if (!pos) return
  const a = actor.value
  if (!a || a.kind !== 'move') return
  applyEventToGame({ type: 'move', pos }, a.player)
}

export function undoLast(): void {
  if (humanIndex.value === null) return
  const hi = humanIndex.value
  epoch++ // 取消进行中的 AI 决策
  store.aiThinking = null
  disposeWorker()
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  stopClockTicker()
  let idxToRestore = -1
  for (let i = store.history.length - 1; i >= 0; i--) {
    if (store.history[i].by === hi) {
      idxToRestore = i
      break
    }
  }
  if (idxToRestore < 0) {
    showToast('没有可撤销的你方决策')
    return
  }
  const entry = store.history[idxToRestore]
  store.game = entry.stateBefore
  store.history = store.history.slice(0, idxToRestore)
  store.snapshots = store.snapshots.slice(0, idxToRestore + 1)
  store.clockSnapshots = store.clockSnapshots.slice(0, idxToRestore + 1)
  store.replayIndex = null
  store.offerDraft = []
  store.lastReason = ''
  store.lastReport = null
  // 评估曲线只保留回退后仍存在的采样点
  store.evalTrail = store.evalTrail.filter((e) => e.ply < entry.stateBefore.moves.length)
  const restoredClock = store.clockSnapshots[store.clockSnapshots.length - 1] ?? entry.clockBefore
  store.clock = cloneClock(restoredClock)
  store.clockPaused = false
  store.clockNow = Date.now()
  store.turnStartedAt = Date.now()
  startClockForState(store.game)
  autosave()
  scheduleAi()
  showToast('已回退到你最近一次决策之前')
}

export function resignGame(): void {
  const hi = humanIndex.value
  if (hi === null) return
  applyEventToGame({ type: 'resign', player: hi }, hi)
}

// ---------------------------------------------------------------- 新对局

export function startNewGame(cfg: NewGameConfig): void {
  epoch++
  store.aiThinking = null
  disposeWorker()
  stopClockTicker()
  store.lastConfig = cfg
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  let players: [Player, Player]
  let firstBlack: 0 | 1 = 0
  store.gameEngine = cfg.engine
  if (cfg.mode === 'ai-vs-ai') {
    players = [makeAi(), makeAi()]
  } else {
    const side = cfg.side === 'random' ? (Math.random() < 0.5 ? 'black' : 'white') : cfg.side
    players = side === 'black' ? [makeHuman(), makeAi()] : [makeAi(), makeHuman()]
    firstBlack = 0
  }
  store.mode = cfg.mode
  store.game = newGame(players, firstBlack)
  store.history = []
  store.offerDraft = []
  store.replayIndex = null
  store.autoplay = false
  store.lastReason = ''
  store.lastReport = null
  store.evalTrail = []
  store.confirmForbidden = null
  store.snapshots = []
  store.clockSnapshots = []
  aiFallbackCount = 0
  timeoutInFlight = false
  store.clockPaused = false
  const now = Date.now()
  store.clock = startClock(createClock(), currentActor(store.game)?.player ?? 0, now)
  store.clockNow = now
  store.turnStartedAt = now
  pushSnapshot(store.clock)
  startClockTicker()
  autosave()
  scheduleAi()
}

// ---------------------------------------------------------------- 自动保存恢复

export function tryRestore(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return false
    const data = JSON.parse(raw) as {
      record: GameRecord
      mode: Mode
      engine?: AiEngine
      clock?: Partial<ClockSnapshot>
    }
    const r = deserializeRecord(data.record)
    if (!r.ok || !r.state) return false
    if (r.state.phase === 'OVER') return false
    epoch++
    store.aiThinking = null
    disposeWorker()
    stopClockTicker()
    store.game = r.state
    store.mode = data.mode
    store.gameEngine = data.engine ?? 'onnx'
    // 重建快照：从初始状态重放到当前（简单起见，快照仅含当前局面）
    store.history = []
    store.snapshots = []
    store.clockSnapshots = []
    store.lastReport = null
    store.evalTrail = []
    store.clockPaused = false
    aiFallbackCount = 0
    timeoutInFlight = false
    const savedClock = data.clock
    const restoredClock: ClockSnapshot =
      savedClock && Array.isArray(savedClock.remainingMs) && savedClock.remainingMs.length === 2
        ? {
            remainingMs: [
              Math.max(0, Number(savedClock.remainingMs[0]) || 0),
              Math.max(0, Number(savedClock.remainingMs[1]) || 0)
            ],
            activePlayer: null,
            startedAtMs: null,
            paused: false
          }
        : createClock()
    store.clock = restoredClock
    store.clockNow = Date.now()
    store.turnStartedAt = Date.now()
    pushSnapshot(store.clock)
    startClockForState(store.game)
    scheduleAi()
    showToast('已恢复上次未完成的对局')
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 导入导出

/** 导出文件名的胜负后缀：白胜 -W / 黑胜 -B / 和棋 -H / 未分胜负（无后缀） */
function resultSuffix(game: GameState): string {
  const r = game.result
  if (!r) return ''
  if (r.winner === null) return '-H'
  return r.winner === game.blackOwner ? '-B' : '-W'
}

export async function exportGame(psq: boolean): Promise<void> {
  if (!window.renju) {
    showToast('文件对话框不可用（非 Electron 环境）')
    return
  }
  const date = new Date().toISOString().slice(0, 10)
  const suffix = resultSuffix(store.game)
  const contents = psq ? exportPsq(store.game) : JSON.stringify(serializeRecord(store.game), null, 2)
  const r = await window.renju.saveFile({
    defaultName: `renju-${date}${suffix}.${psq ? 'psq' : 'json'}`,
    contents,
    psq
  })
  if (r?.error) showToast(`导出失败：${r.error}`)
  else if (r) showToast(`已导出：${r.name}`)
}

export async function importGame(psq: boolean): Promise<void> {
  if (!window.renju) {
    showToast('文件对话框不可用（非 Electron 环境）')
    return
  }
  const r = await window.renju.openFile(psq ? 'psq' : 'json')
  if (!r || r.error) {
    if (r?.error) showToast(`读取失败：${r.error}`)
    return
  }
  if (psq) {
    importPsqText(r.contents)
  } else {
    importJsonText(r.contents)
  }
}

function importJsonText(text: string): void {
  let rec: GameRecord
  try {
    rec = JSON.parse(text) as GameRecord
  } catch {
    showToast('JSON 解析失败')
    return
  }
  const r = deserializeRecord(rec)
  if (!r.ok || !r.state) {
    showToast(`棋谱无效：${r.error}`)
    return
  }
  epoch++
  store.aiThinking = null
  disposeWorker()
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  stopClockTicker()
  store.mode = r.state.players.every((p) => p.kind === 'ai') ? 'ai-vs-ai' : 'human-vs-ai'
  store.game = r.state
  store.history = []
  store.offerDraft = []
  store.lastReason = ''
  store.lastReport = null
  store.evalTrail = []
  store.clockSnapshots = []
  store.clock = { ...createClock(), activePlayer: null, startedAtMs: null, paused: true }
  store.clockPaused = true
  store.clockNow = Date.now()
  // 进入回放模式
  store.snapshots = [r.state]
  store.clockSnapshots = [cloneClock(store.clock)]
  store.replayIndex = 0
  showToast('已导入棋谱（回放模式，不计时）')
}

function importPsqText(text: string): void {
  const r = parsePsq(text)
  if (!r.ok || !r.data) {
    showToast(`psq 解析失败：${r.error}`)
    return
  }
  const { moves, names, errCode } = r.data
  const board = new Array(225).fill(0) as Board
  moves.forEach((p, i) => {
    board[idx(p.x, p.y)] = (i % 2 === 0 ? 1 : 2) as 1 | 2
  })
  const players: [Player, Player] = [
    { kind: 'human', name: names[0] || '玩家一' },
    { kind: 'human', name: names[1] || '玩家二' }
  ]
  const state = newGame(players, 0)
  state.board = board
  state.moves = moves
  state.phase = 'OVER'
  state.result =
    errCode === 1
      ? { winner: 0, reason: 'five', comment: 'psq 记录：黑胜' }
      : errCode === 2
        ? { winner: 1, reason: 'five', comment: 'psq 记录：白胜' }
        : { winner: null, reason: 'draw', comment: 'psq 记录：未注明结果' }
  epoch++
  store.aiThinking = null
  disposeWorker()
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  stopClockTicker()
  store.mode = 'human-vs-ai'
  store.game = state
  store.history = []
  store.offerDraft = []
  store.lastReason = ''
  store.lastReport = null
  store.evalTrail = []
  store.clockSnapshots = [cloneClock({ ...createClock(), activePlayer: null, startedAtMs: null, paused: true })]
  store.clock = store.clockSnapshots[0]
  store.clockPaused = true
  store.clockNow = Date.now()
  store.snapshots = [state]
  store.replayIndex = 0
  showToast('已导入 psq 棋谱：不含塔拉山口开局信息，按纯落子回放（不计时）')
}

// ---------------------------------------------------------------- 回放

export function replayGo(i: number): void {
  if (store.snapshots.length === 0) return
  if (store.replayIndex === null) freezeClockForReplay()
  store.replayIndex = Math.max(0, Math.min(store.snapshots.length - 1, i))
  store.autoplay = false
}

export function replayLive(): void {
  if (store.replayIndex === null) return
  store.replayIndex = null
  store.autoplay = false
  const now = Date.now()
  store.clockPaused = replayClockWasPaused
  if (store.game.phase === 'OVER' || store.clockPaused) {
    setClock({ ...store.clock, activePlayer: null, startedAtMs: null, paused: store.clockPaused })
    store.clockNow = now
    stopClockTicker()
    return
  }
  startClockForState(store.game, now)
  scheduleAi()
}

export function replayToggleAutoplay(): void {
  store.autoplay = !store.autoplay
}

// ---------------------------------------------------------------- 杂项

let toastTimer: ReturnType<typeof setTimeout> | null = null
export function showToast(msg: string): void {
  store.toast = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (store.toast = ''), 3200)
}

export function regionOfDisplay(): number | null {
  return regionRadius(displayState.value)
}
