/**
 * RenjuNet/Piskvork 生态 .psq 棋谱互操作。
 *
 * piskvork 实际格式（源自其 game.cpp 源码）：
 *   首行: "Piskvorky <W>x<H>, <level1>:<level2>, <h>"   （等级 0 = 人类）
 *   着法: 每行 "<x>,<y>,<time>"，坐标 1 基，逗号分隔
 *   尾部: 两行玩家名 + 一行结果码（1=先手胜, 2=后手胜, 0=和/未完）
 *
 * 塔拉山口-10 特有信息（交换/打点）无法用 psq 表达，
 * 按决议以通用文本方式附在玩家名行内（PRD F2）。
 */
import { GameState, Pos } from './index'

export interface PsqData {
  width: number
  height: number
  levels: [number, number]
  h: number
  moves: Pos[]
  names: [string, string]
  errCode: number
}

const RESULT_CODE = (state: GameState): number => {
  const r = state.result
  if (!r) return 0
  if (r.winner === null) return 0
  // psq 视角：先手 = 开局假黑方（players[0]）
  return r.winner === 0 ? 1 : 2
}

export function exportPsq(state: GameState): string {
  const levels: [number, number] = [
    state.players[0].kind === 'ai' ? 3 : 0,
    state.players[1].kind === 'ai' ? 3 : 0
  ]
  // 通用注释（决议 #3）：塔拉山口-10 特有信息附加在玩家名行
  const swaps = state.opening.filter((e) => e.action === 'swap-offer' && e.decision).length
  const variant = state.variant === 2 ? '走法二(十打点)' : state.variant === 1 ? '走法一' : ''
  const tag = `[Taraguchi-10 ${variant} 交换${swaps}次]`
  const names: [string, string] = [state.players[0].name, state.players[1].name]
  const lines: string[] = []
  lines.push(`Piskvorky 15x15, ${levels[0]}:${levels[1]}, 0`)
  for (const m of state.moves) {
    lines.push(`${m.x + 1},${m.y + 1},0`)
  }
  lines.push(`${names[0]} ${tag}`)
  lines.push(names[1])
  lines.push(String(RESULT_CODE(state)))
  return lines.join('\r\n') + '\r\n'
}

/** 宽容解析：兼容标准 piskvork psq 与仅有坐标行的变体 */
export function parsePsq(text: string): { ok: boolean; error?: string; data?: PsqData } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return { ok: false, error: '文件为空' }

  let width = 15
  let height = 15
  let levels: [number, number] = [0, 0]
  let h = 0
  let start = 0

  const header = lines[0].match(/^Piskvorky\s+(\d+)x(\d+),\s*(\d+):(\d+),\s*(\d+)/i)
  if (header) {
    width = parseInt(header[1], 10)
    height = parseInt(header[2], 10)
    levels = [parseInt(header[3], 10), parseInt(header[4], 10)]
    h = parseInt(header[5], 10)
    start = 1
  }

  const moves: Pos[] = []
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d+))?/)
    if (!m) break // 玩家名或结果码行，着法结束
    const x = parseInt(m[1], 10) - 1
    const y = parseInt(m[2], 10) - 1
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return { ok: false, error: `第 ${moves.length + 1} 手坐标越界：${lines[i]}` }
    }
    moves.push({ x, y })
  }

  // 尾部：可选的两行名字 + 结果码
  let names: [string, string] = ['玩家一', '玩家二']
  let errCode = 0
  const tail = lines.slice(start + moves.length)
  if (tail.length >= 3) {
    names = [tail[0], tail[1]]
    const code = tail[2].match(/^(\d+)/)
    if (code) errCode = parseInt(code[1], 10)
  } else if (tail.length === 1) {
    const code = tail[0].match(/^(\d+)/)
    if (code) errCode = parseInt(code[1], 10)
  }

  if (moves.length === 0) return { ok: false, error: '未找到任何着法' }
  return { ok: true, data: { width, height, levels, h, moves, names, errCode } }
}
