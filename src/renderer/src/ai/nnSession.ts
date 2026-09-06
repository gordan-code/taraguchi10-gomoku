/**
 * 神经网络会话（Electron 渲染进程 Worker 内运行）：
 * 懒加载 onnxruntime-web + 已导出的 ONNX 模型，中盘（PLAY）用策略网络选点。
 * 任何加载/推理失败都返回 null，由 worker.ts 回退到现有 Negamax，保证对局永不卡死。
 */
import type { InferenceSession } from 'onnxruntime-web'
import { encodeNnState, pickMoveFromPolicy } from '@shared/ai/nn'
import { mctsSearch } from '@shared/ai/mcts'
import { GameState } from '@shared/fsm'
import { Color, Pos } from '@shared/types'
import { AiReport } from '@shared/ai/report'
import modelUrl from './model.onnx?url'

let sessionPromise: Promise<InferenceSession | null> | null = null

async function loadSession(): Promise<InferenceSession | null> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const ort = await import('onnxruntime-web')
        // onnxruntime-web 的 wasm 二进制默认在 Electron app:// 下解析不到，
        // 这里显式指向 CDN。离线部署时改为本地打包的 wasm 路径即可。
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/'
        console.log('[nn] 正在加载模型:', modelUrl)
        const sess = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] })
        console.log('[nn] ONNX 模型加载成功:', modelUrl)
        return sess
      } catch (err) {
        console.warn('[nn] ONNX 模型加载失败，中盘回退 Negamax：', err)
        return null
      }
    })()
  }
  return sessionPromise
}

/** 把 onnxruntime 会话包装成 MCTS 的 net 接口（forbiddenActive 随 ply 递增对齐训练口径） */
async function makeMctsNet(
  state: GameState
): Promise<((board: import('@shared/types').Board, color: Color, ply: number) => Promise<{ policy: Float32Array; value: number }>) | null> {
  const sess = await loadSession()
  if (!sess) return null
  const ort = await import('onnxruntime-web')
  return async (board, color, ply) => {
    const forbiddenActive = color === 1 && state.moves.length + ply >= 5
    const enc = encodeNnState(board, color, forbiddenActive)
    const out = await sess.run({ input: new ort.Tensor('float32', enc, [1, 4, 15, 15]) })
    return {
      policy: out.policy.data as Float32Array,
      value: (out.value.data as Float32Array)[0]
    }
  }
}

export interface NnMctsOptions {
  /** 搜索时间预算（毫秒） */
  timeMs: number
  /** 模拟次数上限 */
  sims: number
}

/** 中盘（PLAY）用 策略先验 + 价值 的 PUCT MCTS 选点；模型不可用/失败返回 null。 */
export async function nnMctsPickMove(state: GameState, opts: NnMctsOptions): Promise<NnMoveResult | null> {
  const net = await makeMctsNet(state)
  if (!net) return null
  try {
    const myColor: Color = state.moves.length % 2 === 0 ? 1 : 2
    const t0 = Date.now()
    const r = await mctsSearch(
      state.board,
      myColor,
      { sims: opts.sims, deadline: Date.now() + opts.timeMs },
      net
    )
    if (!r) return null
    const elapsedMs = Date.now() - t0
    const side = myColor === 1 ? '黑' : '白'
    const qText = (r.q >= 0 ? '+' : '') + r.q.toFixed(2)
    const topText = r.top.map((t) => `${t.pos.x + 1},${t.pos.y + 1}(${t.n})`).join(' ')
    return {
      pos: r.pos,
      reason: `神经网络+MCTS（${side}）根价值 ${qText}，${r.sims} 次模拟 / 树深 ${r.depth}，主变访问 ${topText}`,
      report: {
        engine: 'neural',
        score: myColor === 1 ? r.q : -r.q, // 统一为黑方视角
        depth: r.depth,
        nodes: r.sims,
        extra: {
          引擎: 'NN+MCTS',
          模拟次数: r.sims,
          树深: r.depth,
          根价值: Number(r.q.toFixed(3))
        }
      }
    }
  } catch (err) {
    console.warn('[nn] MCTS 搜索失败，回退单次策略：', err)
    return null
  }
}

export interface NnMoveResult {
  pos: Pos
  reason: string
  report: AiReport
}

/** 中盘（PLAY）用神经网络选点；模型不可用/推理失败返回 null。 */
export async function nnPickPlayMove(state: GameState): Promise<NnMoveResult | null> {
  const sess = await loadSession()
  if (!sess) return null
  try {
    const myColor: Color = state.moves.length % 2 === 0 ? 1 : 2
    const forbiddenActive = myColor === 1 && state.moves.length >= 5
    const enc = encodeNnState(state.board, myColor, forbiddenActive)

    const ort = await import('onnxruntime-web')
    const feeds = { input: new ort.Tensor('float32', enc, [1, 4, 15, 15]) }
    const out = await sess.run(feeds)
    const policy = out.policy.data as Float32Array
    const value = (out.value.data as Float32Array)[0]

    const r = pickMoveFromPolicy(policy, state.board, myColor)
    if (!r) return null

    // 选中点在策略分布中的占比（对全部 229 维 logits 做 softmax）
    let maxLogit = -Infinity
    for (let i = 0; i < policy.length; i++) {
      if (policy[i] > maxLogit) maxLogit = policy[i]
    }
    let sumExp = 0
    for (let i = 0; i < policy.length; i++) sumExp += Math.exp(policy[i] - maxLogit)
    const pickProb = Math.exp(r.logit - maxLogit) / sumExp

    const score = myColor === 1 ? value : -value // 统一为黑方视角
    const side = myColor === 1 ? '黑' : '白'
    return {
      pos: r.pos,
      reason: `神经网络（${side}）估值 ${score >= 0 ? '+' : ''}${score.toFixed(2)}，选中位置 ${r.pos.x + 1},${r.pos.y + 1}`,
      report: {
        engine: 'neural',
        score,
        extra: { 网络估值: Number(score.toFixed(3)), 选中概率: Number((pickProb * 100).toFixed(1)) }
      }
    }
  } catch (err) {
    console.warn('[nn] 推理失败，回退 Negamax：', err)
    return null
  }
}
