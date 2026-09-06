#!/usr/bin/env node
/**
 * T1 引擎对打评测框架：固定时间控制、双引擎对局、胜率/深度/节点率统计。
 *
 * 用法：
 *   node scripts/eval.mjs --engine-a ts --engine-b wasm --games 6 --time 500
 *   node scripts/eval.mjs --engine-a wasm --engine-b wasm \
 *     --wasm-a rust-engine/target/wasm32-unknown-unknown/release/renju_engine.wasm \
 *     --wasm-b src/renderer/src/ai/renju_engine.wasm
 *
 * 选项：
 *   --games N        对局数（默认 6，A/B 轮换先后手）
 *   --time MS        每方每手思考时间（默认 500）
 *   --max-depth N    双方搜索深度上限（默认 14，对齐 WASM 生产配置）
 *   --max-moves N    着法上限，超过按最后评估分裁决（默认 120）
 *   --opening-ply N  引擎接管前的随机开局手数（默认 4，含黑1天元）
 *   --adjudicate N   裁决阈值：|黑方评估分|≥N 判优方胜，否则和（默认 400）
 *   --seed N         随机种子（默认 20260905，可复现）
 *   --engine-a/b     ts | wasm
 *   --wasm-a/b PATH  对应侧 WASM 文件（A/B 同为新旧内核对比时用）
 *
 * 公平性：双方均含 TS VCT 必胜预探（与生产路径一致）；评估分统一转黑方视角。
 * 判定：黑恰好五连胜 / 白≥五连胜；黑禁手即负；非法落子判负（护栏）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
}
const cfg = {
  games: Number(arg('games', 6)),
  timeMs: Number(arg('time', 500)),
  maxDepth: Number(arg('max-depth', 14)),
  width: Number(arg('width', 20)),
  maxMoves: Number(arg('max-moves', 120)),
  openingPly: Number(arg('opening-ply', 4)),
  adjudicate: Number(arg('adjudicate', 400)),
  seed: Number(arg('seed', 20260905)),
  engineA: arg('engine-a', 'ts'),
  engineB: arg('engine-b', 'wasm'),
  wasmA: arg('wasm-a', 'rust-engine/target/wasm32-unknown-unknown/release/renju_engine.wasm'),
  wasmB: arg('wasm-b', 'src/renderer/src/ai/renju_engine.wasm')
}

// ---------------------------------------------------------------- TS 引擎打包（esbuild → 临时 ESM）

async function bundleTsEngine() {
  const root = process.cwd()
  const abs = (p) => path.resolve(root, p)
  const entry = `
export { searchBestMove, probeForcedWin, candidateMoves, dynamicTimeMs } from ${JSON.stringify(abs('src/shared/ai/engine.ts'))}
export { checkForbidden } from ${JSON.stringify(abs('src/shared/forbidden.ts'))}
export { emptyBoard, runLength } from ${JSON.stringify(abs('src/shared/board.ts'))}
export { SIZE } from ${JSON.stringify(abs('src/shared/types.ts'))}
export { mctsSearch, combineMctsResults } from ${JSON.stringify(abs('src/shared/ai/mcts.ts'))}
export { encodeNnState } from ${JSON.stringify(abs('src/shared/ai/nn.ts'))}
`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renju-eval-'))
  const entryPath = path.join(dir, 'entry.ts')
  const outPath = path.join(dir, 'engine.mjs')
  fs.writeFileSync(entryPath, entry)
  esbuild.buildSync({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'silent' })
  const mod = await import(pathToFileURL(outPath).href)
  return { mod, dir }
}

// ---------------------------------------------------------------- 引擎适配器（统一接口：pick(board, color, timeMs) → {pos, score(行棋方视角), depth, seldepth, nodes}）

function makeTsAdapter(mod, label, cfg) {
  return {
    label,
    pick(board, color, timeMs) {
      const r = mod.searchBestMove(board, color, { maxDepth: cfg.maxDepth, timeMs, width: cfg.width, noise: 0 })
      return {
        pos: r.move,
        score: r.score,
        depth: r.depth,
        seldepth: r.depth,
        nodes: r.nodes
      }
    }
  }
}

async function makeWasmAdapter(mod, label, wasmPath, cfg) {
  const bytes = fs.readFileSync(wasmPath)
  const { instance } = await WebAssembly.instantiate(bytes, { env: { now: () => Date.now() } })
  const e = instance.exports
  return {
    label: `${label}(${path.basename(wasmPath)})`,
    pick(board, color, timeMs) {
      // 生产路径同款：TS VCT 必胜预探 → WASM Negamax
      const vct = mod.probeForcedWin(board, color)
      if (vct >= 0) {
        return { pos: { x: vct % 15, y: Math.floor(vct / 15) }, score: 999999, depth: 1, seldepth: 1, nodes: 0 }
      }
      const cells = new Uint8Array(e.memory.buffer, e.board_buffer(), 225)
      for (let i = 0; i < 225; i++) cells[i] = board[i]
      const mv = e.search_best_move(color, cfg.maxDepth, timeMs, cfg.width)
      const pos = mv >= 0 ? { x: mv % 15, y: Math.floor(mv / 15) } : null
      return { pos, score: e.get_score(), depth: e.get_depth(), seldepth: e.get_seldepth(), nodes: e.get_nodes() }
    }
  }
}

// ---------------------------------------------------------------- 规则辅助（评测用最小口径，全部走共享规则模块）

const SIZE = 15

function apply(board, pos, color) {
  board[pos.y * SIZE + pos.x] = color
}

function isLegal(board, pos, color) {
  if (pos.x < 0 || pos.x >= SIZE || pos.y < 0 || pos.y >= SIZE) return false
  if (board[pos.y * SIZE + pos.x] !== 0) return false
  if (color === 1) {
    apply(board, pos, 1)
    const bad = mod_.checkForbidden(board, pos) !== null
    board[pos.y * SIZE + pos.x] = 0
    if (bad) return false
  }
  return true
}

function winAfter(board, pos, color) {
  const len = mod_.runLength(board, pos, color)
  return color === 1 ? len === 5 : len >= 5
}

// ---------------------------------------------------------------- 种子随机开局（黑1天元固定，近点扩展，可复现）

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

function openingMoves(mod, seed, plies) {
  const board = mod.emptyBoard()
  const rng = mulberry32(seed)
  const moves = [{ x: 7, y: 7 }]
  apply(board, moves[0], 1)
  let color = 2
  while (moves.length < plies) {
    const cands = mod.candidateMoves(board, 2).filter((p) => isLegal(board, p, color))
    if (cands.length === 0) break
    const p = cands[Math.floor(rng() * cands.length)]
    apply(board, p, color)
    moves.push(p)
    color = color === 1 ? 2 : 1
  }
  return { moves, nextColor: color }
}

// ---------------------------------------------------------------- 对局

let mod_ = null // 规则函数（bundle 后注入）

async function playGame(adapters, blackIdx, opening, cfg) {
  const board = mod.emptyBoard()
  let color = 1
  for (const m of opening.moves) {
    apply(board, m, color)
    color = color === 1 ? 2 : 1
  }

  const stats = [0, 1].map(() => ({ moves: 0, nodes: 0, elapsedMs: 0, depth: 0, seldepth: 0 }))
  const records = []
  let lastBlackScore = 0
  let ply = opening.moves.length
  let result = null // 'A' | 'B' | 'draw' | 'A-illegal' | 'B-illegal'

  while (true) {
    const idx = color === 1 ? blackIdx : 1 - blackIdx
    const eng = adapters[idx]
    const t0 = Date.now()
    const r = await eng.pick(board, color, cfg.timeMs)
    const elapsed = Date.now() - t0
    const s = stats[idx]
    s.moves++
    s.nodes += r.nodes
    s.elapsedMs += elapsed
    s.depth += r.depth
    s.seldepth += r.seldepth
    lastBlackScore = color === 1 ? r.score : -r.score

    if (!r.pos) {
      records.push({ color, pos: null, depth: r.depth, seldepth: r.seldepth, nodes: r.nodes, score: lastBlackScore, elapsedMs: elapsed })
      result = idx === 0 ? 'B' : 'A' // 无处可落 = 认输
      break
    }
    if (board[r.pos.y * SIZE + r.pos.x] !== 0 || !isLegal(board, r.pos, color)) {
      // 非法落子（占位/禁手）护栏：引擎不该发生，发生即负
      records.push({ color, pos: r.pos, depth: r.depth, seldepth: r.seldepth, nodes: r.nodes, score: lastBlackScore, elapsedMs: elapsed, illegal: true })
      result = idx === 0 ? 'B-illegal' : 'A-illegal'
      break
    }
    records.push({ color, pos: r.pos, depth: r.depth, seldepth: r.seldepth, nodes: r.nodes, score: lastBlackScore, elapsedMs: elapsed })
    apply(board, r.pos, color)
    ply++
    if (winAfter(board, r.pos, color)) {
      result = idx === 0 ? 'A' : 'B'
      break
    }
    if (ply >= cfg.maxMoves) {
      if (lastBlackScore >= cfg.adjudicate) result = blackIdx === 0 ? 'A' : 'B'
      else if (lastBlackScore <= -cfg.adjudicate) result = blackIdx === 0 ? 'B' : 'A'
      else result = 'draw'
      break
    }
    color = color === 1 ? 2 : 1
  }
  return { result, ply, stats, records, board }
}

// ---------------------------------------------------------------- 主流程

const { mod, dir } = await bundleTsEngine()
mod_ = mod
let nnWorkerCacheDir = null

// A/B 各自独立的 WASM 实例（同文件也各起一份，互不串状态）
async function makeNnAdapter(mod, label, cfg, tmpDir) {
  // 与生产架构一致：K 个 Worker 线程各自独立会话 + 独立树（根噪声多样性），主线程汇总。
  // nn-delay 模拟浏览器推理延迟（onnxruntime-web ~20-40ms/次），
  // 在延迟约束机制下根并行的 K 倍模拟才有意义（Node 原生 ~0.4ms/次时单树更优）。
  const { Worker } = await import('node:worker_threads')
  const ort = await import('onnxruntime-node')
  const modelPath = path.resolve('src/renderer/src/ai/model.onnx')
  // 预热一个会话确认模型可用（各 Worker 线程内各自再建）
  await ort.InferenceSession.create(modelPath)
  const k = Math.max(1, Math.min(Number(arg('nn-threads', 4)), 16))
  const netDelayMs = Number(arg('nn-delay', 0))
  // 入口须在项目内（bare 导入 onnxruntime-node 要能解析到 node_modules）
  const cacheDir = path.join(process.cwd(), 'node_modules', '.eval-cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const entryPath = path.join(cacheDir, 'nn-worker.mjs')
  fs.writeFileSync(
    entryPath,
    `import { parentPort } from 'node:worker_threads'
import { mctsSearch, encodeNnState } from ${JSON.stringify(pathToFileURL(path.join(tmpDir, 'engine.mjs')).href)}
let sess = null
async function getSession() {
  if (!sess) {
    const ort = await import('onnxruntime-node')
    sess = await ort.InferenceSession.create(${JSON.stringify(modelPath)})
  }
  return sess
}
parentPort.on('message', async (req) => {
  try {
    const s = await getSession()
    const ort = await import('onnxruntime-node')
    const net = async (b, c, ply) => {
      if (req.netDelayMs > 0) await new Promise((r) => setTimeout(r, req.netDelayMs))
      const enc = encodeNnState(b, c, c === 1 && req.movesCount + ply >= 5)
      const out = await s.run({ input: new ort.Tensor('float32', enc, [1, 4, 15, 15]) })
      return { policy: out.policy.data, value: out.value.data[0] }
    }
    const r = await mctsSearch(req.board, req.color, {
      sims: req.sims,
      deadline: Date.now() + req.timeMs,
      rootNoise: req.noise
    }, net)
    parentPort.postMessage({ id: req.id, ok: true, result: r })
  } catch (err) {
    parentPort.postMessage({ id: req.id, ok: false, error: String(err) })
  }
})
`
  )
  const workers = Array.from({ length: k }, () => new Worker(entryPath))
  nnWorkerCacheDir = cacheDir
  let movesCount = cfg.openingPly
  return {
    label: k > 1 ? `${label}×${k}${netDelayMs ? `@${netDelayMs}ms` : ''}` : label,
    async pick(board, color, timeMs) {
      const m0 = movesCount
      const sims = 1500
      const jobs = workers.map((w, t) =>
        new Promise((resolve) => {
          const id = `${t}-${Date.now()}-${Math.random()}`
          const timer = setTimeout(() => resolve(null), timeMs + 10000)
          w.once(`done-${id}`, (msg) => {
            clearTimeout(timer)
            resolve(msg && msg.ok ? msg.result : null)
          })
          const onMsg = (msg) => {
            if (msg.id !== id) return
            w.off('message', onMsg)
            w.emit(`done-${id}`, msg)
          }
          w.on('message', onMsg)
          w.postMessage({
            id, board, color, movesCount: m0, timeMs: Math.max(300, timeMs), sims,
            netDelayMs, noise: { eps: 0.15, alpha: 1.0, seed: Date.now() ^ (t * 0x9e3779b9) }
          })
        })
      )
      const results = await Promise.all(jobs)
      movesCount++
      const r = mod.combineMctsResults(results)
      if (!r) return { pos: null, score: 0, depth: 0, seldepth: 0, nodes: 0 }
      return {
        pos: r.pos,
        score: color === 1 ? r.q : -r.q, // 黑方视角
        depth: r.depth,
        seldepth: r.depth,
        nodes: r.sims
      }
    }
  }
}

async function buildAdapters() {
  const out = []
  for (const [kind, label, wasmKey] of [
    [cfg.engineA, 'A', 'wasmA'],
    [cfg.engineB, 'B', 'wasmB']
  ]) {
    if (kind === 'ts') out.push(makeTsAdapter(mod, label, cfg))
    else if (kind === 'wasm') out.push(await makeWasmAdapter(mod, label, cfg[wasmKey], cfg))
    else if (kind === 'nn') out.push(await makeNnAdapter(mod, label, cfg, dir))
    else throw new Error(`未知引擎类型: ${kind}`)
  }
  return out
}

const adapters = await buildAdapters()
console.log(`对打评测: A=${cfg.engineA} vs B=${cfg.engineB}  每手 ${cfg.timeMs}ms × ${cfg.games} 局（先后手轮换，maxDepth=${cfg.maxDepth}）`)

const tally = {
  A: { win: 0, loss: 0, draw: 0 },
  B: { win: 0, loss: 0, draw: 0 }
}
const statAcc = [null, null] // 每引擎汇总
for (let g = 0; g < cfg.games; g++) {
  const blackIdx = g % 2 // 偶数局 A 执黑
  const opening = openingMoves(mod, cfg.seed + g * 7919, cfg.openingPly)
  const { result, ply, stats, records, board } = await playGame(adapters, blackIdx, opening, cfg)

  if (argv.includes('--dump')) {
    console.log(`  —— 局 ${g + 1} 着法（x=黑 o=白，行=y 列=x，*=最后一手）——`)
    let last = null
    for (const [i, rec] of records.entries()) {
      if (rec.pos) last = rec
      console.log(
        `    ${String(i + 1).padStart(2)}. ${rec.color === 1 ? '黑' : '白'}` +
          `${rec.pos ? ` (${rec.pos.x},${rec.pos.y})` : ' (认输)'}` +
          `  深度${rec.depth}/威胁线${rec.seldepth} 分${rec.score >= 0 ? '+' : ''}${Math.round(rec.score)}` +
          ` ${rec.elapsedMs}ms${rec.illegal ? ' 【非法】' : ''}`
      )
    }
    for (let y = 0; y < SIZE; y++) {
      let row = ''
      for (let x = 0; x < SIZE; x++) {
        const s = board[y * SIZE + x]
        const isLast = last && last.pos && last.pos.x === x && last.pos.y === y
        row += s === 1 ? (isLast ? 'x' : 'X') : s === 2 ? (isLast ? 'o' : 'O') : '.'
      }
      console.log('    ' + row)
    }
  }

  for (let i = 0; i < 2; i++) {
    if (!statAcc[i]) statAcc[i] = { moves: 0, nodes: 0, elapsedMs: 0, depth: 0, seldepth: 0 }
    for (const k of Object.keys(statAcc[i])) statAcc[i][k] += stats[i][k]
  }

  const nameA = `A(${cfg.engineA})`
  const nameB = `B(${cfg.engineB})`
  const winA = result === 'A'
  const winB = result === 'B'
  const illegal = result.endsWith('illegal')
  if (winA) { tally.A.win++; tally.B.loss++ }
  else if (winB) { tally.B.win++; tally.A.loss++ }
  else { tally.A.draw++; tally.B.draw++ }
  console.log(
    `  局 ${g + 1}: ${nameA}${blackIdx === 0 ? '执黑' : '执白'} vs ${nameB}${blackIdx === 0 ? '执白' : '执黑'}` +
      ` → ${winA ? nameA + ' 胜' : winB ? nameB + ' 胜' : illegal ? '非法落子判负' : '和棋'}` +
      `（${ply} 手${illegal ? '，非法着法' : ''}）`
  )
}

// ---------------------------------------------------------------- 汇总

const games = cfg.games
const scoreA = (tally.A.win + 0.5 * tally.A.draw) / games
const elo = scoreA > 0 && scoreA < 1 ? Math.round(400 * Math.log10(scoreA / (1 - scoreA))) : scoreA === 1 ? 9999 : -9999

console.log('\n──────────── 汇总 ────────────')
console.log(`A(${cfg.engineA})  胜 ${tally.A.win} / 负 ${tally.A.loss} / 和 ${tally.A.draw}   得分率 ${(scoreA * 100).toFixed(1)}%`)
console.log(`B(${cfg.engineB})  胜 ${tally.B.win} / 负 ${tally.B.loss} / 和 ${tally.B.draw}`)
console.log(`Elo 估计: A 相对 B ${elo >= 0 ? '+' : ''}${elo}`)

function line(label, kind, acc) {
  const mps = acc.moves > 0 ? acc.elapsedMs / acc.moves : 0
  const nps = acc.elapsedMs > 0 ? Math.round(acc.nodes / (acc.elapsedMs / 1000)) : 0
  const avgD = acc.moves > 0 ? (acc.depth / acc.moves).toFixed(1) : '-'
  const avgS = acc.moves > 0 ? (acc.seldepth / acc.moves).toFixed(1) : '-'
  const avgN = acc.moves > 0 ? Math.round(acc.nodes / acc.moves) : 0
  return `${label.padEnd(14)} 深度 ${String(avgD).padStart(5)}  威胁线 ${String(avgS).padStart(5)}  节点/手 ${String(avgN).padStart(8)}  ${String(nps).padStart(9)} nps  ${mps.toFixed(0)} ms/手`
}
console.log('\n' + line(`A(${cfg.engineA})`, cfg.engineA, statAcc[0] ?? { moves: 0, nodes: 0, elapsedMs: 0, depth: 0, seldepth: 0 }))
  console.log(line(`B(${cfg.engineB})`, cfg.engineB, statAcc[1] ?? { moves: 0, nodes: 0, elapsedMs: 0, depth: 0, seldepth: 0 }))
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
if (nnWorkerCacheDir) { try { fs.rmSync(nnWorkerCacheDir, { recursive: true, force: true }) } catch {} }
// worker_threads 不终止会吊住事件循环，CLI 评测直接退出
process.exit(0)
