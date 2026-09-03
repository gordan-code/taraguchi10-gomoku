import { describe, expect, it } from 'vitest'
import { Player, Pos, parsePos, posCode, posName } from '../types'
import { applyEvent, newGame } from '../fsm'
import { deserializeRecord, serializeRecord } from '../record'
import { exportPsq, parsePsq } from '../psq'

const human: Player = { kind: 'human', name: '玩家' }
const ai: Player = { kind: 'ai', name: 'AI', aiLevel: 'amateur' }
const P = (x: number, y: number): Pos => ({ x, y })

/** 构造一局走法二 + 两次交换 + 黑五连的对局 */
function buildGame() {
  let s = newGame([human, ai], 0)
  const step = (ev: Parameters<typeof applyEvent>[1]) => {
    const r = applyEvent(s, ev)
    if (!r.result.ok) throw new Error(r.result.error)
    s = r.state
  }
  step({ type: 'move', pos: P(7, 7) })
  step({ type: 'swap', accept: true }) // 交换 → AI 执黑
  step({ type: 'move', pos: P(8, 7) })
  step({ type: 'swap', accept: false })
  step({ type: 'move', pos: P(8, 8) })
  step({ type: 'swap', accept: true }) // 再交换 → 玩家执黑
  step({ type: 'move', pos: P(9, 8) })
  step({ type: 'variant', variant: 2 }) // 走法二：无第 4 手交换
  step({
    type: 'offers',
    points: Array.from({ length: 10 }, (_, i) => P(i + 3, 4))
  })
  step({ type: 'pick', index: 4 }) // 白选 (7,4) 为第 5 手
  step({ type: 'move', pos: P(3, 3) }) // 第 6 手
  // 中盘：黑 (7,7)(8,8) + AI 白 (8,7)(9,8)(3,3)(7,4)
  // 黑沿对角线连五
  step({ type: 'move', pos: P(9, 9) })
  step({ type: 'move', pos: P(4, 3) })
  step({ type: 'move', pos: P(6, 6) })
  step({ type: 'move', pos: P(5, 3) })
  step({ type: 'move', pos: P(10, 10) }) // 黑五连
  return s
}

describe('棋谱 JSON 序列化', () => {
  it('全量信息序列化/反序列化往返一致', () => {
    const s = buildGame()
    expect(s.result?.reason).toBe('five')
    const rec = serializeRecord(s)
    const json = JSON.stringify(rec)
    const back = deserializeRecord(JSON.parse(json))
    expect(back.ok).toBe(true)
    const s2 = back.state!
    expect(s2.moves.length).toBe(s.moves.length)
    expect(s2.blackOwner).toBe(s.blackOwner)
    expect(s2.variant).toBe(s.variant)
    expect(s2.phase).toBe('OVER')
    expect(s2.result?.reason).toBe('five')
    expect(s2.result?.winner).toBe(s.result!.winner)
    // 交换记录完整保留（走法二：E1/E2/E3 共 3 次，其中 2 次接受）
    const swaps = s2.opening.filter((e) => e.action === 'swap-offer')
    expect(swaps.length).toBe(3)
    expect(swaps.filter((e) => e.action === 'swap-offer' && e.decision).length).toBe(2)
    // 十打点信息保留
    const offersEntry = s2.opening.find((e) => e.action === 'ten-offers')
    expect(offersEntry && 'points' in offersEntry ? offersEntry.points.length : 0).toBe(10)
    // 棋盘一致
    expect(s2.board).toEqual(s.board)
  })

  it('无效格式报错', () => {
    expect(
      deserializeRecord({ format: 'other', version: 1 } as unknown as Parameters<typeof deserializeRecord>[0]).ok
    ).toBe(false)
  })

  it('超时结果序列化往返保留 timeout 语义', () => {
    const source = applyEvent(newGame([human, ai], 0), { type: 'timeout', player: 0 })
    expect(source.result.ok).toBe(true)
    const record = serializeRecord(source.state)
    const restored = deserializeRecord(record)
    expect(restored.ok).toBe(true)
    expect(restored.state?.phase).toBe('OVER')
    expect(restored.state?.result?.reason).toBe('timeout')
    expect(restored.state?.result?.winner).toBe(1)
  })

  it('坐标序列化往返', () => {
    expect(posName(P(0, 0))).toBe('A15') // y=0 是顶部 → 行 15
    expect(posName(P(7, 7))).toBe('H8') // 天元不变
    expect(posName(P(8, 6))).toBe('I9') // y=6 → 行 9
    expect(posCode(P(7, 7))).toBe('h8')
    // 新格式（字母+行号，行号从下往上）
    expect(parsePos('H8')).toEqual({ x: 7, y: 7 })
    expect(parsePos('h8')).toEqual({ x: 7, y: 7 })
    expect(parsePos('i9')).toEqual({ x: 8, y: 6 }) // 行 9 → y=6
    // 旧版双字母格式保持可导入（历史棋谱兼容）
    expect(parsePos('hh')).toEqual({ x: 7, y: 7 })
    expect(parsePos('zz')).toBeNull()
  })
})

describe('psq 导入导出', () => {
  it('导出符合 piskvork 格式并可解析回来', () => {
    const s = buildGame()
    const text = exportPsq(s)
    expect(text.split(/\r?\n/)[0]).toBe('Piskvorky 15x15, 0:3, 0')
    const r = parsePsq(text)
    expect(r.ok).toBe(true)
    expect(r.data!.moves.length).toBe(s.moves.length)
    expect(r.data!.moves[0]).toEqual(P(7, 7))
    // 结果码：黑胜 → 假黑方是 players[0]（human）→ 1
    expect(r.data!.errCode).toBe(1)
    // 塔拉山口注释附加在玩家名行
    expect(r.data!.names[0]).toContain('Taraguchi-10')
  })

  it('解析标准 piskvork psq 文件内容', () => {
    const text = [
      'Piskvorky 15x15, 0:0, 0',
      '8,8,0',
      '9,9,0',
      '7,7,0',
      'homo-1',
      'homo-2',
      '0'
    ].join('\r\n')
    const r = parsePsq(text)
    expect(r.ok).toBe(true)
    expect(r.data!.moves).toEqual([P(7, 7), P(8, 8), P(6, 6)])
    expect(r.data!.names).toEqual(['homo-1', 'homo-2'])
  })

  it('坐标越界报错', () => {
    const text = 'Piskvorky 15x15, 0:0, 0\r\n16,8,0\r\n'
    expect(parsePsq(text).ok).toBe(false)
  })

  it('空文件与无着法文件报错', () => {
    expect(parsePsq('').ok).toBe(false)
    expect(parsePsq('Piskvorky 15x15, 0:0, 0').ok).toBe(false)
  })

  it('宽容解析：无头部、只有坐标行', () => {
    const r = parsePsq('8,8\r\n9,9,5\r\n')
    expect(r.ok).toBe(true)
    expect(r.data!.moves).toEqual([P(7, 7), P(8, 8)])
  })
})
