/**
 * 塔拉山口-10（Taraguchi-10）开局规则状态机 + 中盘对弈。
 *
 * 阶段流转（详见 PRD 第 4 章；交换权归"刚落子一方的对手"）：
 *   S1_MOVE(天元) → S1_SWAP → S2_MOVE(3×3) → S2_SWAP → S3_MOVE(5×5) → S3_SWAP
 *   → S4_MOVE(7×7) → VARIANT_CHOICE
 *       ├─ 走法一：S4_SWAP(E4) → V1_S5_MOVE(9×9) → V1_S5_SWAP(E5) → S6_MOVE(任意)
 *       └─ 走法二：V2_TEN_OFFER(10打点) → V2_TEN_PICK(白十选一) → S6_MOVE(任意)
 *   → PLAY（黑方禁手生效）→ OVER
 *
 * 棋子颜色严格黑白交替（交换只改变"谁执黑"，不改变落子颜色次序）。
 * 第 4/5 手后的交换（E4/E5）仅存在于走法一；走法二在第 4 手后直接进入十打点。
 */
import {
  Board,
  Color,
  GameResult,
  OpeningEntry,
  Player,
  Pos,
  SIZE,
  Variant,
  idx,
  posEq
} from './types'
import { cloneBoard, emptyBoard, findWinningLine, isCenterSymmetric, withinCentral } from './board'
import { checkForbidden } from './forbidden'

export type Phase =
  | 'S1_MOVE'
  | 'S1_SWAP'
  | 'S2_MOVE'
  | 'S2_SWAP'
  | 'S3_MOVE'
  | 'S3_SWAP'
  | 'S4_MOVE'
  | 'S4_SWAP'
  | 'VARIANT_CHOICE'
  | 'V1_S5_MOVE'
  | 'V1_S5_SWAP'
  | 'V2_TEN_OFFER'
  | 'V2_TEN_PICK'
  | 'S6_MOVE'
  | 'PLAY'
  | 'OVER'

export interface GameState {
  players: [Player, Player]
  /** 当前执黑玩家索引（交换会改变） */
  blackOwner: 0 | 1
  phase: Phase
  board: Board
  /** 实际落子序列（含开局阶段） */
  moves: Pos[]
  /** 走法二：黑方摆出的 10 个第 5 手候选点 */
  offers: Pos[]
  variant?: Variant
  opening: OpeningEntry[]
  result?: GameResult
}

export type GameEvent =
  | { type: 'move'; pos: Pos }
  | { type: 'swap'; accept: boolean }
  | { type: 'variant'; variant: Variant }
  | { type: 'offers'; points: Pos[] }
  | { type: 'pick'; index: number }
  | { type: 'resign'; player: 0 | 1 }
  | { type: 'timeout'; player: 0 | 1 }

export type ActKind = 'move' | 'swap' | 'variant' | 'offers' | 'pick'

export interface Actor {
  player: 0 | 1
  kind: ActKind
}

export interface ApplyResult {
  ok: boolean
  error?: string
}

const other = (p: 0 | 1): 0 | 1 => (p === 0 ? 1 : 0)

export function newGame(players: [Player, Player], firstBlack: 0 | 1 = 0): GameState {
  return {
    players,
    blackOwner: firstBlack,
    phase: 'S1_MOVE',
    board: emptyBoard(),
    moves: [],
    offers: [],
    opening: []
  }
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    players: [{ ...s.players[0] }, { ...s.players[1] }],
    board: cloneBoard(s.board),
    moves: s.moves.map((m) => ({ ...m })),
    offers: s.offers.map((m) => ({ ...m })),
    opening: s.opening.map((e) => ({ ...e })),
    result: s.result ? { ...s.result, line: s.result.line?.map((p) => ({ ...p })) } : undefined
  }
}

