<template>
  <div class="analysis-panel">
    <!-- 引擎统计：深度 / 评估 / 速度 / 节点数 / 用时 -->
    <div class="stats-table">
      <div class="stats-row head">
        <span>深度</span><span>评估</span><span>速度</span><span>节点数</span><span>用时</span>
      </div>
      <div class="stats-row value">
        <span>{{ stats.depth }}</span><span :class="{ nn: isNeural }">{{ stats.eval }}</span><span>{{ stats.speed }}</span><span>{{ stats.nodes }}</span><span>{{ stats.time }}</span>
      </div>
    </div>

    <!-- 引擎附加信息（搜索内核 / 线程数等，report.extra 键值对） -->
    <div v-if="extraText" class="extra-note">{{ extraText }}</div>

    <!-- NN 引擎说明（无搜索树，仅单次前向推理） -->
    <div v-if="isNeural" class="nn-note">
      神经网络：单次前向推理，无搜索树（深度 / 节点数不适用）<template v-if="pickProbText"> · 选中概率 <strong>{{ pickProbText }}%</strong></template>
    </div>

    <div class="sec-grid">
      <!-- 路线 -->
      <div class="sec">
        <span class="sec-label">路线</span>
        <div class="route-text">{{ routeText }}</div>
      </div>

      <!-- 局面代码 -->
      <div class="sec">
        <div class="code-head">
          <span class="sec-label">局面代码</span>
          <span class="copy-btns">
            <button class="cbtn" title="复制局面代码" @click="copyText(codeText)">⧉</button>
            <button class="cbtn" title="复制路线坐标" @click="copyText(routeText)">⧉</button>
          </span>
          <transition name="fade">
            <span v-if="copiedHint" class="copied">{{ copiedHint }}</span>
          </transition>
        </div>
        <div class="code-text">{{ codeText }}</div>
      </div>

      <!-- 评估曲线 -->
      <div class="sec">
        <div class="chart-head">
          <span class="sec-label">评估曲线</span>
          <span class="legend">
            <span class="lg"><i class="dot b"></i>黑棋</span>
            <span class="lg"><i class="dot w"></i>白棋</span>
          </span>
        </div>
        <div v-if="!hasPoints" class="chart-empty">暂无评估数据（AI 落子后生成）</div>
        <svg v-else class="chart" :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="评估曲线">
          <!-- 零基线与纵轴 -->
          <line :x1="PL" :x2="W - PR" :y1="y0" :y2="y0" class="zero-line" />
          <line :x1="PL" :x2="PL" :y1="PT" :y2="PT + plotH" class="axis" />
          <text :x="PL - 5" :y="PT + 4" class="axis-label" text-anchor="end">{{ fmtAxis(yHi) }}</text>
          <text :x="PL - 5" :y="y0 + 3" class="axis-label" text-anchor="end">0</text>
          <text :x="PL - 5" :y="PT + plotH + 4" class="axis-label" text-anchor="end">{{ fmtAxis(yLo) }}</text>
          <!-- 横轴 -->
          <text :x="PL" :y="H - 6" class="axis-label">0</text>
          <text :x="W - PR" :y="H - 6" class="axis-label" text-anchor="end">{{ maxPly }}</text>
          <!-- 曲线 -->
          <polyline v-if="blackPts.length > 1" :points="blackPoly" class="line b-line" />
          <polyline v-if="whitePts.length > 1" :points="whitePoly" class="line w-line" />
          <circle v-for="p in blackPts" :key="'b' + p.ply" :cx="xOf(p.ply)" :cy="yOf(p.score)" r="2.5" class="pt b-pt" />
          <circle v-for="p in whitePts" :key="'w' + p.ply" :cx="xOf(p.ply)" :cy="yOf(p.score)" r="2.5" class="pt w-pt" />
        </svg>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { GameState, posCode, posName } from '@shared/index'
import { AiReport } from '@shared/ai/report'
import type { EvalPoint } from '../store/game'

const props = defineProps<{
  state: GameState
  report?: AiReport | null
  evalTrail?: EvalPoint[]
}>()

