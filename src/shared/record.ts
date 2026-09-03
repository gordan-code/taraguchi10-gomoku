/**
 * 棋谱全量保真格式（RenjuMaster JSON）：
 * 记录完整开局决策序列（交换/走法选择/十打点/选点）+ 中盘落子 + 结果。
 * 反序列化通过"事件重放"用 FSM 还原，保证规则一致性。
 */
import {
  AiLevel,
  GameEvent,
  GameState,
  OpeningEntry,
  Player,
  Pos,
  parsePos,
  posName
} from './index'
import { applyEvent, newGame } from './fsm'

export interface RecordPlayerInfo {
  type: 'human' | 'ai'
  name: string
  level?: AiLevel
}

export type SerializedOpening =
  | { step: number; action: 'move'; pos: string }
  | { step: number; action: 'swap-offer'; by: 0 | 1; decision: boolean }
  | { step: number; action: 'variant-choice'; by: 0 | 1; variant: 1 | 2 }
  | { step: number; action: 'ten-offers'; by: 0 | 1; points: string[] }
  | { step: number; action: 'pick-offer'; by: 0 | 1; picked: string }

export interface GameRecord {
  format: 'renju-master-game'
  version: 1
  meta: {
    rule: 'taraguchi-10'
    date: string
    /** players[0] = 开局时的假黑方 */
    players: [RecordPlayerInfo, RecordPlayerInfo]
    /** 假黑方对应 players 的索引（0/1） */
    firstBlack: 0 | 1
    /** 终局执黑/执白的玩家名（交换后） */
    black: string
    white: string
    resultSummary: string
  }
  /** 开局决策事件（含开局落子） */
  opening: SerializedOpening[]
  /** 中盘落子（开局之后） */
  moves: string[]
  result?: {
    winner: 'black' | 'white' | null
    reason: string
    line?: string[]
    forbiddenPos?: string
    forbiddenKind?: string
  }
}

const posList = (ps: Pos[]): string[] => ps.map(posName)

export function serializeRecord(state: GameState, date = new Date().toISOString()): GameRecord {
  const blackIdx = state.blackOwner
  const whiteIdx = blackIdx === 0 ? 1 : 0
  const toInfo = (p: Player): RecordPlayerInfo => ({
    type: p.kind,
    name: p.name,
    ...(p.aiLevel ? { level: p.aiLevel } : {})
  })
  // 开局阶段记录 = 决策事件（交换/走法/打点/选点）+ 前 5 手落子；
  // 第 6 手起进入中盘落子列表（FSM 的 opening 日志包含全部落子，这里按手数切分）；
  // 走法二的第 5 手由 pick-offer 事件表达，其 move 条目冗余，需剔除
  const opening = state.opening
    .filter((e) => {
      if (e.action !== 'move') return true
      if (e.step > 5) return false
      if (state.variant === 2 && e.step === 5) return false
      return true
    })
    .map((e) => serializeOpeningEntry(e))
  const playMoves = state.moves.slice(5).map(posName)

  const r = state.result
  const winnerName =
    r == null || r.winner === null ? null : r.winner === blackIdx ? 'black' : 'white'
  const summary = r
    ? r.winner === null
      ? 'draw'
      : `${winnerName}-win-${r.reason}`
    : 'unfinished'

  return {
    format: 'renju-master-game',
    version: 1,
    meta: {
      rule: 'taraguchi-10',
      date,
      players: [toInfo(state.players[0]), toInfo(state.players[1])],
      firstBlack: 0,
      black: state.players[blackIdx].name,
      white: state.players[whiteIdx].name,
      resultSummary: summary
    },
    opening,
    moves: playMoves,
    result: r
      ? {
          winner: r.winner === null ? null : r.winner === blackIdx ? 'black' : 'white',
          reason: r.reason,
          ...(r.line ? { line: posList(r.line) } : {}),
          ...(r.forbiddenPos ? { forbiddenPos: posName(r.forbiddenPos) } : {}),
          ...(r.forbiddenKind ? { forbiddenKind: r.forbiddenKind } : {})
        }
      : undefined
  }
}

