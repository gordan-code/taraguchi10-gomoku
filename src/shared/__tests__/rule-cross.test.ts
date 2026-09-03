import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Color, Pos, Stone, idx } from '../types'
import { emptyBoard, runLength } from '../board'
import { checkForbidden } from '../forbidden'

const __dirname = dirname(fileURLToPath(import.meta.url))
const jsonPath = resolve(__dirname, '../../../../AlphaZero-Gomoku/games/renju/renju_test_cases.json')

interface TestCase {
  id: string
  type: 'forbidden' | 'win'
  desc: string
  stones: Array<[number, number, Stone]>
  move: [number, number]
  move_color: 1 | 2
  expect: string
}

const data = JSON.parse(readFileSync(jsonPath, 'utf-8')) as { size: number; cases: TestCase[] }

/** JSON 坐标为 [row, col]，TS 内部为 (x=col, y=row)。禁手规则对棋盘转置不变，故结果一致。 */
function runCase(c: TestCase): string {
  const b = emptyBoard()
  for (const [r, col, s] of c.stones) b[idx(col, r)] = s

  const [r, col] = c.move
  if (c.type === 'forbidden') {
    if (c.move_color !== 1) return 'legal' // 白方无禁手
    b[idx(col, r)] = 1
    const kind = checkForbidden(b, { x: col, y: r })
    return kind ?? 'legal'
  }

  // type === 'win'
  b[idx(col, r)] = c.move_color
  const p: Pos = { x: col, y: r }
  const len = runLength(b, p, c.move_color as Color)
  if (c.move_color === 1) {
    if (len === 5) return 'black-five'
    if (len >= 6) return 'black-over'
    return 'none'
  }
  if (len === 5) return 'white-five'
  if (len >= 6) return 'white-overline'
  return 'none'
}

describe('规则跨语言交叉验证（TS 侧，与 Python 共享同一 JSON）', () => {
  it('用例数量 >= 30', () => {
    expect(data.cases.length).toBeGreaterThanOrEqual(30)
  })

  it('每个棋形输出与 JSON expect 一致', () => {
    for (const c of data.cases) {
      expect(runCase(c), `${c.id}（${c.desc}）`).toBe(c.expect)
    }
  })
})
