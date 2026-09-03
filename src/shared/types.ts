/** 共享类型定义：渲染进程、AI Worker 与测试共用 */

export const SIZE = 15

/** 棋子：0 空 / 1 黑 / 2 白 */
export type Stone = 0 | 1 | 2
export type Color = 1 | 2

export interface Pos {
  x: number // 列 0..14（a..o）
  y: number // 行 0..14（从上往下）
}

export const CENTER: Pos = { x: 7, y: 7 }

/** 棋盘：长度 225 的一维数组，index = y * 15 + x */
export type Board = Stone[]

export const idx = (x: number, y: number): number => y * SIZE + x
export const inBounds = (x: number, y: number): boolean =>
  x >= 0 && x < SIZE && y >= 0 && y < SIZE
export const posEq = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y
export const samePos = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y

/** 坐标名：大写字母=横轴（列 a..o 从左到右），数字=纵轴（行 1..15 从下往上）。天元 → "H8" */
export const posName = (p: Pos): string =>
  String.fromCharCode(65 + p.x) + String(15 - p.y)

/** 紧凑局面代码用的小写坐标：天元 → "h8"，代码即逐手拼接（如 "h8i9i10"） */
export const posCode = (p: Pos): string =>
  String.fromCharCode(97 + p.x) + String(15 - p.y)

/** 解析坐标：兼容 "H8/h8"（字母+行号，行号 1-15 从下往上）与旧版双字母格式（如 "hh"） */
export const parsePos = (s: string): Pos | null => {
  const t = s.trim().toLowerCase()
  const m = t.match(/^([a-o])(\d{1,2})$/)
  if (m) {
    const x = m[1].charCodeAt(0) - 97
    const y = 15 - parseInt(m[2], 10)
    return inBounds(x, y) ? { x, y } : null
  }
  if (t.length === 2) {
    // 旧版双字母坐标（历史棋谱兼容）：两个字母分别是列、行
    const x = t.charCodeAt(0) - 97
    const y = t.charCodeAt(1) - 97
    return inBounds(x, y) ? { x, y } : null
  }
  return null
}

/** 走法一/走法二 */
export type Variant = 1 | 2

export type PlayerKind = 'human' | 'ai'

export type AiLevel = 'novice' | 'amateur' | 'advanced' | 'master'

/** 中盘落子引擎：'negamax' = α-β 搜索；'onnx' = 神经网络（无模型时自动回退 negamax） */
export type AiEngine = 'negamax' | 'onnx'

export interface Player {
  kind: PlayerKind
  name: string
  aiLevel?: AiLevel
}

export type ForbiddenKind = 'double-three' | 'double-four' | 'overline'

export type GameEndReason =
  | 'five'
  | 'overline' // 白方长连胜
  | 'forbidden' // 黑方禁手判负
  | 'resign'
  | 'timeout'
  | 'draw'

export interface GameResult {
  winner: 0 | 1 | null // 玩家索引；null = 和棋
  reason: GameEndReason
  /** 获胜五连或禁手点 */
  line?: Pos[]
  forbiddenPos?: Pos
  forbiddenKind?: ForbiddenKind
  comment?: string
}

/** 开局决策日志（用于棋谱全量保真与回放） */
export type OpeningEntry =
  | { step: number; action: 'move'; pos: Pos }
  | { step: number; action: 'swap-offer'; by: 0 | 1; decision: boolean }
  | { step: number; action: 'variant-choice'; by: 0 | 1; variant: Variant }
  | { step: number; action: 'ten-offers'; by: 0 | 1; points: Pos[] }
  | { step: number; action: 'pick-offer'; by: 0 | 1; picked: Pos }
