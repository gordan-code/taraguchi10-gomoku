/**
 * 塔拉山口-10 开局决策 AI：
 * - 交换决策：浅层搜索评估局面，明显偏黑则交换执黑
 * - 走法一/二：比较两种走法对黑方的保障价值
 *   走法一：黑下最佳第 5 手后对方仍可交换 → 黑方所得 ≈ -|E|（对方必选优势方）
 *   走法二：摆 10 个打点、白方十选一 → 黑方所得 ≈ 10 个打点中的最差评估（最大化最小值）
 * - 十打点：取评估最高的前 10 个点（跳过中心对称对），最大化"最差打点"价值
 * - 十选一：白方选对黑评估最低（对自己最有利）的打点
 */
import { AiLevel, Board, Color, Pos, idx } from '../types'
import { GameState, applyEvent, currentActor, regionRadius } from '../fsm'
import { checkForbidden } from '../forbidden'
import { isCenterSymmetric, withinCentral } from '../board'
import { LEVELS, evaluate, searchBestMove, dynamicTimeMs } from './engine'
import type { ProgressHandler } from './engine'
import { lookupOpeningBook } from './opening-book'
import { AiReport } from './report'

export interface AiDecision {
  event:
    | { type: 'move'; pos: Pos }
    | { type: 'swap'; accept: boolean }
    | { type: 'variant'; variant: 1 | 2 }
    | { type: 'offers'; points: Pos[] }
    | { type: 'pick'; index: number }
  reason: string
  report?: AiReport
}

const openLevel = (level: AiLevel) => {
  // 开局阶段用较浅的搜索（局面简单，追求响应快）
  const base = LEVELS[level]
  return { ...base, maxDepth: Math.min(base.maxDepth, 4), timeMs: Math.min(base.timeMs, 1500) }
}

/** 黑方视角评估（正 = 黑优） */
function evalBlack(board: Board): number {
  return evaluate(board)
}

function candidatePoints(state: GameState, filter: (p: Pos) => boolean): Pos[] {
  const out: Pos[] = []
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const p = { x, y }
      if (state.board[idx(x, y)] === 0 && filter(p)) out.push(p)
    }
  }
  return out
}

/** 开局阶段的受限落子：在区域内搜索最佳点 */
function openingMove(state: GameState, level: AiLevel): AiDecision {
  const opts = openLevel(level)
  const color: Color = state.moves.length % 2 === 0 ? 1 : 2
  const r = regionRadius(state)
  const filter = r === null ? () => true : (p: Pos) => (r === 0 ? p.x === 7 && p.y === 7 : withinCentral(p, r))
  let cands = candidatePoints(state, filter)

  // 距已有棋子 ≤3 的点优先（开局本来就在中心区域，直接全搜也很快）
  if (cands.length > 40) {
    cands = cands.filter((p) => {
      for (const q of state.moves) {
        if (Math.abs(q.x - p.x) <= 3 && Math.abs(q.y - p.y) <= 3) return true
      }
      return false
    })
    if (cands.length === 0) cands = [{ x: 7, y: 7 }]
  }

  if (color === 1) {
    const legal = cands.filter((p) => {
      const b = state.board.slice() as Board
      b[idx(p.x, p.y)] = 1
      return checkForbidden(b, p) === null
    })
    cands = legal.length > 0 ? legal : cands
  }

  if (cands.length === 0) {
    // 兜底：扫描全盘空点（理论上不会走到）
    cands = candidatePoints(state, () => true)
  }
  if (cands.length === 0) {
    throw new Error('AI 开局决策：无合法落子点')
  }

  // 对每个候选做快速评估 + 浅搜，取最优
  const board = state.board.slice() as Board
  let best = cands[0]
  let bestScore = -Infinity
  for (const p of cands) {
    board[idx(p.x, p.y)] = color
    let sc: number
    if (color === 1) {
      sc = evalBlack(board)
    } else {
      sc = -evalBlack(board)
    }
    board[idx(p.x, p.y)] = 0
    if (opts.noise > 0) sc += (Math.random() - 0.5) * opts.noise * 400
    if (sc > bestScore) {
      bestScore = sc
      best = p
    }
  }
  const side = color === 1 ? '黑' : '白'
  return {
    event: { type: 'move', pos: best },
    reason: `AI（${side}）评估各候选点后选择此处（评分 ${Math.round(bestScore)}）`,
    report: { engine: 'static-eval', score: bestScore }
  }
}

