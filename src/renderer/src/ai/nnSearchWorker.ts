/**
 * NN 搜索子 Worker：根并行 MCTS 的执行单元。
 * 主 AI Worker 派出 K 个本 Worker，各自独立加载 ONNX 会话、独立建树；
 * 根先验施加种子化 Dirichlet 噪声保证各树不同，结果回传根访问明细，
 * 由主 Worker 汇总（combineMctsResults）。
 */
import { mctsSearch } from '@shared/ai/mcts'
import type { MctsResult, MctsNetResult } from '@shared/ai/mcts'
import { encodeNnState } from '@shared/ai/nn'
import type { Board, Color } from '@shared/types'
import type { InferenceSession } from 'onnxruntime-web'
import modelUrl from './model.onnx?url'

export interface NnSearchRequest {
  id: number
  board: Board
  color: Color
  /** 选点时的已落子数（禁手生效标志按 训练口径 moves≥5 计算） */
  movesCount: number
  timeMs: number
  sims: number
  cpuct?: number
  noise?: { eps: number; alpha: number; seed: number }
}

export interface NnSearchResponse {
  id: number
  ok: boolean
  result?: MctsResult
  error?: string
}

let sessionPromise: Promise<InferenceSession | null> | null = null

function getSession(): Promise<InferenceSession | null> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const ort = await import('onnxruntime-web')
        // 与主 Worker 一致：本地 wasm + 多线程（隔离头由主进程注入）
        ort.env.wasm.wasmPaths = '/ort/'
        try {
          const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
          ort.env.wasm.numThreads = Math.max(1, Math.min(4, cores - 1))
        } catch {
          /* 环境不支持则保持默认 */
        }
        const sess = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] })
        return sess
      } catch (err) {
        console.warn('[nn-sub] 模型加载失败：', err)
        return null
      }
    })()
  }
  return sessionPromise
}

self.onmessage = async (e: MessageEvent<NnSearchRequest>) => {
  const req = e.data
  try {
    const sess = await getSession()
    if (!sess) throw new Error('模型不可用')
    const ort = await import('onnxruntime-web')
    const net = async (board: Board, color: Color, ply: number): Promise<MctsNetResult> => {
      const forbiddenActive = color === 1 && req.movesCount + ply >= 5
      const enc = encodeNnState(board, color, forbiddenActive)
      const out = await sess.run({ input: new ort.Tensor('float32', enc, [1, 4, 15, 15]) })
      return {
        policy: out.policy.data as Float32Array,
        value: (out.value.data as Float32Array)[0]
      }
    }
    const result = await mctsSearch(
      req.board,
      req.color,
      { sims: req.sims, deadline: Date.now() + req.timeMs, cpuct: req.cpuct, rootNoise: req.noise },
      net
    )
    const resp: NnSearchResponse = { id: req.id, ok: true, result: result ?? undefined }
    self.postMessage(resp)
  } catch (err) {
    const resp: NnSearchResponse = { id: req.id, ok: false, error: String(err) }
    self.postMessage(resp)
  }
}
