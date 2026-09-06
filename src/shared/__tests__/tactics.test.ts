/**
 * 战术危机评估单测：用 2026-09-06 实战败局的局面验证
 * 活四类威胁的识别（该局 AI 因漏防此威胁而输棋）。
 */
import { describe, expect, it } from 'vitest'
import { assessTactics } from '../ai/tactics'
import { emptyBoard } from '../board'
import { idx } from '../types'

const RECORD: Array<[string, 1 | 2]> = [
  ['H8', 1], ['I9', 2], ['G9', 1], ['I7', 2], ['D12', 1],
  ['I8', 2], ['E11', 1], ['F10', 2], ['I5', 1], ['I6', 2],
  ['I10', 1], ['H9', 2], ['F8', 1], ['K6', 2]
]

function posOf(name: string): { x: number; y: number } {
  return { x: name.charCodeAt(0) - 65, y: 15 - Number(name.slice(1)) }
}

/** 实战第 14 手后的局面（黑方行棋，白有 H9-I8-K6 跳三） */
function failingPosition() {
  const b = emptyBoard()
  for (const [name, color] of RECORD) {
    const p = posOf(name)
    b[idx(p.x, p.y)] = color
  }
  return b
}

describe('战术危机评估', () => {
  it('实战败局局面：识别出对手活四类威胁（J7 在防守点中）', () => {
    const tac = assessTactics(failingPosition(), 1)
    expect(tac.urgentWin).toBeNull() // 黑无活四制胜点
    const names = tac.mustBlockPoints.map((p) => String.fromCharCode(65 + p.x) + (15 - p.y))
    expect(names).toContain('J7') // 白 J7 成四后有两处成五点 → 活四类
  })

  it('我方活四制胜点：直接识别为必胜', () => {
    // 黑 (7,7)(8,8)(9,9)(10,10) 四连，两端开放 → (6,6)/(11,11) 均为活四点
    const b = emptyBoard()
    for (const [x, y] of [[7, 7], [8, 8], [9, 9], [10, 10]]) b[idx(x, y)] = 1
    b[idx(3, 3)] = 2
    b[idx(4, 3)] = 2
    const tac = assessTactics(b, 1)
    expect(tac.urgentWin).toBeTruthy()
    const p = tac.urgentWin!
    expect([[6, 6], [11, 11]]).toContainEqual([p.x, p.y])
    expect(tac.mustBlockPoints.length).toBe(0) // 有必胜点时不再考虑防守
  })

  it('对手已有活四（双成五点被占其一仍为威胁）时要求防守', () => {
    // 白 (5,5)(6,5)(7,5)(8,5) 四连，(4,5) 被黑占 → (9,5) 是唯一成五点
    // 该四本身已成 —— 白的成四点检测覆盖这类（落 (9,5) 即成五）
    const b = emptyBoard()
    for (const [x, y] of [[5, 5], [6, 5], [7, 5], [8, 5]]) b[idx(x, y)] = 2
    b[idx(4, 5)] = 1
    b[idx(5, 6)] = 1
    b[idx(6, 6)] = 1
    const tac = assessTactics(b, 1)
    const names = tac.mustBlockPoints.map((p) => String.fromCharCode(65 + p.x) + (15 - p.y))
    // 唯一成五点 (9,5) 必须在防守点中
    expect(tac.mustBlockPoints).toContainEqual({ x: 9, y: 5 })
  })

  it('安静局面（无三连威胁）不触发分流', () => {
    const b = emptyBoard()
    // 间隔散子，无任何三连
    for (const [x, y, c] of [[2, 2, 1], [8, 3, 2], [12, 6, 1], [4, 10, 2], [10, 12, 1]]) {
      b[idx(x, y)] = c as 1 | 2
    }
    const tac = assessTactics(b, 1)
    expect(tac.urgentWin).toBeNull()
    expect(tac.mustBlockPoints.length).toBe(0)
  })
})

describe('第二盘实战败局回归（2026-09-06 23:44，白 G5-I7-H6 活三未被堵）', () => {
  const RECORD2: Array<[string, 1 | 2]> = [
    ['H8', 1], ['I8', 2], ['G9', 1], ['I7', 2], ['D12', 1],
    ['I9', 2], ['I10', 1], ['H7', 2], ['E11', 1], ['F10', 2],
    ['I5', 1], ['K10', 2], ['J9', 1], ['J7', 2], ['K7', 1],
    ['H6', 2], ['H11', 1], ['K8', 2], ['F13', 1], ['G12', 2],
    ['E13', 1], ['M10', 2], ['L9', 1], ['G5', 2]
  ]

  function posOf(name: string) {
    return { x: name.charCodeAt(0) - 65, y: 15 - Number(name.slice(1)) }
  }

  it('第 24 手后：白 G5-I7-H6 活三应触发战术分流（识别 F4/J8 防守点）', () => {
    const b = emptyBoard()
    for (const [name, color] of RECORD2 as Array<[string, 1 | 2]>) {
      const p = posOf(name)
      b[idx(p.x, p.y)] = color
    }
    // 黑第 25 手行棋
    const tac = assessTactics(b, 1)
    expect(tac.urgentWin).toBeNull()
    const names = tac.mustBlockPoints.map((p) => String.fromCharCode(65 + p.x) + (15 - p.y))
    // 白方成四点 F4 与 J8 都会形成活四类（两个成五点）
    expect(names).toContain('F4')
    expect(names).toContain('J8')
  })

  it('第 26 手后：白 F4 成四（E3/J8 双五点）仍应触发内核防守', () => {
    const RECORD3 = [...RECORD2, ['F4', 2]]
    const b = emptyBoard()
    for (const [name, color] of RECORD3 as Array<[string, 1 | 2]>) {
      const p = posOf(name)
      b[idx(p.x, p.y)] = color
    }
    const tac = assessTactics(b, 1)
    const names = tac.mustBlockPoints.map((p) => String.fromCharCode(65 + p.x) + (15 - p.y))
    expect(names).toContain('E3')
    expect(names).toContain('J8')
  })
})
