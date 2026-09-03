<template>
  <div ref="wrap" class="board-wrap">
    <canvas
      ref="cv"
      :width="cssSize * dpr"
      :height="cssSize * dpr"
      :style="{ width: cssSize + 'px', height: cssSize + 'px' }"
      @click="onClick"
      @mousemove="onMove"
      @mouseleave="onLeave"
    />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import { Board, CENTER, Pos, SIZE, Stone, idx } from '@shared/index'

const props = withDefaults(  defineProps<{
    board: Board
    lastMove?: Pos | null
    regionR?: number | null
    offers?: Pos[]
    offerDraft?: Pos[]
    pickable?: boolean
    winLine?: Pos[] | null
    forbiddenPos?: Pos | null
    forbiddenMarks?: Pos[]
    ghost?: Pos | null
    ghostColor?: 1 | 2
    offerStage?: 'draft' | 'pick' | 'none'
  }>(),
  {
    lastMove: null,
    regionR: null,
    offers: () => [],
    offerDraft: () => [],
    pickable: false,
    winLine: null,
    forbiddenPos: null,
    forbiddenMarks: () => [],
    ghost: null,
    ghostColor: 1,
    offerStage: 'none'
  }
)

const emit = defineEmits<{ (e: 'cell', pos: Pos): void; (e: 'hover', pos: Pos | null): void }>()

const wrap = ref<HTMLDivElement | null>(null)
const cv = ref<HTMLCanvasElement | null>(null)
const cssSize = ref(600)
const dpr = window.devicePixelRatio || 1

let ro: ResizeObserver | null = null

onMounted(() => {
  ro = new ResizeObserver(() => {
    const el = wrap.value
    if (!el) return
    cssSize.value = Math.max(300, Math.min(el.clientWidth, el.clientHeight))
  })
  if (wrap.value) ro.observe(wrap.value)
})

onBeforeUnmount(() => ro?.disconnect())

const metrics = () => {
  const s = cssSize.value
  const cell = s / (SIZE + 1)
  const origin = cell
  return { cell, origin }
}

const posFromEvent = (e: MouseEvent): Pos | null => {
  const canvas = cv.value
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  const { cell, origin } = metrics()
  const x = Math.round((e.clientX - rect.left - origin) / cell)
  const y = Math.round((e.clientY - rect.top - origin) / cell)
  if (x < 0 || x > 14 || y < 0 || y > 14) return null
  return { x, y }
}

const onClick = (e: MouseEvent) => {
  const p = posFromEvent(e)
  if (p) emit('cell', p)
}
const onMove = (e: MouseEvent) => {
  emit('hover', posFromEvent(e))
}
const onLeave = () => emit('hover', null)

const stoneAt = (x: number, y: number): Stone => props.board[idx(x, y)]

/**
 * 绘制必须用 post-flush：Vue 更新 canvas 的 width/height 属性会清空位图，
 * 若在 DOM 补丁前绘制（pre-flush），画完即被清空。
 * 显式声明依赖（不依赖 watchEffect 自动收集，draw 内部访问 props 亦会收集，这里保持直观）。
 */
watchEffect(
  () => {
    void cssSize.value
    void props.board
    void props.lastMove
    void props.regionR
    void props.offers
    void props.offerDraft
    void props.pickable
    void props.winLine
    void props.forbiddenPos
    void props.forbiddenMarks
    void props.ghost
    void props.ghostColor
    void props.offerStage
    draw()
  },
  { flush: 'post' }
)

