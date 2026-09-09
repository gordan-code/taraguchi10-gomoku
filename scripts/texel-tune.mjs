#!/usr/bin/env node
/**
 * Texel 调参：用强引擎（Rapfi）自对弈棋谱拟合评估函数窗口权重。
 *
 * 原理：静态评估 S(board) = Σ (c_b[i] - c_w[i]) · W[i]，把 S 映射为黑方胜率
 *   P(黑胜) = sigmoid(S / scale)
 * 以「预测胜率 vs 实际对局结果」的均方误差为目标，坐标下降搜索权重。
 * scale 用初始权重在数据上的胜率拟合一次（此处固定经验值 400，与 MATE=1e6 量级协调）。
 *
 * 数据：texel-tuning.txt（gen-tuning-data.mjs 生成），每行 = 结果 + 10 个窗口计数。
 * 用法：node scripts/texel-tune.mjs [--data texel-tuning.txt] [--scale 400] [--rounds 60]
 * 输出：最优权重（整数化）+ 训练/验证集损失。
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
}
const cfg = {
  data: arg('data', 'texel-tuning.txt'),
  scale: Number(arg('scale', 400)),
  rounds: Number(arg('rounds', 60))
}

// ---------------------------------------------------------------- 数据

const raw = fs
  .readFileSync(path.resolve(cfg.data), 'utf8')
  .trim()
  .split('\n')
  .map((l) => l.trim().split(/\s+/).map(Number))
  .filter((v) => v.length === 11 && v.every((x) => Number.isFinite(x)))

if (raw.length === 0) {
  console.error('无数据')
  process.exit(1)
}

// 特征向量：f[i] = c_b[i] - c_w[i]（黑方视角）；f[5]（五连）训练中排除——
// 终局已判胜负，五连窗权重保持 MATE 语义不参与拟合。
// W 下标对齐 evaluate：W[1..5]，f[i] ↔ W[i+1]
const X = raw.map((r) => {
  const f = new Array(5).fill(0)
  for (let i = 0; i < 5; i++) f[i] = r[1 + i] - r[6 + i]
  return f
})
const y = raw.map((r) => r[0])

// 训练/验证 9:1 分割（按数据序，同局相邻局面不打散，避免泄露）
const nTrain = Math.floor(X.length * 0.9)
const Xtr = X.slice(0, nTrain), ytr = y.slice(0, nTrain)
const Xva = X.slice(nTrain), yva = y.slice(nValStart())

function nValStart() { return nTrain }

// ---------------------------------------------------------------- 目标函数

// S = f·w（f 为差值特征，w 对应 W[1..5] 中前 4 个；五连位恒 0 参与时排除）
// 实际只调 W[1..4]（五连 W[5]=MATE 固定）
const sigmoid = (x) => 1 / (1 + Math.exp(-x))

function loss(Xs, ys, w) {
  let e = 0
  for (let i = 0; i < Xs.length; i++) {
    let s = 0
    const f = Xs[i]
    for (let k = 0; k < 4; k++) s += f[k] * w[k]
    const p = sigmoid(s / cfg.scale)
    const d = p - ys[i]
    e += d * d
  }
  return e / Xs.length
}

// ---------------------------------------------------------------- 坐标下降

// 初始 = 现网权重 [2, 24, 320, 3600]
const w = [2, 24, 320, 3600]
const STARTS = [0, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 160, 200, 256, 320, 400, 512, 640, 800, 1000, 1280, 1600, 2000, 2560, 3200, 4000, 5000, 6400, 8000]

let bestVa = Infinity
let bestW = w.slice()

console.log(`数据 ${X.length} 局面（train ${Xtr.length} / val ${Xva.length}），scale=${cfg.scale}`)
console.log(`初始权重 [${w.join(', ')}]  train loss=${loss(Xtr, ytr, w).toFixed(6)}  val loss=${loss(Xva, yva, w).toFixed(6)}`)

for (let round = 0; round < cfg.rounds; round++) {
  let improved = false
  for (let k = 0; k < 4; k++) {
    let bestV = w[k]
    let bestL = loss(Xtr, ytr, w)
    for (const cand of STARTS) {
      if (cand === w[k]) continue
      const old = w[k]
      w[k] = cand
      const l = loss(Xtr, ytr, w)
      if (l < bestL - 1e-9) { bestL = l; bestV = cand }
      w[k] = old
    }
    if (bestV !== w[k]) {
      w[k] = bestV
      improved = true
    }
  }
  const va = loss(Xva, yva, w)
  if (va < bestVa) { bestVa = va; bestW = w.slice() }
  if (!improved) break
}

// ---------------------------------------------------------------- 输出

const trL = loss(Xtr, ytr, bestW)
const vaL = loss(Xva, yva, bestW)
console.log(`\n最优权重 W1..W4 = [${bestW.join(', ')}]（W5 五连固定 1000000）`)
console.log(`train loss ${trL.toFixed(6)}  val loss ${vaL.toFixed(6)}（初始 val ${loss(Xva, yva, [2, 24, 320, 3600]).toFixed(6)}）`)

// 给出 TS / Rust 两侧的替换行
const WTS = `[0, ${bestW[0]}, ${bestW[1]}, ${bestW[2]}, ${bestW[3]}, 1_000_000]`
const WRust = `[0, ${bestW[0]}, ${bestW[1]}, ${bestW[2]}, ${bestW[3]}, 1_000_000]`
console.log(`\nTS   (src/shared/ai/engine.ts):  const W = ${WTS}`)
console.log(`Rust (rust-engine/src/lib.rs):     const W: [i32; 6] = ${WRust};`)

// 在验证集上看看胜率预测质量（按分桶校准）
console.log('\n验证集校准（预测胜率分桶 vs 实际黑胜率）:')
const buckets = Array.from({ length: 10 }, () => ({ n: 0, s: 0 }))
for (let i = 0; i < Xva.length; i++) {
  let s = 0
  for (let k = 0; k < 4; k++) s += Xva[i][k] * bestW[k]
  const p = sigmoid(s / cfg.scale)
  const b = Math.min(9, Math.max(0, Math.floor(p * 10)))
  buckets[b].n++
  buckets[b].s += yva[i]
}
for (const [i, b] of buckets.entries()) {
  if (b.n > 0)
    console.log(
      `  ${(i / 10).toFixed(1)}~${((i + 1) / 10).toFixed(1)}: 实际 ${(b.s / b.n).toFixed(3)}  (n=${b.n})`
    )
}