// ---------------- 引擎统计 ----------------

const isNeural = computed(() => props.report?.engine === 'neural')

/** NN 引擎的选中概率（report.extra['选中概率']，百分比数值） */
const pickProbText = computed(() => {
  const v = props.report?.extra?.['选中概率']
  return typeof v === 'number' ? String(v) : null
})

/** 引擎附加信息一行文本；NN 的选中概率已在专属说明里展示，这里排除避免重复 */
const extraText = computed(() => {
  const r = props.report
  if (!r?.extra) return ''
  return Object.entries(r.extra)
    .filter(([k]) => !(isNeural.value && k === '选中概率'))
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ')
})

function fmtCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'K'
  return String(Math.round(n))
}

function fmtTime(ms: number): string {
  if (ms < 1_000) return Math.round(ms) + 'ms'
  return (ms / 1_000).toFixed(1) + 's'
}

function fmtEval(score: number, neural: boolean): string {
  if (neural) return (score >= 0 ? '+' : '') + score.toFixed(2)
  return (score >= 0 ? '+' : '') + String(Math.round(score))
}

// 数字计数动画：值变化时在 ~240ms 内缓动逼近，让搜索指标"动起来"
function useAnimatedNumber(source: () => number) {
  const out = ref(0)
  let raf = 0
  let from = 0
  let to = 0
  let t0 = 0
  watch(
    source,
    (v) => {
      from = out.value
      to = v
      t0 = performance.now()
      cancelAnimationFrame(raf)
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / 240)
        const e = 1 - (1 - p) ** 3
        out.value = from + (to - from) * e
        if (p < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    },
    { immediate: true }
  )
  onBeforeUnmount(() => cancelAnimationFrame(raf))
  return out
}

const animDepth = useAnimatedNumber(() => props.report?.depth ?? 0)
const animScore = useAnimatedNumber(() => props.report?.score ?? 0)
const animNodes = useAnimatedNumber(() => props.report?.nodes ?? 0)
const animElapsed = useAnimatedNumber(() => props.report?.elapsedMs ?? 0)

const stats = computed(() => {
  const r = props.report
  const dash = '–'
  const depth = r?.depth != null ? String(Math.round(animDepth.value)) : dash
  const evalText = r?.score != null ? fmtEval(animScore.value, isNeural.value) : dash
  const nodes = r?.nodes != null ? fmtCount(Math.max(0, Math.round(animNodes.value))) : dash
  const speed =
    r?.nodes != null && r?.elapsedMs != null && animElapsed.value > 0
      ? fmtCount(Math.max(0, Math.round(animNodes.value)) / (animElapsed.value / 1_000))
      : dash
  const time = r?.elapsedMs != null ? fmtTime(Math.max(0, animElapsed.value)) : dash
  return { depth, eval: evalText, speed, nodes, time }
})

// ---------------- 路线 / 局面代码 ----------------

const routeText = computed(() => {
  const ms = props.state.moves
  return ms.length > 0 ? ms.map(posName).join('  ') : '–'
})

const codeText = computed(() => {
  const ms = props.state.moves
  return ms.length > 0 ? ms.map(posCode).join('') : '–'
})

const copiedHint = ref('')
let copyTimer: ReturnType<typeof setTimeout> | null = null

async function copyText(text: string): Promise<void> {
  if (!text || text === '–') return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 回退：隐藏 textarea + execCommand
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copiedHint.value = '已复制'
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => (copiedHint.value = ''), 1500)
}

// ---------------- 评估曲线（SVG） ----------------

const W = 288
const H = 150
const PL = 40
const PR = 10
const PT = 12
const PB = 22
const plotW = W - PL - PR
const plotH = H - PT - PB

const pts = computed(() =>
  (props.evalTrail ?? []).filter((e) => e.ply < props.state.moves.length)
)
const hasPoints = computed(() => pts.value.length > 0)

const maxPly = computed(() => Math.max(10, ...pts.value.map((p) => p.ply)))