function draw(): void {
  const canvas = cv.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const s = cssSize.value
  const { cell, origin } = metrics()
  const X = (x: number) => origin + x * cell
  const Y = (y: number) => origin + y * cell

  ctx.save()
  ctx.scale(dpr, dpr)

  // 背景
  ctx.fillStyle = '#d9a868'
  ctx.fillRect(0, 0, s, s)
  // 木纹质感（简单横线）
  ctx.strokeStyle = 'rgba(120,72,20,0.08)'
  ctx.lineWidth = 1
  for (let i = 0; i < 40; i++) {
    ctx.beginPath()
    ctx.moveTo(0, (i * s) / 40 + 3)
    ctx.lineTo(s, (i * s) / 40)
    ctx.stroke()
  }

  // 区域高亮
  if (props.regionR !== null) {
    const r = props.regionR
    const p0 = { x: CENTER.x - r, y: CENTER.y - r }
    const p1 = { x: CENTER.x + r, y: CENTER.y + r }
    ctx.fillStyle = 'rgba(255,215,0,0.10)'
    ctx.fillRect(X(p0.x) - cell / 2, Y(p0.y) - cell / 2, (p1.x - p0.x + 1) * cell, (p1.y - p0.y + 1) * cell)
    ctx.strokeStyle = 'rgba(180,120,0,0.55)'
    ctx.setLineDash([6, 4])
    ctx.lineWidth = 2
    ctx.strokeRect(X(p0.x) - cell / 2, Y(p0.y) - cell / 2, (p1.x - p0.x + 1) * cell, (p1.y - p0.y + 1) * cell)
    ctx.setLineDash([])
  }

  // 网格
  ctx.strokeStyle = '#5b3a17'
  ctx.lineWidth = 1
  for (let i = 0; i < SIZE; i++) {
    ctx.beginPath()
    ctx.moveTo(X(0), Y(i))
    ctx.lineTo(X(14), Y(i))
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(X(i), Y(0))
    ctx.lineTo(X(i), Y(14))
    ctx.stroke()
  }
  // 边框加粗
  ctx.lineWidth = 2
  ctx.strokeRect(X(0), Y(0), X(14) - X(0), Y(14) - Y(0))

  // 星位
  ctx.fillStyle = '#5b3a17'
  for (const [sx, sy] of [
    [3, 3],
    [11, 3],
    [3, 11],
    [11, 11],
    [7, 7]
  ]) {
    ctx.beginPath()
    ctx.arc(X(sx), Y(sy), cell * 0.09, 0, Math.PI * 2)
    ctx.fill()
  }

  // 坐标
  ctx.fillStyle = 'rgba(60,35,10,0.75)'
  ctx.font = `${Math.max(9, cell * 0.28)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < 15; i++) {
    ctx.fillText(String.fromCharCode(97 + i), X(i), Y(0) - cell * 0.75)
    ctx.fillText(String(15 - i), X(0) - cell * 0.8, Y(i))
  }

  // 禁手标记（空点红 ×）
  if (props.forbiddenMarks.length > 0) {
    ctx.strokeStyle = 'rgba(200,30,30,0.55)'
    ctx.lineWidth = 2
    for (const p of props.forbiddenMarks) {
      const cx = X(p.x)
      const cy = Y(p.y)
      const r = cell * 0.18
      ctx.beginPath()
      ctx.moveTo(cx - r, cy - r)
      ctx.lineTo(cx + r, cy + r)
      ctx.moveTo(cx + r, cy - r)
      ctx.lineTo(cx - r, cy + r)
      ctx.stroke()
    }
  }

  // 棋子
  const drawStone = (p: Pos, color: 1 | 2, scale = 1, alpha = 1) => {
    const cx = X(p.x)
    const cy = Y(p.y)
    const r = cell * 0.42 * scale
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = color === 1 ? '#16181d' : '#f4f2ec'
    ctx.fill()
    if (color === 1) {
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r)
      g.addColorStop(0, 'rgba(255,255,255,0.35)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fill()
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.restore()
  }

  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const st = stoneAt(x, y)
      if (st === 0) continue
      drawStone({ x, y }, st as 1 | 2)
    }
  }

  // 十打点（草稿阶段：编号小黑子）
  if (props.offerStage === 'draft') {
    props.offerDraft.forEach((p, i) => {
      drawStone(p, 1, 0.62)
      ctx.fillStyle = '#fff'
      ctx.font = `bold ${Math.max(10, cell * 0.3)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), X(p.x), Y(p.y) + 1)
    })
  }

  // 正式 offers（十选一阶段：呼吸光圈编号子）
  if (props.offerStage === 'pick') {
    props.offers.forEach((p, i) => {
      ctx.save()
      ctx.beginPath()
      ctx.arc(X(p.x), Y(p.y), cell * 0.5, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,170,0,0.9)'
      ctx.lineWidth = 2.5
      ctx.stroke()
      ctx.restore()
      drawStone(p, 1, 0.85)
      ctx.fillStyle = '#ffd24d'
      ctx.font = `bold ${Math.max(10, cell * 0.3)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), X(p.x), Y(p.y) + 1)
    })
  }

  // 最后一手标记
  if (props.lastMove) {
    const p = props.lastMove
    const st = stoneAt(p.x, p.y)
    ctx.beginPath()
    ctx.arc(X(p.x), Y(p.y), cell * 0.14, 0, Math.PI * 2)
    ctx.fillStyle = st === 1 ? '#ff5544' : '#2255aa'
    ctx.fill()
  }

  // 获胜五连高亮
  if (props.winLine && props.winLine.length > 0) {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,80,60,0.95)'
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(X(props.winLine[0].x), Y(props.winLine[0].y))
    ctx.lineTo(X(props.winLine[props.winLine.length - 1].x), Y(props.winLine[props.winLine.length - 1].y))
    ctx.stroke()
    ctx.restore()
  }

  // 禁手判负标记
  if (props.forbiddenPos) {
    const p = props.forbiddenPos
    ctx.save()
    ctx.strokeStyle = '#e02020'
    ctx.lineWidth = 4
    const r = cell * 0.3
    ctx.beginPath()
    ctx.moveTo(X(p.x) - r, Y(p.y) - r)
    ctx.lineTo(X(p.x) + r, Y(p.y) + r)
    ctx.moveTo(X(p.x) + r, Y(p.y) - r)
    ctx.lineTo(X(p.x) - r, Y(p.y) + r)
    ctx.stroke()
    ctx.restore()
  }

  // 悬停预览
  if (props.ghost) {
    const p = props.ghost
    if (stoneAt(p.x, p.y) === 0) {
      const illegal =
        props.ghostColor === 1 && props.forbiddenMarks.some((m) => m.x === p.x && m.y === p.y)
      drawStone(p, props.ghostColor, 0.9, illegal ? 0.25 : 0.45)
      if (illegal) {
        ctx.strokeStyle = 'rgba(220,20,20,0.9)'
        ctx.lineWidth = 3
        const r = cell * 0.25
        ctx.beginPath()
        ctx.moveTo(X(p.x) - r, Y(p.y) - r)
        ctx.lineTo(X(p.x) + r, Y(p.y) + r)
        ctx.moveTo(X(p.x) + r, Y(p.y) - r)
        ctx.lineTo(X(p.x) - r, Y(p.y) + r)
        ctx.stroke()
      }
    }
  }

  ctx.restore()
}
</script>

<style scoped>
.board-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}
canvas {
  border-radius: 8px;
  box-shadow:
    0 6px 24px rgba(0, 0, 0, 0.35),
    0 0 0 1px rgba(90, 55, 15, 0.4);
  cursor: pointer;
}
</style>
