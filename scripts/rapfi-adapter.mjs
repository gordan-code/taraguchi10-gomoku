/**
 * piskvork 协议适配器：把外部 piskvork 引擎（如 Rapfi）接入 eval.mjs 对打框架。
 *
 * 生命周期约定：
 * - 每局一个引擎进程：首手用 BOARD 全量同步（或空盘黑方用 BEGIN），之后每手增量 TURN；
 * - BOARD 必须按【真实落子顺序】发子（黑白交替）——rapfi 的 getPosition 按到达顺序放子，
 *   乱序（如棋盘扫描序）会触发 PASS 补偿翻转行棋方，让引擎持错边思考；
 * - BOARD 的颜色标记是相对语义：1=引擎自己(SELF)，2=对手(OPPO)，不是绝对黑/白；
 * - 跨局检测：tracked 棋盘与当前棋盘无法用"恰加一子"解释时，视为新局，重启进程；
 * - 超时/崩溃：返回 pos=null，按对打框架的"无处可落=认输"口径判负。
 *
 * Rapfi 侧配置口径（engines/config.toml 保持默认）：
 * - INFO rule 4 → renju 禁手规则（黑白分权 NNUE）；
 * - 单线程（config default_thread_num=1，与我方 WASM 内核一致）；
 * - INFO max_memory 按字节传（rapfi 源码 val>>10 转 KB；传 KB 值会被钳到 1KB 内存、棋力骤降）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

const SIZE = 15
const COORD_RE = /^\s*(\d+)\s*,\s*(\d+)\s*$/

export function makeRapfiAdapter(label, exePath) {
  const exe = path.resolve(exePath)
  const cwd = path.dirname(exe)
  let proc = null
  let tracked = null // 我方上一手之后的棋盘快照（含我方落子）
  let history = [] // 本局落子顺序（BOARD 需按行棋序发子，乱序会触发 rapfi 的 PASS 翻转）
  let buf = ''
  let pending = null
  const lines = [] // 行队列：同一数据块内的多行不丢弃（MESSAGE+坐标常同块到达）
  const procs = new Set()

  const killAll = () => {
    for (const p of procs) { try { p.kill() } catch {} }
    procs.clear()
    proc = null
  }
  process.on('exit', killAll)
  process.on('SIGINT', () => { killAll(); process.exit(130) })
  process.on('SIGTERM', () => { killAll(); process.exit(143) })

  function onLine(line) {
    if (pending) { const r = pending; pending = null; r(line) }
    else lines.push(line)
  }

  function spawnEngine() {
    const p = spawn(exe, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    procs.add(p)
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        onLine(line)
      }
    })
    p.stderr.setEncoding('utf8')
    p.stderr.on('data', () => {})
    p.on('exit', () => { procs.delete(p); if (proc === p) proc = null })
    proc = p
  }

  function readLine(deadline) {
    if (lines.length > 0) return Promise.resolve(lines.shift())
    return new Promise((resolve) => {
      const remain = deadline - Date.now()
      if (remain <= 0) return resolve(null)
      const timer = setTimeout(() => { pending = null; resolve(null) }, remain)
      pending = (line) => { clearTimeout(timer); resolve(line) }
    })
  }

  // 持续读行直到谓词命中（跳过 MESSAGE/DEBUG 等噪音行）；超时返回 null
  async function readUntil(pred, deadline) {
    for (;;) {
      const line = await readLine(deadline)
      if (line === null) return null
      const v = pred(line)
      if (v) return v
    }
  }

  async function startGame(board, color, timeMs) {
    spawnEngine()
    proc.stdin.write(`START ${SIZE}\n`)
    const ok = await readUntil((l) => (l === 'OK' ? true : null), Date.now() + 30000)
    if (!ok || !proc) return false
    // 注意：rapfi 把 max_memory 的值当字节（源码 val >> 10 转 KB），
    // 262144 会被理解为 256KB 并触发 "Max memory too small" ERROR、
    // 把搜索内存钳到 1KB（TT/开局库全废、棋力骤降）。发 256MB 的字节数。
    proc.stdin.write(`INFO timeout_turn ${timeMs}\n`)
    proc.stdin.write(`INFO timeout_match ${timeMs * 200}\n`)
    proc.stdin.write('INFO max_memory 268435456\n')
    proc.stdin.write('INFO rule 4\n') // renju（黑禁手，白无限制）
    // INFO 与 BOARD 之间留一个 tick，避免流式黏连（实测黏连会改变 Rapfi 的开局选择）
    await new Promise((r) => setTimeout(r, 50))
    let stones = 0
    for (let i = 0; i < SIZE * SIZE; i++) if (board[i]) stones++
    if (stones === 0 && color === 1) {
      history = []
      proc.stdin.write('BEGIN\n')
    } else {
      // piskvork BOARD 的颜色是相对标记：1=引擎自己(SELF)，2=对手(OPPO)，
      // 不是绝对的黑/白；且子必须按真实行棋顺序发送（乱序会触发 PASS 补偿、
      // 翻转 Rapfi 的行棋方使其替对手思考）。
      history = []
      let c = stones % 2 === 0 ? 1 : 2 // 从子数推初始行棋方（黑先）
      for (const [x, y, col] of orderFromBoard(board)) history.push({ x, y, c: col, side: col === color ? 1 : 2 })
      proc.stdin.write('BOARD\n')
      for (const h of history) proc.stdin.write(`${h.x},${h.y},${h.side}\n`)
      proc.stdin.write('DONE\n')
      void c
    }
    return true
  }

  // tracked → board 恰好新增一子（对手着法）则返回该点，否则 null（新局/异常）
  function diffMove(oldB, newB) {
    if (!oldB) return null
    let add = -1
    for (let i = 0; i < SIZE * SIZE; i++) {
      const a = oldB[i]
      const b = newB[i]
      if (a) { if (a !== b) return null } else if (b) { if (add >= 0) return null; add = i }
    }
    return add >= 0 ? { x: add % SIZE, y: Math.floor(add / SIZE) } : null
  }

  // 从棋盘重建落子顺序：黑先、每步选与当前行棋方颜色匹配的子。
  // eval 的开局由随机器生成（近点、黑白交替、黑方过禁手滤），棋盘上必然能按交替序还原。
  function orderFromBoard(board) {
    const b = board.slice()
    const seq = []
    let c = 1
    for (;;) {
      let pick = -1
      for (let i = 0; i < SIZE * SIZE; i++) if (b[i] === c) { pick = i; break }
      if (pick < 0) {
        // 该行棋方无子可挑（异常局面）：从剩余子里随便挑一个继续，保证不丢子
        for (let i = 0; i < SIZE * SIZE; i++) if (b[i]) { pick = i; break }
        if (pick < 0) break
      }
      seq.push([pick % SIZE, Math.floor(pick / SIZE), b[pick]])
      b[pick] = 0
      c = c === 1 ? 2 : 1
    }
    return seq
  }

  return {
    label: `rapfi(${path.basename(exe)})`,
    async pick(board, color, timeMs) {
      const next = diffMove(tracked, board)
      if (!proc || !next) {
        if (proc) { try { proc.kill() } catch {}; procs.delete(proc); proc = null }
        const ok = await startGame(board, color, timeMs)
        if (!ok) { tracked = null; history = []; return { pos: null, score: 0, depth: 0, seldepth: 0, nodes: 0 } }
      } else {
        proc.stdin.write(`TURN ${next.x},${next.y}\n`)
        history.push({ x: next.x, y: next.y, c: color === 1 ? 2 : 1, side: 2 })
      }
      const mv = await readUntil((l) => {
        const m = COORD_RE.exec(l)
        return m ? { x: +m[1], y: +m[2] } : null
      }, Date.now() + timeMs + 20000)
      if (!mv || !proc) {
        if (proc) { try { proc.kill() } catch {}; procs.delete(proc); proc = null }
        tracked = null
        history = []
        return { pos: null, score: 0, depth: 0, seldepth: 0, nodes: 0 }
      }
      tracked = board.slice()
      tracked[mv.y * SIZE + mv.x] = color
      history.push({ x: mv.x, y: mv.y, c: color, side: 1 })
      return { pos: mv, score: 0, depth: 0, seldepth: 0, nodes: 0 }
    }
  }
}