/** 当前该谁行动（OVER / 已结束返回 null） */
export function currentActor(s: GameState): Actor | null {
  if (s.phase === 'OVER') return null
  const moveCount = s.moves.length
  const toPlaceBlack = moveCount % 2 === 0
  switch (s.phase) {
    case 'S1_MOVE':
    case 'S2_MOVE':
    case 'S3_MOVE':
    case 'S4_MOVE':
    case 'V1_S5_MOVE':
    case 'S6_MOVE':
    case 'PLAY':
      return { player: toPlaceBlack ? s.blackOwner : other(s.blackOwner), kind: 'move' }
    case 'S1_SWAP':
    case 'S2_SWAP':
    case 'S3_SWAP':
    case 'S4_SWAP':
    case 'V1_S5_SWAP':
      // 刚落子一方的对手决定是否交换
      return { player: toPlaceBlack ? s.blackOwner : other(s.blackOwner), kind: 'swap' }
    case 'VARIANT_CHOICE':
    case 'V2_TEN_OFFER':
      return { player: s.blackOwner, kind: s.phase === 'VARIANT_CHOICE' ? 'variant' : 'offers' }
    case 'V2_TEN_PICK':
      return { player: other(s.blackOwner), kind: 'pick' }
    default:
      return null
  }
}

/** 各开局落子阶段的中心区域半径（3×3 → r=1 … 9×9 → r=4）；非区域约束阶段返回 null */
export function regionRadius(s: GameState): number | null {
  switch (s.phase) {
    case 'S1_MOVE':
      return 0 // 仅天元
    case 'S2_MOVE':
      return 1
    case 'S3_MOVE':
      return 2
    case 'S4_MOVE':
      return 3
    case 'V1_S5_MOVE':
      return 4
    default:
      return null
  }
}

/** 落子是否合法（仅校验占位与区域约束；黑方禁手由判定引擎另行处理——禁手允许落下但判负） */
export function movePlacementLegal(s: GameState, pos: Pos): string | null {
  if (s.phase === 'OVER') return '对局已结束'
  const actor = currentActor(s)
  if (!actor || actor.kind !== 'move') return '当前不是落子阶段'
  if (s.board[idx(pos.x, pos.y)] !== 0) return '该点已有棋子'
  const r = regionRadius(s)
  if (r !== null) {
    if (r === 0) {
      if (!(pos.x === 7 && pos.y === 7)) return '第 1 手必须落在天元'
    } else if (!withinCentral(pos, r)) {
      return `本手必须落在中央 ${(2 * r + 1)}×${(2 * r + 1)} 区域内`
    }
  }
  return null
}

/** 黑方 p 点当前是否禁手（供 UI 标记与确认提示） */
export function forbiddenAt(s: GameState, p: Pos): boolean {
  const placingBlack = s.moves.length % 2 === 0
  if (!placingBlack || s.board[idx(p.x, p.y)] !== 0) return false
  const b = cloneBoard(s.board)
  b[idx(p.x, p.y)] = 1
  return checkForbidden(b, p) !== null
}

function placeStone(s: GameState, pos: Pos, color: Color): void {
  s.board[idx(pos.x, pos.y)] = color
  s.moves.push({ ...pos })
  s.opening.push({ step: s.moves.length, action: 'move', pos: { ...pos } })
}

/** 落子后统一终局检查；返回 true 表示对局结束 */
function checkGameEnd(s: GameState, pos: Pos, color: Color): boolean {
  const blackOwner = s.blackOwner
  const whiteOwner = other(blackOwner)
  if (color === 1) {
    const five = findWinningLine(s.board, pos, 1, true)
    if (five) {
      s.result = { winner: blackOwner, reason: 'five', line: five }
      s.phase = 'OVER'
      return true
    }
    const kind = checkForbidden(s.board, pos)
    if (kind) {
      s.result = {
        winner: whiteOwner,
        reason: 'forbidden',
        forbiddenPos: { ...pos },
        forbiddenKind: kind
      }
      s.phase = 'OVER'
      return true
    }
  } else {
    const line = findWinningLine(s.board, pos, 2, false)
    if (line) {
      s.result = {
        winner: whiteOwner,
        reason: line.length > 5 ? 'overline' : 'five',
        line: line.slice(0, Math.max(5, line.length))
      }
      s.phase = 'OVER'
      return true
    }
  }
  if (s.moves.length >= SIZE * SIZE) {
    s.result = { winner: null, reason: 'draw' }
    s.phase = 'OVER'
    return true
  }
  return false
}