function serializeOpeningEntry(e: OpeningEntry): SerializedOpening {
  switch (e.action) {
    case 'move':
      return { step: e.step, action: 'move', pos: posName(e.pos) }
    case 'swap-offer':
      return { step: e.step, action: 'swap-offer', by: e.by, decision: e.decision }
    case 'variant-choice':
      return { step: e.step, action: 'variant-choice', by: e.by, variant: e.variant }
    case 'ten-offers':
      return { step: e.step, action: 'ten-offers', by: e.by, points: posList(e.points) }
    case 'pick-offer':
      return { step: e.step, action: 'pick-offer', by: e.by, picked: posName(e.picked) }
  }
}

export interface DeserializeResult {
  ok: boolean
  error?: string
  state?: GameState
}

/** 通过事件重放还原对局（含开局交换与打点流程） */
export function deserializeRecord(rec: GameRecord): DeserializeResult {
  if (rec.format !== 'renju-master-game' || rec.version !== 1) {
    return { ok: false, error: '不是有效的 RenjuMaster 棋谱格式' }
  }
  const players: [Player, Player] = [
    { kind: rec.meta.players[0].type, name: rec.meta.players[0].name, aiLevel: rec.meta.players[0].level },
    { kind: rec.meta.players[1].type, name: rec.meta.players[1].name, aiLevel: rec.meta.players[1].level }
  ]
  let s = newGame(players, rec.meta.firstBlack ?? 0)

  for (const e of rec.opening) {
    let ev: GameEvent | null = null
    if (e.action === 'pick-offer') {
      const p = parsePos(e.picked)
      if (p) {
        const i = s.offers.findIndex((o) => o.x === p.x && o.y === p.y)
        if (i >= 0) ev = { type: 'pick', index: i }
      }
    } else if (e.action === 'move') {
      const p = parsePos(e.pos)
      if (p) ev = { type: 'move', pos: p }
    } else if (e.action === 'swap-offer') {
      ev = { type: 'swap', accept: e.decision }
    } else if (e.action === 'variant-choice') {
      ev = { type: 'variant', variant: e.variant }
    } else if (e.action === 'ten-offers') {
      const pts = e.points.map(parsePos)
      if (!pts.some((p) => !p)) ev = { type: 'offers', points: pts as Pos[] }
    }
    if (!ev) return { ok: false, error: `开局记录无法识别：${JSON.stringify(e)}` }
    const { result, state } = applyEvent(s, ev)
    if (!result.ok) return { ok: false, error: `重放开局失败（步骤 ${e.step}）：${result.error}` }
    s = state
  }
  for (const m of rec.moves) {
    const p = parsePos(m)
    if (!p) return { ok: false, error: `落子坐标非法：${m}` }
    const { result, state } = applyEvent(s, { type: 'move', pos: p })
    if (!result.ok) return { ok: false, error: `重放落子 ${m} 失败：${result.error}` }
    s = state
  }
  // 认输/超时等非棋盘终局：直接补上对应结果，保留 timeout 语义
  if (
    s.phase !== 'OVER' &&
    rec.result &&
    rec.result.reason !== 'five' &&
    rec.result.reason !== 'overline' &&
    rec.result.reason !== 'forbidden' &&
    rec.result.reason !== 'draw'
  ) {
    const winnerIdx: 0 | 1 | null =
      rec.result.winner === null ? null : rec.result.winner === 'black' ? s.blackOwner : s.blackOwner === 0 ? 1 : 0
    if (winnerIdx !== null) {
      const loserIdx: 0 | 1 = winnerIdx === 0 ? 1 : 0
      const event: GameEvent = rec.result.reason === 'timeout'
        ? { type: 'timeout', player: loserIdx }
        : { type: 'resign', player: loserIdx }
      const { state } = applyEvent(s, event)
      s = state
    }
  }
  return { ok: true, state: s }
}

function openingEventFromSerialized(e: SerializedOpening): GameEvent | null {
  switch (e.action) {
    case 'move': {
      const p = parsePos(e.pos)
      return p ? { type: 'move', pos: p } : null
    }
    case 'swap-offer':
      return { type: 'swap', accept: e.decision }
    case 'variant-choice':
      return { type: 'variant', variant: e.variant }
    case 'ten-offers': {
      const pts = e.points.map(parsePos)
      if (pts.some((p) => !p)) return null
      return { type: 'offers', points: pts as Pos[] }
    }
    default:
      return null
  }
}

/** 导入用：根据坐标从当前 offers 找序号再 pick */
export function pickIndexByPos(state: GameState, pos: Pos): number {
  return state.offers.findIndex((o) => o.x === pos.x && o.y === pos.y)
}
