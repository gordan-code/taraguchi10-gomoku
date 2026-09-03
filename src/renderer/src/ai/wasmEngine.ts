/**
 * Rust/WASM 搜索内核（renju_engine.wasm）：
 * 加载 no_std Negamax 内核（置换表 / 杀手着 / 历史启发 / PVS / 期望窗口 / 禁手过滤 / 静态评估），
 * 中盘（PLAY）用 WASM 搜索替代 TS 的 Negamax，同时间约多搜 3~5 层。
 *
 * 任何加载 / 搜索失败都返回 null，由 worker.ts 回退到 TS 引擎，保证对局永不卡死。
 */
import type { Board, Color } from '@shared/types'
import { SIZE } from '@shared/types'
import type { SearchOptions, SearchResult } from '@shared/ai/engine'
import wasmUrl from './renju_engine.wasm?url'

interface WasmExports {
  memory: WebAssembly.Memory
  board_buffer: () => number
  search_best_move: (color: number, maxDepth: number, timeMs: number, width: number) => number
  get_score: () => number
  get_depth: () => number
  get_nodes: () => number
  get_timed_out: () => number
  get_seldepth: () => number
}

let loadPromise: Promise<WasmExports | null> | null = null

function loadWasmEngine(): Promise<WasmExports | null> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const resp = await fetch(wasmUrl)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const bytes = await resp.arrayBuffer()
        const { instance } = await WebAssembly.instantiate(bytes, {
          env: { now: () => Date.now() }
        })
        console.log('[wasm] Rust 搜索内核加载成功')
        return instance.exports as unknown as WasmExports
      } catch (err) {
        console.warn('[wasm] 内核加载失败，回退 TS Negamax：', err)
        return null
      }
    })()
  }
  return loadPromise
}

export interface WasmSearchResult extends SearchResult {
  /** 威胁延伸后的选择性深度（强制线实际搜到的 ply） */
  seldepth: number
}

/**
 * 用 Rust/WASM 内核搜索最佳落子。失败返回 null（由调用方回退 TS）。
 * board 为 y*15+x 行主序（与 WASM 内核 idx(r,c)=r*15+c 完全一致），值 0/1/2。
 */
export async function wasmSearchBestMove(
  board: Board,
  color: Color,
  opts: SearchOptions
): Promise<WasmSearchResult | null> {
  const wasm = await loadWasmEngine()
  if (!wasm) return null
  try {
    const base = wasm.board_buffer()
    const cells = new Uint8Array(wasm.memory.buffer, base, SIZE * SIZE)
    for (let i = 0; i < SIZE * SIZE; i++) cells[i] = board[i]

    const mv = wasm.search_best_move(color, opts.maxDepth, opts.timeMs, opts.width)
    if (mv < 0 || mv >= SIZE * SIZE) return null
    return {
      move: { x: mv % SIZE, y: Math.floor(mv / SIZE) },
      score: wasm.get_score(),
      depth: wasm.get_depth(),
      nodes: wasm.get_nodes(),
      timedOut: wasm.get_timed_out() !== 0,
      seldepth: wasm.get_seldepth()
    }
  } catch (err) {
    console.warn('[wasm] 搜索失败，回退 TS Negamax：', err)
    return null
  }
}