function validateTenOffers(s: GameState, points: Pos[]): string | null {
  if (s.phase !== 'V2_TEN_OFFER') return '当前不是十打点摆放阶段'
  if (points.length !== 10) return `必须恰好摆出 10 个候选点（当前 ${points.length} 个）`
  for (const p of points) {
    if (p.x < 0 || p.x > 14 || p.y < 0 || p.y > 14) return '候选点越界'
    if (s.board[idx(p.x, p.y)] !== 0) return '候选点不能落在已有棋子上'
  }
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (posEq(points[i], points[j])) return '候选点存在重复'
      if (isCenterSymmetric(points[i], points[j]))
        return `候选点 ${points[i].x},${points[i].y} 与 ${points[j].x},${points[j].y} 关于天元对称，不允许`
    }
  }
  return null
}

/** 应用一个事件（原状态不变，返回克隆后的新状态；通过 result.ok 表示是否成功） */
export function applyEvent(state: GameState, ev: GameEvent): { result: ApplyResult; state: GameState } {
  const s = cloneState(state)
  const r = applyInPlace(s, ev)
  return { result: r, state: s }
}

function applyInPlace(s: GameState, ev: GameEvent): ApplyResult {
  if (s.phase === 'OVER' && ev.type !== 'resign' && ev.type !== 'timeout') {
    return { ok: false, error: '对局已结束' }
  }
  const actor = currentActor(s)

  switch (ev.type) {
    case 'resign': {
      if (s.phase === 'OVER') return { ok: false, error: '对局已结束' }
      s.result = { winner: other(ev.player), reason: 'resign', comment: '认输' }
      s.phase = 'OVER'
      return { ok: true }
    }
    case 'timeout': {
      if (s.phase === 'OVER') return { ok: false, error: '对局已结束' }
      if (!actor || actor.player !== ev.player) return { ok: false, error: '只能由当前行动方触发超时' }
      s.result = { winner: other(ev.player), reason: 'timeout', comment: '超时' }
      s.phase = 'OVER'
      return { ok: true }
    }
    case 'move': {
      if (!actor || actor.kind !== 'move') return { ok: false, error: '当前不是落子阶段' }
      const err = movePlacementLegal(s, ev.pos)
      if (err) return { ok: false, error: err }
      const color: Color = s.moves.length % 2 === 0 ? 1 : 2
      placeStone(s, ev.pos, color)
      // 阶段推进
      switch (s.phase) {
        case 'S1_MOVE':
          s.phase = 'S1_SWAP'
          break
        case 'S2_MOVE':
          s.phase = 'S2_SWAP'
          break
        case 'S3_MOVE':
          s.phase = 'S3_SWAP'
          break
        case 'S4_MOVE':
          s.phase = 'VARIANT_CHOICE'
          break
        case 'V1_S5_MOVE':
          s.phase = 'V1_S5_SWAP'
          break
        case 'S6_MOVE':
          s.phase = 'PLAY'
          break
        case 'PLAY':
          break
        default:
          return { ok: false, error: '非法阶段' }
      }
      // 中盘（含 S6 起的每一手）做终局判定；开局前 6 手理论不可能终局，统一检查亦无害
      if (s.moves.length >= 6) checkGameEnd(s, ev.pos, color)
      return { ok: true }
    }
    case 'swap': {
      if (!actor || actor.kind !== 'swap') return { ok: false, error: '当前不是交换决策阶段' }
      const by = actor.player
      if (ev.accept) s.blackOwner = other(s.blackOwner)
      s.opening.push({ step: s.moves.length + 1, action: 'swap-offer', by, decision: ev.accept })
      switch (s.phase) {
        case 'S1_SWAP':
          s.phase = 'S2_MOVE'
          break
        case 'S2_SWAP':
          s.phase = 'S3_MOVE'
          break
        case 'S3_SWAP':
          s.phase = 'S4_MOVE'
          break
        case 'S4_SWAP':
          s.phase = 'V1_S5_MOVE'
          break
        case 'V1_S5_SWAP':
          s.phase = 'S6_MOVE'
          break
        default:
          return { ok: false, error: '非法阶段' }
      }
      return { ok: true }
    }
    case 'variant': {
      if (s.phase !== 'VARIANT_CHOICE') return { ok: false, error: '当前不是走法选择阶段' }
      if (!actor || actor.kind !== 'variant') return { ok: false, error: '当前不是你的走法选择' }
      if (ev.variant !== 1 && ev.variant !== 2) return { ok: false, error: '非法走法' }
      s.variant = ev.variant
      s.opening.push({
        step: s.moves.length + 1,
        action: 'variant-choice',
        by: actor.player,
        variant: ev.variant
      })
      s.phase = ev.variant === 1 ? 'S4_SWAP' : 'V2_TEN_OFFER'
      return { ok: true }
    }
    case 'offers': {
      const err = validateTenOffers(s, ev.points)
      if (err) return { ok: false, error: err }
      s.offers = ev.points.map((p) => ({ ...p }))
      s.opening.push({
        step: s.moves.length + 1,
        action: 'ten-offers',
        by: actor?.player ?? 0,
        points: ev.points.map((p) => ({ ...p }))
      })
      s.phase = 'V2_TEN_PICK'
      return { ok: true }
    }
    case 'pick': {
      if (s.phase !== 'V2_TEN_PICK') return { ok: false, error: '当前不是打点选择阶段' }
      if (!actor || actor.kind !== 'pick') return { ok: false, error: '当前不是你的选点' }
      if (ev.index < 0 || ev.index >= s.offers.length) return { ok: false, error: '选点序号非法' }
      const pos = s.offers[ev.index]
      s.opening.push({
        step: s.moves.length + 1,
        action: 'pick-offer',
        by: actor.player,
        picked: { ...pos }
      })
      placeStone(s, pos, 1) // 第 5 手是黑子
      s.offers = []
      s.phase = 'S6_MOVE'
      return { ok: true }
    }
    default:
      return { ok: false, error: '未知事件' }
  }
}

