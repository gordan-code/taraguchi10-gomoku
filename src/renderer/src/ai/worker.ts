import { AiEngine, AiLevel, Color } from '@shared/types'
import { GameEvent, GameState, currentActor } from '@shared/fsm'
import { decideAiAction } from '@shared/ai/opening'
import type { AiDecision } from '@shared/ai/opening'
import { AiReport } from '@shared/ai/report'
import { LEVELS, dynamicTimeMs, probeForcedWin } from '@shared/ai/engine'
import type { SearchProgress } from '@shared/ai/engine'
import { nnMctsPickMove, nnPickPlayMove } from './nnSession'
import { lookupBookMove } from '@shared/ai/book'
import { assessTactics } from '@shared/ai/tactics'
import { wasmSearchBestMove } from './wasmEngine'

export interface AiRequest {
  id: number
  state: GameState
  level: AiLevel
  engine: AiEngine
  threads: number
}

export type AiResponse =
  | { id: number; ok: true; event: GameEvent; reason: string; report?: AiReport }
  | { id: number; ok: false; error: string }

/** Negamax 搜索过程中的实时进度（供 UI 动态展示，非最终结果） */
export type AiProgress = { id: number; type: 'progress'; report: AiReport }

const MATE = 1_000_000

/**
 * master 档中盘落子：Rust/WASM 搜索内核。
 * 流程：TS 侧 VCT 必胜预探（毫秒级）→ WASM Negamax（同时间约多 3~5 层）→ 失败抛错由调用方回退 TS。
 */
async function wasmPlayMove(state: GameState): Promise<AiDecision> {
  const color: Color = state.moves.length % 2 === 0 ? 1 : 2
  const base = LEVELS.master
  const opts = { ...base, maxDepth: 14, timeMs: dynamicTimeMs(state.board, color, base.timeMs) }

  // 1. 必胜探测（VCT/VCF 威胁空间搜索，TS 侧毫秒级）
  const vct = probeForcedWin(state.board, color)
  if (vct >= 0) {
    return {
      event: { type: 'move', pos: { x: vct % 15, y: Math.floor(vct / 15) } },
      reason: `AI（${color === 1 ? '黑' : '白'}）必胜（威胁空间搜索）`,
      report: {
        engine: 'negamax',
        score: MATE - 1,
        depth: 1,
        nodes: 0,
        timedOut: false,
        extra: { 引擎: 'Rust/WASM + VCT' }
      }
    }
  }

  // 2. Rust/WASM Negamax
  const r = await wasmSearchBestMove(state.board, color, opts)
  if (r && r.move) {
    return {
      event: { type: 'move', pos: r.move },
      reason: `AI（${color === 1 ? '黑' : '白'}）搜索深度 ${r.depth}（威胁线 ${r.seldepth}），评分 ${Math.round(r.score)}`,
      report: {
        engine: 'negamax',
        score: r.score,
        depth: r.depth,
        nodes: r.nodes,
        timedOut: r.timedOut,
        extra: { 引擎: 'Rust/WASM', 威胁线深度: r.seldepth }
      }
    }
  }

  throw new Error('WASM 内核不可用')
}

