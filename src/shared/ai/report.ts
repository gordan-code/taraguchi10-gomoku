/**
 * AI 决策的"可解释"报告：以结构化字段承载搜索/评估信息，供 UI 展示。
 *
 * 设计原则（面向后续引擎迭代）：
 * - 字段全部可选：不同引擎填充不同字段，UI 按「引擎 + 字段是否存在」渲染，不写死。
 * - `engine` 标识算法族；`extra` 承载引擎特有键值（UCT 的访问次数/胜率、RL 的策略/价值等）。
 * - 新增引擎只需：1) 在决策入口填一个 `AiReport`；2) 若需要中文名，往 ENGINE_NAMES 补一条。
 */
export interface AiReport {
  /** 引擎标识：'negamax' | 'static-eval' | 'uct' | 'rl' | 自定义字符串 */
  engine: string
  /** 黑方视角评分（正=黑优）；不同引擎语义不同，由 UI 按 engine 解读 */
  score?: number
  /** 搜索深度（negamax=迭代加深达成深度；UCT=树深/模拟深度） */
  depth?: number
  /** 搜索节点数（negamax/UCT 有意义；RL 可缺省） */
  nodes?: number
  /** 思考耗时（毫秒），由决策入口统一计时填充 */
  elapsedMs?: number
  /** 是否超时截断 */
  timedOut?: boolean
  /** 引擎特有扩展字段，UI 按 key 决定展示（未知 key 原样兜底展示） */
  extra?: Record<string, string | number | boolean>
}

/** 引擎中文名映射；未知引擎回退为原始 engine 字符串 */
export const ENGINE_NAMES: Record<string, string> = {
  negamax: 'Negamax α-β',
  'static-eval': '静态评估',
  uct: 'UCT 蒙特卡洛树搜索',
  rl: '强化学习',
  neural: '神经网络（ONNX）',
  book: '开局库'
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatScore(score: number): string {
  return `${score > 0 ? '+' : ''}${Math.round(score)}`
}

/**
 * 把报告转成「标签-值」行列表，UI 直接遍历渲染。
 * 好处：未来引擎只要换 `engine` 与填充字段/`extra`，无需改 UI 渲染逻辑。
 */
export function describeReport(report: AiReport): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = []
  lines.push({ label: '引擎', value: ENGINE_NAMES[report.engine] ?? report.engine })
  if (report.score != null) lines.push({ label: '评分', value: formatScore(report.score) })
  if (report.depth != null) lines.push({ label: '深度', value: String(report.depth) })
  if (report.nodes != null) lines.push({ label: '节点', value: report.nodes.toLocaleString() })
  if (report.elapsedMs != null) lines.push({ label: '用时', value: formatMs(report.elapsedMs) })
  if (report.timedOut) lines.push({ label: '状态', value: '超时截断' })
  for (const [k, v] of Object.entries(report.extra ?? {})) {
    lines.push({ label: k, value: String(v) })
  }
  return lines
}