/** 交换决策：行使交换权的 AI 视自身当前执子色决定是否交换 */
function swapDecision(state: GameState, level: AiLevel, aiPlayer: 0 | 1): AiDecision {
  const opts = openLevel(level)
  const score = evalBlack(state.board) // 黑视角（正 = 黑优）
  const jitter = opts.noise > 0 ? (Math.random() - 0.5) * opts.noise * 600 : 0
  const aiIsBlack = state.blackOwner === aiPlayer
  // 白方：黑优则交换（接管黑棋）；黑方：白优则交换（让出黑棋、改执白）
  const accept = aiIsBlack ? score + jitter < 0 : score + jitter > 0
  const side = accept
    ? aiIsBlack
      ? '交换执白'
      : '交换执黑'
    : aiIsBlack
      ? '保持执黑'
      : '保持执白'
  return {
    event: { type: 'swap', accept },
    reason: `局面评分 ${score > 0 ? '+' : ''}${Math.round(score)}（${score > 0 ? '偏黑' : '偏白'}），AI 选择${side}`,
    report: { engine: 'static-eval', score }
  }
}

/** 走法一/二选择 */
function variantDecision(state: GameState, level: AiLevel): AiDecision {
  const opts = openLevel(level)
  const board = state.board.slice() as Board
  // 候选第 5 手：9×9 区域内空点（距棋子 ≤3）
  const cands = candidatePoints(state, (p) => withinCentral(p, 4)).filter((p) => {
    for (const q of state.moves) {
      if (Math.abs(q.x - p.x) <= 3 && Math.abs(q.y - p.y) <= 3) return true
    }
    return false
  })
  const scored = cands
    .map((p) => {
      board[idx(p.x, p.y)] = 1
      const v = evalBlack(board)
      board[idx(p.x, p.y)] = 0
      return { p, v }
    })
    .sort((a, b) => b.v - a.v)

  if (scored.length === 0) {
    return {
      event: { type: 'variant', variant: 1 },
      reason: '无候选点，默认走法一',
      report: { engine: 'static-eval' }
    }
  }

  // 走法一：黑方所得 ≈ -|E_best|（对方交换后必占优势方）
  const eBest = scored[0].v
  const v1 = -Math.abs(eBest)
  // 走法二：取评估最高的 10 个点（跳过中心对称对），黑方所得 = 其中最差评估
  const chosenEntries: Array<{ p: Pos; v: number }> = []
  for (const s of scored) {
    if (chosenEntries.length >= 10) break
    if (chosenEntries.some((q) => isCenterSymmetric(q.p, s.p))) continue
    chosenEntries.push(s)
  }
  const v2 =
    chosenEntries.length >= 10 ? Math.min(...chosenEntries.map((e) => e.v)) : -Infinity
  const jitter = opts.noise > 0 ? (Math.random() - 0.5) * opts.noise * 400 : 0
  const useV2 = v2 + jitter > v1
  return {
    event: { type: 'variant', variant: useV2 ? 2 : 1 },
    reason: useV2
      ? `走法一保障值 ${Math.round(v1)}，走法二保障值 ${Math.round(v2)} → 选择走法二（十打点报价）`
      : `走法一保障值 ${Math.round(v1)}，走法二保障值 ${Math.round(v2)} → 选择走法一（直接落子）`,
    report: {
      engine: 'static-eval',
      extra: { '走法一保障值': Math.round(v1), '走法二保障值': Math.round(v2) }
    }
  }
}

