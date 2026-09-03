import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { encodeNnState, pickMoveFromPolicy, NN_POS } from '../ai/nn'
import { Board } from '../types'

// 端到端：真实加载 ONNX 模型 → 编码 → 推理 → 选合法落子。
// 无模型时自动跳过（模型由 Python 侧 export_onnx.py 产出）。
const MODEL_PATH =
  process.env.RENJU_ONNX ?? 'D:/Develop/AlphaZero-Gomoku/models_renju/model.onnx'

/** 一个中盘局面（黑 1 / 白 2，中心附近几手棋） */
function sampleBoard(): Board {
  const b = new Array(NN_POS).fill(0) as Board
  const put = (x: number, y: number, c: 1 | 2) => {
    b[y * 15 + x] = c
  }
  put(7, 7, 1)
  put(8, 7, 2)
  put(8, 8, 1)
  put(7, 8, 2)
  put(6, 7, 1)
  put(6, 6, 2)
  put(9, 9, 1)
  put(5, 5, 2)
  put(7, 6, 1)
  put(6, 8, 2)
  return b
}

describe('NN 端到端（需 ONNX 模型）', () => {
  it('加载 ONNX 并给出合法落子', async () => {
    if (!existsSync(MODEL_PATH)) {
      console.warn('[skip] 未找到 ONNX 模型:', MODEL_PATH)
      return
    }
    const ort = await import('onnxruntime-node')
    const sess = await ort.InferenceSession.create(MODEL_PATH)

    const board = sampleBoard()
    const myColor = 1 // 黑方
    const enc = encodeNnState(board, myColor, true)
    const feeds = { input: new ort.Tensor('float32', enc, [1, 4, 15, 15]) }
    const out = await sess.run(feeds)

    const policy = out.policy.data as Float32Array
    expect(policy.length).toBe(229)

    const r = pickMoveFromPolicy(policy, board, myColor)
    expect(r).not.toBeNull()
    expect(board[r!.index]).toBe(0) // 必须落在空点
    console.log(
      `NN 落子: (${r!.pos.x},${r!.pos.y}) index=${r!.index} logit=${r!.logit.toFixed(3)}`
    )

    // 白方视角也能跑通
    const encW = encodeNnState(board, 2, false)
    const outW = await sess.run({ input: new ort.Tensor('float32', encW, [1, 4, 15, 15]) })
    const rW = pickMoveFromPolicy(outW.policy.data as Float32Array, board, 2)
    expect(rW).not.toBeNull()
    console.log(`白方落子: (${rW!.pos.x},${rW!.pos.y}) index=${rW!.index}`)
  })
})