const yRange = computed(() => {
  const vs = pts.value.map((p) => p.score)
  const lo = Math.min(0, ...vs)
  const hi = Math.max(0, ...vs)
  const pad = Math.max(0.4, (hi - lo) * 0.12)
  return { lo: lo - pad, hi: hi + pad }
})

const yLo = computed(() => yRange.value.lo)
const yHi = computed(() => yRange.value.hi)
const y0 = computed(() => yOf(0))

function xOf(ply: number): number {
  return PL + (ply / maxPly.value) * plotW
}

function yOf(score: number): number {
  const { lo, hi } = yRange.value
  return PT + (1 - (score - lo) / (hi - lo)) * plotH
}

const blackPts = computed(() => pts.value.filter((p) => p.ply % 2 === 0))
const whitePts = computed(() => pts.value.filter((p) => p.ply % 2 === 1))
const blackPoly = computed(() => blackPts.value.map((p) => `${xOf(p.ply).toFixed(1)},${yOf(p.score).toFixed(1)}`).join(' '))
const whitePoly = computed(() => whitePts.value.map((p) => `${xOf(p.ply).toFixed(1)},${yOf(p.score).toFixed(1)}`).join(' '))

function fmtAxis(v: number): string {
  if (Math.abs(v) >= 100) return String(Math.round(v))
  return String(Number(v.toFixed(1)))
}
</script>

<style scoped>
.analysis-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.stats-table {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.stats-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.stats-row.head {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-2);
  padding: 6px 0;
}
.stats-row.value {
  font-size: 13px;
  font-weight: 700;
  padding: 8px 0;
  color: var(--text);
}
.stats-row.value .nn {
  color: var(--accent);
}
.nn-note {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.6;
  background: rgba(255, 170, 0, 0.06);
  border: 1px solid rgba(255, 170, 0, 0.22);
  border-radius: 7px;
  padding: 6px 9px;
}
.nn-note strong {
  color: var(--accent);
}
.extra-note {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 5px 9px;
  line-height: 1.6;
}
/* 宽面板两列（路线 | 局面代码），评估曲线整行；窄处自动折单列 */
.sec-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  align-items: start;
}
.sec-grid .sec:last-child {
  grid-column: 1 / -1;
}
.sec {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sec-label {
  font-size: 12px;
  color: var(--text-dim);
}
.route-text {
  font-size: 12px;
  line-height: 1.8;
  word-spacing: 2px;
  color: var(--text);
  font-family: Consolas, Menlo, monospace;
  max-height: 150px;
  overflow-y: auto;
}
.code-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.copy-btns {
  display: inline-flex;
  gap: 4px;
}
.cbtn {
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-dim);
  border-radius: 5px;
  font-size: 11px;
  padding: 1px 6px;
  cursor: pointer;
}
.cbtn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.copied {
  font-size: 11px;
  color: var(--accent);
}
.code-text {
  font-size: 12px;
  color: var(--text);
  font-family: Consolas, Menlo, monospace;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
  word-break: break-all;
  line-height: 1.6;
  max-height: 110px;
  overflow-y: auto;
}
.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.legend {
  display: inline-flex;
  gap: 10px;
}
.lg {
  font-size: 11px;
  color: var(--text-dim);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}
.dot.b {
  background: #4da3ff;
}
.dot.w {
  background: #3ecf72;
}
.chart {
  display: block;
  width: 100%;
  /* 固定高度：有数据/无数据面板等高，避免棋盘随局面推进被压缩变形 */
  height: 220px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.chart-empty {
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--bg-2);
  border: 1px dashed var(--border);
  border-radius: 8px;
}
.zero-line {
  stroke: var(--border);
  stroke-dasharray: 3 3;
}
.axis {
  stroke: var(--border);
}
.axis-label {
  font-size: 9px;
  fill: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.line {
  fill: none;
  stroke-width: 1.6;
}
.b-line {
  stroke: #4da3ff;
}
.w-line {
  stroke: #3ecf72;
}
.pt.b-pt {
  fill: #4da3ff;
}
.pt.w-pt {
  fill: #3ecf72;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
