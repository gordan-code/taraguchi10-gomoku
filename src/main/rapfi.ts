import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/**
 * Rapfi 外部引擎管理（主进程侧）：
 * UI 对局用 piskvork 协议子进程，协议要点与 scripts/rapfi-adapter.mjs 一致——
 * - BOARD 颜色是相对标记（1=引擎自己 / 2=对手），且必须按真实落子顺序发子
 *   （乱序会触发 Rapfi 的 PASS 补偿、翻转行棋方）
 * - INFO max_memory 按字节传（Rapfi 源码 val>>10 转 KB；传 KB 值会被钳到 1KB）
 * - 跨局检测：tracked 棋盘无法用"恰加一子"解释时视为新局，重启进程
 * 进程生命周期：单实例；新对局/引擎不可用时由渲染层调用 rapfi:stop 或自动重启。
 */

const SIZE = 15
const COORD_RE = /^\s*(\d+)\s*,\s*(\d+)\s*$/

interface RapfiRequest {
  /** 225 格绝对颜色棋盘（0 空 / 1 黑 / 2 白） */
  board: number[]
  /** Rapfi 执子颜色 */
  color: 1 | 2
  /** 每手思考时间 ms */
  timeMs: number
}

function resolveEnginePath(): string | null {
  // 优先用户级 engines 目录（项目根，开发与打包后 resources 一并兼容）
  const candidates = [
    join(app.getAppPath(), 'engines'),
    join(process.resourcesPath ?? '', 'engines'),
    join(app.getPath('userData'), 'engines')
  ]
  for (const dir of candidates) {
    for (const name of ['pbrain-rapfi-windows-avx2.exe', 'pbrain-rapfi-windows-avxvnni.exe', 'pbrain-rapfi-windows-sse.exe']) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

let proc: ChildProcessWithoutNullStreams | null = null
let tracked: number[] | null = null
let buf = ''
const lines: string[] = []

function killEngine(): void {
  if (proc) {
    try { proc.kill() } catch { /* 已退出 */ }
    proc = null
  }
  tracked = null
  lines.length = 0
  buf = ''
}

function onLine(line: string): void {
  lines.push(line.trim())
}

function spawnEngine(exe: string): ChildProcessWithoutNullStreams {
  const p = spawn(exe, [], { cwd: join(exe, '..'), stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (c: string) => {
    buf += c
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  p.stderr.setEncoding('utf8')
  p.stderr.on('data', () => { /* Rapfi 的噪声日志，忽略 */ })
  p.on('exit', () => { if (proc === p) proc = null })
  return p
}

function readUntil(pred: (l: string) => unknown, deadlineMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + deadlineMs
    const tick = () => {
      const idx = lines.findIndex((l) => pred(l))
      if (idx >= 0) return resolve(lines.splice(idx, 1)[0])
      if (!proc || Date.now() > deadline) return resolve(null)
      setTimeout(tick, 20)
    }
    tick()
  })
}

/** tracked → board 恰好新增一子（对手着法）则返回该点，否则 null（新局/异常） */
function diffMove(oldB: number[] | null, newB: number[]): { x: number; y: number } | null {
  if (!oldB) return null
  let add = -1
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = oldB[i]
    const b = newB[i]
    if (a) { if (a !== b) return null } else if (b) { if (add >= 0) return null; add = i }
  }
  return add >= 0 ? { x: add % SIZE, y: Math.floor(add / SIZE) } : null
}

/** 从棋盘重建落子顺序（黑先交替；塔拉山口-10 开局的实际 moves 序列由渲染层传入更可靠，
 * 但此处 board 是唯一事实源——交替重建在开局阶段同样成立：开局事件也保证黑白交替落子）。 */
function orderFromBoard(board: number[]): Array<[number, number, number]> {
  const b = board.slice()
  const seq: Array<[number, number, number]> = []
  let c = 1
  for (;;) {
    let pick = -1
    for (let i = 0; i < SIZE * SIZE; i++) if (b[i] === c) { pick = i; break }
    if (pick < 0) {
      for (let i = 0; i < SIZE * SIZE; i++) if (b[i]) { pick = i; break }
      if (pick < 0) break
    }
    seq.push([pick % SIZE, Math.floor(pick / SIZE), b[pick]])
    b[pick] = 0
    c = c === 1 ? 2 : 1
  }
  return seq
}

async function startGame(board: number[], color: 1 | 2, timeMs: number): Promise<boolean> {
  const exe = resolveEnginePath()
  if (!exe) throw new Error('未找到 Rapfi 引擎（engines/ 目录）')
  proc = spawnEngine(exe)
  proc.stdin.write(`START ${SIZE}\n`)
  const ok = await readUntil((l) => l === 'OK', 30000)
  if (!ok || !proc) return false
  proc.stdin.write(`INFO timeout_turn ${timeMs}\n`)
  proc.stdin.write(`INFO timeout_match ${timeMs * 200}\n`)
  proc.stdin.write('INFO max_memory 268435456\n')
  proc.stdin.write('INFO rule 4\n') // renju（黑禁手）
  await new Promise((r) => setTimeout(r, 50))
  let stones = 0
  for (let i = 0; i < SIZE * SIZE; i++) if (board[i]) stones++
  if (stones === 0 && color === 1) {
    proc.stdin.write('BEGIN\n')
  } else {
    proc.stdin.write('BOARD\n')
    for (const [x, y, col] of orderFromBoard(board)) {
      proc.stdin.write(`${x},${y},${col === color ? 1 : 2}\n`)
    }
    proc.stdin.write('DONE\n')
  }
  return true
}

/** 请求一步棋。返回 { x, y }；失败抛错（渲染层回退安全走法）。 */
export async function rapfiMove(req: RapfiRequest): Promise<{ x: number; y: number }> {
  const board = req.board
  const next = diffMove(tracked, board)
  if (!proc || !next) {
    killEngine()
    const ok = await startGame(board, req.color, req.timeMs)
    if (!ok) throw new Error('Rapfi 启动失败')
  } else {
    proc.stdin.write(`TURN ${next.x},${next.y}\n`)
  }
  const line = await readUntil((l) => COORD_RE.test(l), req.timeMs + 20000)
  if (!line || !proc) {
    killEngine()
    throw new Error('Rapfi 无响应')
  }
  const m = COORD_RE.exec(line)!
  const mv = { x: +m[1], y: +m[2] }
  tracked = board.slice()
  tracked[mv.y * SIZE + mv.x] = req.color
  return mv
}

/** 新对局开始 / 引擎切换 / 窗口关闭时调用：终止子进程并清状态 */
export function rapfiStop(): void {
  killEngine()
}

app.on('before-quit', rapfiStop)
