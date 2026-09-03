/**
 * 搜索子 Worker：并行根拆分时由主 AI Worker 派发，只搜指定的根候选子集。
 * 输入 { board, color, opts }（opts 带 rootMoves 子集），输出 SearchResult。
 */
import { searchBestMove } from '@shared/ai/engine'
import type { SearchOptions } from '@shared/ai/engine'
import type { Board, Color } from '@shared/types'

interface SearchRequest {
  board: Board
  color: Color
  opts: SearchOptions
}

self.onmessage = (e: MessageEvent<SearchRequest>) => {
  const { board, color, opts } = e.data
  const r = searchBestMove(board, color, opts)
  self.postMessage({ move: r.move, score: r.score, depth: r.depth, nodes: r.nodes, timedOut: r.timedOut })
}
