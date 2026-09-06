/**
 * 根并行 MCTS 汇总逻辑单测（纯函数，不依赖 onnxruntime）。
 */
import { describe, expect, it } from 'vitest'
import { combineMctsResults } from '../ai/mcts'
import type { MctsResult } from '../ai/mcts'

function fakeResult(visits: Array<[number, number, number]>, sims: number, depth: number): MctsResult {
  const vs = visits.map(([i, n, q]) => ({ i, n, q }))
  const best = vs.reduce((a, b) => (b.n > a.n ? b : a), vs[0])
  return {
    pos: { x: best.i % 15, y: Math.floor(best.i / 15) },
    q: best.q,
    sims,
    depth,
    top: vs
      .slice()
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((v) => ({ pos: { x: v.i % 15, y: Math.floor(v.i / 15) }, n: v.n })),
    visits: vs
  }
}

describe('combineMctsResults（根并行汇总）', () => {
  it('跨树访问次数求和，选总和最大的着法', () => {
    // 树1 偏好 100，树2 偏好 40 → 汇总 40+60=100 vs 100+20=120 → 选 40
    const r = combineMctsResults([
      fakeResult([[100, 60, 0.2], [40, 40, 0.3]], 100, 8),
      fakeResult([[100, 20, 0.1], [40, 60, 0.4]], 80, 9)
    ])
    expect(r).toBeTruthy()
    expect(r!.pos).toEqual({ x: 40 % 15, y: Math.floor(40 / 15) })
    expect(r!.sims).toBe(180)
    expect(r!.depth).toBe(9)
  })

  it('汇总价值 = 各树价值的加权平均', () => {
    // 100: 树1 n=60 q=0.2，树2 n=20 q=0.1 → (60*0.2+20*0.1)/80 = 0.175
    const r = combineMctsResults([
      fakeResult([[100, 60, 0.2]], 60, 5),
      fakeResult([[100, 20, 0.1]], 20, 5)
    ])
    expect(Math.abs(r!.q - 0.175)).toBeLessThan(1e-9)
  })

  it('全部失败返回 null；单树直接透传', () => {
    expect(combineMctsResults([null, null])).toBeNull()
    const one = fakeResult([[5, 10, 0.5]], 10, 3)
    expect(combineMctsResults([one, null])).toBe(one)
  })
})
