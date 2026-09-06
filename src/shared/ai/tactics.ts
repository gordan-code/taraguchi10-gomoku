/**
 * 战术危机评估（纯函数）：判断当前局面是否存在「必须应对」的紧急威胁。
 *
 * 按落子后果分类（对每一候选点，试放后检查）：
 *   - five：落子即成五（我方=取胜；对手=下一手就输，必须挡）
 *   - openfour：落子后形成有两个成五点的四（活四类）——我方=两步取胜；
 *     对手=无法同时封堵两处，必须预防
 *   - simplefour：只有一个成五点的普通四——可挡，不算危机（交给搜索）
 *
 * 该评估驱动混合引擎的分流：危机时切换搜索内核全力应对（战术可靠），
 * 安静时交给 NN+MCTS（位置感强）。判据是经典连珠知识，毫秒级完成。
 */
import { Board, Color, Pos } from '../types'
import { fourThreatMoves, fourWinningPoints } from './engine'
import { runLength } from '../board'
import { checkForbidden } from '../forbidden'

export interface TacticalAssessment {
  /** 我方紧急制胜点（落子即成五，或成活四）——存在即应立即落子 */
  urgentWin: Pos | null
  /** 对手的紧急点（不阻拦则对手 1-2 手内成五）——非空时属于战术危机 */
  mustBlockPoints: Pos[]
}

function toCell(i: number): Pos {
  return { x: i % 15, y: Math.floor(i / 15) }
}

/** 在 i 试放 c 后的紧急级别（board[i] 需已置为 c，调用后由外层还原） */
function classifyPlaced(board: Board, i: number, c: 1 | 2): 'five' | 'openfour' | 'none' {
  const p = toCell(i)
  const len = runLength(board, p, c)
  if (c === 1 ? len === 5 : len >= 5) return 'five'
  if (fourWinningPoints(board, p, c).length >= 2) return 'openfour'
  return 'none'
}

export function assessTactics(board: Board, color: 1 | 2): TacticalAssessment {
  const opp: 1 | 2 = color === 1 ? 2 : 1
  const work = board.slice() as Board

  // 我方紧急制胜点：落子即成五，或成活四（对手挡不住其一）
  let urgentWin: Pos | null = null
  for (const i of fourThreatMoves(work, color)) {
    work[i] = color
    const cls = classifyPlaced(work, i, color)
    work[i] = 0
    if (cls === 'five' || cls === 'openfour') {
      urgentWin = toCell(i)
      break
    }
  }

  // 对手紧急点：落子即成五，或成活四（我方来不及/无法同时应对）
  const mustBlockPoints: Pos[] = []
  if (!urgentWin) {
    for (const i of fourThreatMoves(work, opp)) {
      work[i] = opp
      const cls = classifyPlaced(work, i, opp)
      work[i] = 0
      // 对手为黑时需排除禁手点（fourThreatMoves 已只统计合法落点区域内的四，
      // 这里再过一次禁手兜底）
      if (cls !== 'none') {
        work[i] = opp
        const forbidden = opp === 1 ? checkForbiddenSafe(work, toCell(i)) : false
        work[i] = 0
        if (!forbidden) mustBlockPoints.push(toCell(i))
      }
    }
  }

  return { urgentWin, mustBlockPoints }
}

function checkForbiddenSafe(board: Board, p: Pos): boolean {
  try {
    return checkForbidden(board, p) !== null
  } catch {
    return false
  }
}
