#!/usr/bin/env node
/**
 * 生成 texel 调参训练数据：驱动 Rapfi 自对弈（快棋），逐局面记录窗口特征 + 终局结果。
 *
 * 数据格式（texel-tuning.txt，每局面一行）：
 *   <结果z> <窗口计数c1..c10>
 *   z ∈ {1.0(黑胜), 0.0(白胜), 0.5(和)}；c1..c5 = 黑 1/2/3/4/5 子纯窗口数，c6..c10 = 白
 * 与评估函数同口径：所有 5 连窗口中黑白数 (b,w)，b>0∧w>0 混合窗不计，b>0 计入 c_b，w>0 计入 c_w。
 *
 * 用法：node scripts/gen-tuning-data.mjs --games 200 --time 300 --out texel-tuning.txt
 * 数据来自强引擎对局，拟合出的权重是「Rapfi 眼中的局面价值」，远优于自对弈。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
}
const cfg = {
  games: Number(arg('games', 200)),
  timeMs: Number(arg('time', 300)),
  out: arg('out', 'texel-tuning.txt'),
  exe: arg('exe', 'engines/pbrain-rapfi-windows-avx2.exe'),
  seed: Number(arg('seed', 20260909))
}

const SIZE = 15
const exe = path.resolve(cfg.exe)
const cwd = path.dirname(exe)

// ---------------------------------------------------------------- Rapfi 子进程封装

function makeEngine() {
  const p = spawn(exe, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const lines = []
  let dead = false
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i).trim())
      buf = buf.slice(i + 1)
    }
  })
  p.stderr.setEncoding('utf8')
  p.stderr.on('data', () => {})
  p.on('exit', () => { dead = true })
  const waitLine = async (pred, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const idx = lines.findIndex(pred)
      if (idx >= 0) return lines.splice(idx, 1)[0]
      if (dead || Date.now() > deadline) return null
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return {
    proc: p,
    /** 取一行匹配 pred 的输出（轮询内部行队列）；超时/进程死返回 null */
    async takeLine(pred, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const idx = lines.findIndex(pred)
        if (idx >= 0) return lines.splice(idx, 1)[0]
        if (dead || Date.now() > deadline) return null
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    async start() {
      p.stdin.write(`START ${SIZE}\n`)
      return !!(await waitLine((l) => l === 'OK', 30000))
    },
    // board 为绝对颜色棋盘（Uint8Array）；发 BOARD（相对标记 + 落子顺序）；等应手
    async pick(board, color) {
      p.stdin.write('BOARD\n')
      let c = 1
      const b = board.slice()
      for (;;) {
        let pick = -1
        for (let i = 0; i < SIZE * SIZE; i++) if (b[i] === c) { pick = i; break }
        if (pick < 0) break
        p.stdin.write(`${pick % SIZE},${Math.floor(pick / SIZE)},${b[pick] === color ? 1 : 2}\n`)
        b[pick] = 0
        c = c === 1 ? 2 : 1
      }
      p.stdin.write('DONE\n')
      const r = await waitLine((l) => /^\d+\s*,\s*\d+$/.test(l), cfg.timeMs + 60000)
      if (!r) return null
      const [x, y] = r.split(',').map(Number)
      return { x, y }
    },
    async turn(x, y) {
      p.stdin.write(`TURN ${x},${y}\n`)
      const r = await waitLine((l) => /^\d+\s*,\s*\d+$/.test(l), cfg.timeMs + 60000)
      if (!r) return null
      return r.split(',').map(Number)
    },
    kill() {
      try { p.kill() } catch {}
    }
  }
}

// ---------------------------------------------------------------- 特征提取（与 evaluate 同口径）

function windowFeatures(board) {
  // c[0..4]=黑1..5子窗口数, c[5..9]=白
  const c = new Array(10).fill(0)
  const count = (r0, c0, dr, dc, len) => {
    for (let i = 0; i + 5 <= len; i++) {
      let b = 0
      let w = 0
      for (let k = 0; k < 5; k++) {
        const s = board[(r0 + dr * i + dr * k) * SIZE + (c0 + dc * i + dc * k)]
        if (s === 1) b++
        else if (s === 2) w++
      }
      if (b > 0 && w === 0) c[b - 1]++
      else if (w > 0 && b === 0) c[4 + w]++
    }
  }
  for (let y = 0; y < SIZE; y++) count(y, 0, 0, 1, SIZE) // 行
  for (let x = 0; x < SIZE; x++) count(0, x, 1, 0, SIZE) // 列
  for (let s = 0; s < 2 * SIZE - 1; s++) { // ↘ 对角
    const cells = []
    for (let x = 0; x < SIZE; x++) {
      const y = s - x
      if (y >= 0 && y < SIZE) cells.push([y, x])
    }
    if (cells.length >= 5) {
      let b = 0, w = 0
      for (let i = 0; i + 5 <= cells.length; i++) {
        b = 0; w = 0
        for (let k = 0; k < 5; k++) {
          const [yy, xx] = cells[i + k]
          const st = board[yy * SIZE + xx]
          if (st === 1) b++
          else if (st === 2) w++
        }
        if (b > 0 && w === 0) c[b - 1]++
        else if (w > 0 && b === 0) c[4 + w - 1]++
      }
    }
  }
  for (let s = 0; s < 2 * SIZE - 1; s++) { // ↗ 反对角
    const cells = []
    for (let x = 0; x < SIZE; x++) {
      const y = x - (s - (SIZE - 1))
      if (y >= 0 && y < SIZE) cells.push([y, x])
    }
    if (cells.length >= 5) {
      let b = 0, w = 0
      for (let i = 0; i + 5 <= cells.length; i++) {
        b = 0; w = 0
        for (let k = 0; k < 5; k++) {
          const [yy, xx] = cells[i + k]
          const st = board[yy * SIZE + xx]
          if (st === 1) b++
          else if (st === 2) w++
        }
        if (b > 0 && w === 0) c[b - 1]++
        else if (w > 0 && b === 0) c[4 + w - 1]++
      }
    }
  }
  return c
}

