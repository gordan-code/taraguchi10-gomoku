// Node 验证脚本：WASM 内核回归 + 基准（node bench.mjs）
import fs from 'node:fs'

const bytes = fs.readFileSync('target/wasm32-unknown-unknown/release/renju_engine.wasm')
const { instance } = await WebAssembly.instantiate(bytes, { env: { now: () => Date.now() } })
const e = instance.exports
const buf = new Uint8Array(e.memory.buffer, e.board_buffer(), 225)

const set = (stones) => {
  buf.fill(0)
  for (const [r, c, s] of stones) buf[r * 15 + c] = s
}

function run(label, color, timeMs) {
  const t0 = Date.now()
  const mv = e.search_best_move(color, 14, timeMs, 20)
  const ms = Date.now() - t0
  const x = mv % 15
  const y = Math.floor(mv / 15)
  const cons = e.eval_consistency()
  const fcons = e.five_consistency()
  console.log(
    `${label}: move=(${x},${y}) score=${e.get_score()} depth=${e.get_depth()} ` +
      `seldepth=${e.get_seldepth()} nodes=${e.get_nodes()} timedOut=${e.get_timed_out()} ` +
      `elapsed=${ms}ms evalConsistency=${cons} fiveConsistency=${fcons}`
  )
  return { x, y, score: e.get_score(), depth: e.get_depth(), nodes: e.get_nodes(), cons, fcons }
}

// ---- 场景 1：白活三，黑必须堵（r=7 行 c=6..8 三连白，两端 5/9 空）
set([
  [7, 6, 2], [7, 7, 2], [7, 8, 2], // 白活三
  [8, 8, 1], [6, 6, 1], [9, 9, 1], [6, 9, 1], [9, 6, 1] // 黑散子无威胁
])
const r1 = run('堵活三(2s) ', 1, 2000)
const blocked = (r1.y === 7 && (r1.x === 5 || r1.x === 9))
console.log(`  堵对了吗: ${blocked} (期望 y=7,x∈{5,9})`)

// ---- 场景 1b：黑冲四（c=3..6 四连，两端开放）→ 黑一步成五
set([
  [7, 3, 1], [7, 4, 1], [7, 5, 1], [7, 6, 1],
  [8, 3, 2], [8, 4, 2], [8, 5, 2], [6, 3, 2]
])
const r1b = run('黑冲四即胜', 1, 2000)
const winNow = r1b.score >= 999000 && r1b.y === 7 && (r1b.x === 2 || r1b.x === 7)
console.log(`  即胜对了吗: ${winNow} (期望 y=7,x∈{2,7},score=MATE,瞬时)`)

// ---- 场景 1c：白活四（两端开放的四）→ 黑一步挡不完，应判负并走挡点
set([
  [7, 4, 2], [7, 5, 2], [7, 6, 2], [7, 7, 2],
  [8, 4, 1], [8, 5, 1], [6, 5, 1], [6, 6, 1]
])
const r1c = run('白活四黑判负', 1, 2000)
const lostCorrect = r1c.score <= -999000 && r1c.y === 7 && (r1c.x === 3 || r1c.x === 8)
console.log(`  判负+挡点对了吗: ${lostCorrect} (期望走挡点且score=-MATE)`)

// ---- 场景 2：安静中盘基准（无即胜/即败，12 子，黑行棋）
set([
  [7, 7, 1], [5, 4, 1], [10, 9, 1], [4, 11, 1], [11, 3, 1], [6, 12, 1],
  [6, 5, 2], [9, 10, 2], [3, 13, 2], [12, 2, 2], [8, 8, 2], [5, 6, 2]
])
const r2 = run('安静中盘(10s)', 1, 10000)

// ---- 场景 3：增量评估一致性（浅层不超时，完整遍历大量落子/撤子对）
set([
  [7, 7, 1], [8, 8, 1], [6, 8, 1], [9, 6, 1], [8, 6, 1], [6, 7, 1],
  [7, 9, 2], [9, 8, 2], [5, 6, 2], [8, 7, 2], [5, 8, 2], [9, 9, 2]
])
const r3 = run('中盘(1s) ', 1, 1000)

const ok = blocked && winNow && lostCorrect && r1.cons === 0 && r2.cons === 0 && r3.cons === 0 &&
  r1.fcons === 0 && r2.fcons === 0 && r3.fcons === 0
console.log(ok ? '✅ 全部通过' : '❌ 有失败项')
process.exit(ok ? 0 : 1)