self.onmessage = async (e: MessageEvent<AiRequest>) => {
  const req = e.data
  try {
    const actor = currentActor(req.state)

    // 开局库：中盘前 6 手命中直接落子（毫秒级），双引擎通用，失败静默回退
    if (actor && actor.kind === 'move' && req.state.phase === 'PLAY') {
      const bookPos = lookupBookMove(req.state)
      if (bookPos) {
        const resp: AiResponse = {
          id: req.id,
          ok: true,
          event: { type: 'move', pos: bookPos },
          reason: `开局库命中（第 ${req.state.moves.length + 1} 手）`,
          report: { engine: 'book', extra: { 引擎: '开局库' } }
        }
        self.postMessage(resp)
        return
      }
    }

    // 中盘落子（engine=onnx）：战术分流 + NN+MCTS
    // 混合策略：安静局面交给 NN（位置感强）；出现活四类威胁时切换搜索内核
    // 全力防守（战术可靠，实战败局回归测试验证）。NN 失败回退单次策略。
    if (req.engine !== 'negamax' && actor && actor.kind === 'move' && req.state.phase === 'PLAY') {
      const t0 = Date.now()
      const color: Color = req.state.moves.length % 2 === 0 ? 1 : 2
      const timeMs = Math.min(3000, Math.max(800, dynamicTimeMs(req.state.board, color, 2000)))

      const tac = assessTactics(req.state.board, color)

      // 我方活四制胜点：立即落子
      if (tac.urgentWin) {
        const resp: AiResponse = {
          id: req.id,
          ok: true,
          event: { type: 'move', pos: tac.urgentWin },
          reason: 'AI 发现活四制胜点，直接落子',
          report: { engine: 'negamax', score: 999999, depth: 1, elapsedMs: Date.now() - t0, extra: { 引擎: '战术分流' } }
        }
        self.postMessage(resp)
        return
      }

      // 对手活四威胁：切换搜索内核全力防守
      if (tac.mustBlockPoints.length > 0) {
        const kr = await wasmSearchBestMove(req.state.board, color, {
          ...LEVELS.master,
          maxDepth: 14,
          timeMs
        }).catch(() => null)
        if (kr && kr.move) {
          const resp: AiResponse = {
            id: req.id,
            ok: true,
            event: { type: 'move', pos: kr.move },
            reason: `对手活四威胁，切换内核防守：深度 ${kr.depth}，评分 ${Math.round(kr.score)}`,
            report: {
              engine: 'negamax',
              score: kr.score,
              depth: kr.depth,
              nodes: kr.nodes,
              timedOut: kr.timedOut,
              elapsedMs: Date.now() - t0,
              extra: { 引擎: '战术分流·内核防守', 威胁点数: tac.mustBlockPoints.length }
            }
          }
          self.postMessage(resp)
          return
        }
        console.warn('[nn] 内核防守失败，回退 NN+MCTS')
      }

      // 安静局面：NN+MCTS（单树为默认：根并行经对打实测不优于单树）
      const nn = (await nnMctsPickMove(req.state, { timeMs, sims: 384 }).catch(() => null)) ?? (await nnPickPlayMove(req.state))
      if (nn) {
        // NN 路径不走 decideAiAction 的统一计时，这里单独记录耗时
        nn.report.elapsedMs = Date.now() - t0
        const resp: AiResponse = {
          id: req.id,
          ok: true,
          event: { type: 'move', pos: nn.pos },
          reason: nn.reason,
          report: nn.report
        }
        self.postMessage(resp)
        return
      }
    }

    // Negamax 搜索进度实时回传（深度/评分/节点/用时）
    const onProgress = (p: SearchProgress) => {
      const msg: AiProgress = {
        id: req.id,
        type: 'progress',
        report: { engine: 'negamax', score: p.score, depth: p.depth, nodes: p.nodes, elapsedMs: p.elapsedMs }
      }
      self.postMessage(msg)
    }

    // 中盘落子：Rust/WASM 搜索内核（VCT 预探 + WASM Negamax，失败回退 TS）
    if (req.engine === 'negamax' && actor && actor.kind === 'move' && req.state.phase === 'PLAY') {
      try {
        const d = await wasmPlayMove(req.state)
        const resp: AiResponse = { id: req.id, ok: true, event: d.event, reason: d.reason, report: d.report }
        self.postMessage(resp)
        return
      } catch (err) {
        console.warn('[wasm] 搜索失败，回退 TS Negamax：', err)
      }
    }

    const d = decideAiAction(req.state, req.level, onProgress)
    const resp: AiResponse = { id: req.id, ok: true, event: d.event, reason: d.reason, report: d.report }
    self.postMessage(resp)
  } catch (err) {
    const resp: AiResponse = { id: req.id, ok: false, error: String(err) }
    self.postMessage(resp)
  }
}
