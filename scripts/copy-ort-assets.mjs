#!/usr/bin/env node
/**
 * 把 onnxruntime-web 的 jsep wasm/mjs 加载器复制到 src/renderer/src/ai/ort/，
 * 供相对路径 ?url 导入（绕开 package exports 的深层导入限制）。
 * 该目录已 gitignore，npm run dev/build 前自动执行。
 */
import fs from 'node:fs'
import path from 'node:path'

const ortDist = path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist')
const outDir = path.join(process.cwd(), 'src', 'renderer', 'src', 'ai', 'ort')
fs.mkdirSync(outDir, { recursive: true })

let copied = 0
for (const f of fs.readdirSync(ortDist)) {
  // 1.29 统一构建：wasm EP（含多线程 SIMD）使用 jsep 变体
  if (/^ort-wasm-simd-threaded\.jsep\.(mjs|wasm)$/.test(f)) {
    fs.copyFileSync(path.join(ortDist, f), path.join(outDir, f))
    copied++
  }
}
console.log(`[copy-ort-assets] ${copied} 个文件 -> src/renderer/src/ai/ort/`)