function isWin(board, x, y, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (const [dx, dy] of dirs) {
    let cnt = 1
    for (const s of [1, -1]) {
      let step = 1
      for (;;) {
        const nx = x + dx * step * s
        const ny = y + dy * step * s
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || board[ny * SIZE + nx] !== color) break
        cnt++
        step++
      }
    }
    if (color === 2 ? cnt >= 5 : cnt === 5) return true
  }
  return false
}

// ---------------------------------------------------------------- 随机开局（种子化，与 eval.mjs 同随机器）

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 近点随机开局（黑1天元，距离 ≤2，避开天元邻域过近） */
function randomOpening(rng, plies) {
  const board = new Uint8Array(SIZE * SIZE)
  const moves = []
  const put = (x, y, c) => { board[y * SIZE + x] = c; moves.push([x, y, c]) }
  put(7, 7, 1)
  let color = 2
  while (moves.length < plies) {
    // 候选：已有棋子距离 ≤2 的空点
    const cands = []
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        if (board[y * SIZE + x] !== 0) continue
        let near = false
        for (let dy = -2; dy <= 2 && !near; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[ny * SIZE + nx] !== 0) { near = true; break }
          }
        if (near) cands.push([x, y])
      }
    if (!cands.length) break
    const [x, y] = cands[Math.floor(rng() * cands.length)]
    put(x, y, color)
    color = color === 1 ? 2 : 1
  }
  return { board, moves, nextColor: color }
}

// ---------------------------------------------------------------- 主流程

const rng = mulberry32(cfg.seed)
const samples = []
let blackWins = 0, whiteWins = 0, draws = 0

console.log(`Rapfi 自对弈生成调参数据：${cfg.games} 局 × ${cfg.timeMs}ms/手 → ${cfg.out}`)

for (let g = 0; g < cfg.games; g++) {
  const engBlack = makeEngine()
  const engWhite = makeEngine()
  const positions = [] // {board 快照(落子前)}
  let result = null

  try {
    if (!(await engBlack.start()) || !(await engWhite.start())) throw new Error('启动失败')
    for (const e of [engBlack, engWhite]) {
      e.proc.stdin.write(`INFO timeout_turn ${cfg.timeMs}\n`)
      e.proc.stdin.write(`INFO timeout_match ${cfg.timeMs * 400}\n`)
      e.proc.stdin.write('INFO max_memory 268435456\n')
      e.proc.stdin.write('INFO rule 4\n')
      await new Promise((r) => setTimeout(r, 50))
    }

    const { board, moves } = randomOpening(rng, 4)
    let color = 1 // 4 手开局后轮黑
    let ply = moves.length
    const maxPly = 120
    let lastMove = null

    // 黑方引擎用 BOARD 同步开局并走首手；白方引擎先同步局面（吃掉它对 BOARD 的应手——
    // BOARD 后轮黑，白方不会应手？实测 rapfi 在 BOARD 后总是立即思考轮到的一方，
    // 白方收到"轮白走"的 BOARD 才应手；开局后轮黑，白方 BOARD 同步后不应。
    // 但为保险，白方的 BOARD 同步放在黑方首手之后用 TURN 增量。
    positions.push({ board: board.slice() })
    const first = await engBlack.pick(board, 1)
    if (!first) throw new Error('黑首手无回应')
    board[first.y * SIZE + first.x] = 1
    lastMove = [first.x, first.y]
    ply++

    while (ply < maxPly) {
      if (isWin(board, lastMove[0], lastMove[1], color === 1 ? 2 : 1)) {
        result = color === 1 ? 0.0 : 1.0 // 上一步（对方）获胜
        break
      }
      positions.push({ board: board.slice() })
      const eng = color === 1 ? engBlack : engWhite
      const other = color === 1 ? engWhite : engBlack
      const mv = await other.turn(lastMove[0], lastMove[1])
      if (!mv) { result = color === 1 ? 0.0 : 1.0; break } // 行棋方超时/崩溃 = 认输
      const [x, y] = mv
      if (board[y * SIZE + x] !== 0) { result = color === 1 ? 0.0 : 1.0; break } // 非法
      board[y * SIZE + x] = color
      lastMove = [x, y]
      ply++
      if (isWin(board, x, y, color)) { result = color === 1 ? 1.0 : 0.0; break }
      color = color === 1 ? 2 : 1
    }
    if (result === null) result = 0.5
  } catch (err) {
    console.log(`  局 ${g + 1} 异常: ${err.message}`)
    result = 0.5
  } finally {
    engBlack.kill()
    engWhite.kill()
  }

  if (result === 1.0) blackWins++
  else if (result === 0.0) whiteWins++
  else draws++

  for (const p of positions) {
    const f = windowFeatures(p.board)
    if (p.board.reduce((a, v) => a + (v ? 1 : 0), 0) < 6) continue
    samples.push([result, ...f])
  }

  if ((g + 1) % 10 === 0)
    console.log(`  局 ${g + 1}/${cfg.games}  黑${blackWins} 白${whiteWins} 和${draws}  样本${samples.length}`)
}

// 写文件
const out = path.resolve(cfg.out)
fs.writeFileSync(out, samples.map((s) => s.join(' ')).join('\n') + '\n')
console.log(`\n完成：${samples.length} 局面 → ${out}`)
console.log(`黑胜 ${blackWins} / 白胜 ${whiteWins} / 和 ${draws}`)
process.exit(0)
