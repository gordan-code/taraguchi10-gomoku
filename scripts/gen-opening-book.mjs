#!/usr/bin/env node
/**
 * 生成塔拉山口-10 开局库（src/shared/ai/opening-book.json）：
 * 驱动应用自身的 FSM 枚举开局决策树——
 *   - 交换 / 走法选择阶段：枚举全部分支（accept/reject、走法一/二）
 *   - 第 1-4 手落子：用应用的开局启发式（decideAiAction）
 *   - 第 5、6 手（PLAY）：价值微调后的策略网络 top-2 分支记录入库
 * 键 = 棋盘+行棋方的对称规范化（见 shared/ai/book.ts）。
 *
 * 用法：node scripts/gen-opening-book.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ---- 打包共享逻辑（fsm + 开局决策 + nn 编码）----
const dir = fs.mkdtempSync(path.join(process.cwd(), 'node_modules', '.book-gen-'))
const abs = (p) => path.resolve(p)
const entry = `
export { newGame, currentActor, applyEvent, movePlacementLegal } from ${JSON.stringify(abs('src/shared/fsm.ts'))}
export { decideAiAction } from ${JSON.stringify(abs('src/shared/ai/opening.ts'))}
export { encodeNnState } from ${JSON.stringify(abs('src/shared/ai/nn.ts'))}
export { canonicalKey, SYMS } from ${JSON.stringify(abs('src/shared/ai/book.ts'))}
export { SIZE, idx } from ${JSON.stringify(abs('src/shared/types.ts'))}
export { candidateMoves } from ${JSON.stringify(abs('src/shared/ai/engine.ts'))}
`
fs.writeFileSync(path.join(dir, 'e.ts'), entry)
esbuild.buildSync({ entryPoints: [path.join(dir, 'e.ts')], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'engine.mjs'), logLevel: 'silent' })
const mod = await import(pathToFileURL(path.join(dir, 'engine.mjs')).href)

// ---- 策略网络（onnxruntime-node）----
const ort = await import('onnxruntime-node')
const sess = await ort.InferenceSession.create(abs('src/renderer/src/ai/model.onnx'))

async function policyTopMoves(state, k = 3) {
  const actor = mod.currentActor(state)
  const color = actor.player === state.blackOwner ? 1 : 2
  const enc = mod.encodeNnState(state.board, color, color === 1 && state.moves.length >= 5)
  const out = await sess.run({ input: new ort.Tensor('float32', enc, [1, 4, 15, 15]) })
  const policy = out.policy.data
  const scored = []
  for (const p of mod.candidateMoves(state.board, 3)) {
    const i = mod.idx(p.x, p.y)
    if (state.board[i] !== 0) continue
    if (mod.movePlacementLegal(state, p) !== null) continue // 区域/禁手过滤
    scored.push({ i, logit: policy[i] ?? 0 })
  }
  scored.sort((a, b) => b.logit - a.logit)
  policyCalls++
  return scored.slice(0, k)
}

// ---- 开局决策树枚举 ----
const book = {}
const visited = new Set()
let nodeCount = 0
let policyCalls = 0

function record(state, moveI, weight) {
  const inv = { sym: null }
  const actor = mod.currentActor(state)
  const turn = actor.player === state.blackOwner ? 1 : 2
  const key = mod.canonicalKey(state.board, turn, inv)
  // 实际坐标 -> 规范坐标
  const [cx, cy] = inv.sym.f(Math.floor(moveI / 15), moveI % 15)
  const ci = cy * 15 + cx
  const list = book[key] ?? (book[key] = [])
  const found = list.find((e) => e.i === ci)
  if (found) found.w = Math.max(found.w, weight)
  else list.push({ i: ci, w: weight })
}

async function walk(state) {
  const actor = mod.currentActor(state)
  if (!actor || state.phase === 'OVER') return
  if (state.moves.length >= 6) return // 覆盖第 5、6 手

  const turn = actor.player === state.blackOwner ? 1 : 2
  const stateKey = mod.canonicalKey(state.board, turn) + '|' + state.phase + '|' + (state.variant ?? '')
  if (visited.has(stateKey)) return // 同一对称局面+相位只展开一次
  visited.add(stateKey)
  nodeCount++

  if (actor.kind === 'move') {
    const tops = await policyTopMoves(state, 3)
    if (state.moves.length === 4 || state.moves.length === 5) {
      // 第 5、6 手：入库（top1 权重 2，top2/3 递减）
      let w = 2
      for (const t of tops) {
        record(state, t.i, w)
        w--
      }
    }
    for (const t of tops) {
      const ev = { type: 'move', pos: { x: t.i % 15, y: Math.floor(t.i / 15) } }
      const r = mod.applyEvent(state, ev)
      if (r.result.ok) await walk(r.state)
      else console.error('[walk] move applyEvent 失败:', JSON.stringify(ev), r.result.error)
    }
    return
  }

  if (actor.kind === 'swap' || actor.kind === 'variant') {
    const choices =
      actor.kind === 'swap'
        ? [{ type: 'swap', accept: true }, { type: 'swap', accept: false }]
        : [
            { type: 'variant', variant: 1 },
            { type: 'variant', variant: 2 }
          ]
    for (const ev of choices) {
      const r = mod.applyEvent(state, ev)
      if (r.result.ok) await walk(r.state)
      else console.error('[walk] swap/variant applyEvent 失败:', JSON.stringify(ev), r.result.error)
    }
    return
  }

  // offers / pick：应用自身决策（确定性）
  const d = mod.decideAiAction(state, 'master')
  const r = mod.applyEvent(state, d.event)
  if (r.result.ok) await walk(r.state)
  else console.error('[walk] offers/pick applyEvent 失败:', JSON.stringify(d.event), r.result.error)
}

const players = [
  { kind: 'ai', name: '黑', aiLevel: 'master' },
  { kind: 'ai', name: '白', aiLevel: 'master' }
]
const start = mod.newGame(players, 0)
await walk(start)

const outPath = abs('src/shared/ai/opening-book.json')
fs.writeFileSync(outPath, JSON.stringify(book, null, 1))
console.log(`开局库生成完成：${Object.keys(book).length} 个键，遍历 ${nodeCount} 个节点，策略推理 ${policyCalls} 次`)
fs.rmSync(dir, { recursive: true, force: true })