/** 十打点：取评估最高的 10 个点（跳过中心对称对与已占用点） */
function offersDecision(state: GameState, level: AiLevel): AiDecision {
  const opts = openLevel(level)
  const board = state.board.slice() as Board
  const cands = candidatePoints(state, () => true).filter((p) => {
    for (const q of state.moves) {
      if (Math.abs(q.x - p.x) <= 4 && Math.abs(q.y - p.y) <= 4) return true
    }
    return false
  })
  const scored = cands
    .map((p) => {
      board[idx(p.x, p.y)] = 1
      const v = evalBlack(board)
      board[idx(p.x, p.y)] = 0
      return { p, v }
    })
    .sort((a, b) => b.v - a.v)

  const chosen: Pos[] = []
  for (const s of scored) {
    if (chosen.length >= 10) break
    if (chosen.some((q) => isCenterSymmetric(q, s.p))) continue
    chosen.push(s.p)
  }
  // 兜底：候选不足 10 时从远处补点（保证数量与不对称）
  let x = 0
  let y = 0
  while (chosen.length < 10) {
    const p = { x, y }
    const occ = state.board[idx(x, y)] !== 0
    if (!occ && !chosen.some((q) => isCenterSymmetric(q, p)) && !chosen.some((q) => q.x === p.x && q.y === p.y)) {
      chosen.push(p)
    }
    x++
    if (x >= 15) {
      x = 0
      y++
    }
    if (y >= 15) break
  }
  if (opts.noise > 0) {
    for (let i = chosen.length - 1; i > 0; i--) {
      if (Math.random() < opts.noise) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[chosen[i], chosen[j]] = [chosen[j], chosen[i]]
      }
    }
  }
  return {
    event: { type: 'offers', points: chosen },
    reason: `AI 摆出 10 个第 5 手候选点（按黑方评估排序）`,
    report: { engine: 'static-eval' }
  }
}

/** 十选一：白方选对黑最不利的打点 */
function pickDecision(state: GameState, level: AiLevel): AiDecision {
  const board = state.board.slice() as Board
  let bestIdx = 0
  let bestVal = Infinity
  state.offers.forEach((p, i) => {
    board[idx(p.x, p.y)] = 1
    const v = evalBlack(board) // 黑视角，白方取最小
    board[idx(p.x, p.y)] = 0
    if (v < bestVal) {
      bestVal = v
      bestIdx = i
    }
  })
  const p = state.offers[bestIdx]
  return {
    event: { type: 'pick', index: bestIdx },
    reason: `白方选择对黑方最不利的打点（黑视角评分 ${Math.round(bestVal)}，位置 ${p.x + 1},${p.y + 1}）`,
    report: { engine: 'static-eval', score: bestVal }
  }
}

/** 主入口：根据当前局面给出 AI 决策事件。onProgress 仅在 Negamax 中盘搜索时回调（用于 UI 实时展示）。 */
export function decideAiAction(
  state: GameState,
  level: AiLevel,
  onProgress?: ProgressHandler
): AiDecision {
  const start = Date.now()
  const actor = currentActor(state)
  if (!actor) throw new Error('对局已结束，无需 AI 决策')
  // 开局库优先：命中则直接采用推荐决策
  const book = lookupOpeningBook(state)
  if (book) {
    return {
      event: book.event,
      reason: book.reason,
      report: { engine: 'book', elapsedMs: Date.now() - start }
    }
  }
  let d: AiDecision
  switch (actor.kind) {
    case 'move': {
      if (state.phase === 'PLAY') {
        const color: Color = state.moves.length % 2 === 0 ? 1 : 2
        const base = LEVELS[level]
        const opts = { ...base, timeMs: dynamicTimeMs(state.board, color, base.timeMs) }
        const r = searchBestMove(state.board, color, opts, onProgress)
        if (!r.move) throw new Error('AI 找不到可落子点')
        d = {
          event: { type: 'move', pos: r.move },
          reason: `AI（${color === 1 ? '黑' : '白'}）搜索深度 ${r.depth}，评分 ${Math.round(r.score)}`,
          report: {
            engine: 'negamax',
            score: r.score,
            depth: r.depth,
            nodes: r.nodes,
            timedOut: r.timedOut
          }
        }
      } else {
        d = openingMove(state, level)
      }
      break
    }
    case 'swap':
      d = swapDecision(state, level, actor.player)
      break
    case 'variant':
      d = variantDecision(state, level)
      break
    case 'offers':
      d = offersDecision(state, level)
      break
    case 'pick':
      d = pickDecision(state, level)
      break
    default:
      throw new Error('未知决策类型')
  }
  // 统一计时：思考耗时 = 决策入口到返回的墙钟时间
  if (d.report) d.report.elapsedMs = Date.now() - start
  return d
}

/** 决策可行性自检（测试用）：确认返回事件可被 FSM 接受 */
export function tryDecision(state: GameState, level: AiLevel): { ok: boolean; error?: string; decision?: AiDecision } {
  const d = decideAiAction(state, level)
  const r = applyEvent(state, d.event)
  return { ok: r.result.ok, error: r.result.error, decision: d }
}