/** 阶段中文描述（用于状态栏与阶段指引条） */
export function phaseLabel(s: GameState): string {
  switch (s.phase) {
    case 'S1_MOVE':
      return '开局 · 第 1 手（黑，天元）'
    case 'S1_SWAP':
      return '开局 · 第 1 手后交换决策'
    case 'S2_MOVE':
      return '开局 · 第 2 手（白，中央 3×3）'
    case 'S2_SWAP':
      return '开局 · 第 2 手后交换决策'
    case 'S3_MOVE':
      return '开局 · 第 3 手（黑，中央 5×5）'
    case 'S3_SWAP':
      return '开局 · 第 3 手后交换决策'
    case 'S4_MOVE':
      return '开局 · 第 4 手（白，中央 7×7）'
    case 'S4_SWAP':
      return '开局 · 第 4 手后交换决策（走法一）'
    case 'VARIANT_CHOICE':
      return '开局 · 黑方选择第 5 手走法'
    case 'V1_S5_MOVE':
      return '开局 · 第 5 手（黑，中央 9×9，直接落子）'
    case 'V1_S5_SWAP':
      return '开局 · 第 5 手后交换决策'
    case 'V2_TEN_OFFER':
      return '开局 · 黑方摆出 10 个第 5 手候选点'
    case 'V2_TEN_PICK':
      return '开局 · 白方十选一'
    case 'S6_MOVE':
      return '开局 · 第 6 手（白，任意位置）'
    case 'PLAY':
      return `中盘对弈 · 第 ${s.moves.length + 1} 手`
    case 'OVER':
      return '对局结束'
  }
}
