<template>
  <div class="action-panel">
    <!-- 交换决策 -->
    <template v-if="kind === 'swap'">
      <div class="panel-title">交换决策</div>
      <p class="hint">
        对方刚下完第 {{ state.moves.length }} 手，交换权归你。你现在{{
          deciderIsBlack ? '执黑' : '执白'
        }}：<strong>交换</strong> = 双方颜色互换（{{ deciderIsBlack ? '你让出黑棋、改执白' : '你接管黑棋' }}），<strong>不交换</strong> = {{ deciderIsBlack ? '维持执黑' : '维持执白' }}。决策不可单方面反悔（悔棋可整体回退）。
      </p>
      <div class="btn-row">
        <button class="btn primary" @click="$emit('swap', true)">
          交换{{ deciderIsBlack ? '执白' : '执黑' }}
        </button>
        <button class="btn" @click="$emit('swap', false)">
          {{ deciderIsBlack ? '保持执黑' : '保持执白' }}
        </button>
      </div>
    </template>

    <!-- 走法选择 -->
    <template v-else-if="kind === 'variant'">
      <div class="panel-title">第 5 手走法选择</div>
      <p class="hint">黑方自由选择第 5 手的下法，这是塔拉山口-10 的核心博弈点：</p>
      <div class="variant-cards">
        <button class="variant-card" @click="$emit('variant', 1)">
          <div class="v-title">走法一 · 直接落子</div>
          <div class="v-desc">在中央 9×9 内落第 5 手；对方仍有最后一次交换权，可能被抢走好局</div>
        </button>
        <button class="variant-card" @click="$emit('variant', 2)">
          <div class="v-title">走法二 · 十打点报价</div>
          <div class="v-desc">摆出 10 个第 5 手候选点，对方十选一后不再交换；开局确定性强</div>
        </button>
      </div>
    </template>

    <!-- 十打点摆放 -->
    <template v-else-if="kind === 'offers'">
      <div class="panel-title">摆出 10 个第 5 手候选点</div>
      <p class="hint">
        点击棋盘任意空点摆放候选点（带编号）。任意两点不得关于天元对称。已摆
        <strong>{{ draft }}</strong> / 10 个。
      </p>
      <div class="btn-row">
        <button class="btn" :disabled="draft === 0" @click="$emit('clear-offers')">清空重摆</button>
        <button class="btn primary" :disabled="draft !== 10" @click="$emit('confirm-offers')">
          确认报价（{{ draft }}/10）
        </button>
      </div>
    </template>

    <!-- 十选一 -->
    <template v-else-if="kind === 'pick'">
      <div class="panel-title">十选一</div>
      <p class="hint">黑方摆出了 10 个第 5 手候选点，点击棋盘上带光圈的编号点，选定其中一个作为实际第 5 手（黑子），然后你落第 6 手。</p>
    </template>

    <!-- 落子提示 -->
    <template v-else-if="kind === 'move'">
      <div class="panel-title">{{ state.phase === 'PLAY' ? '轮到你落子' : '开局落子' }}</div>
      <p class="hint">{{ moveHint }}</p>
    </template>

    <!-- AI 思考 / 等待 -->
    <template v-else>
      <div class="panel-title">{{ state.phase === 'OVER' ? '对局结束' : '等待对方…' }}</div>
      <p class="hint" v-if="reason">{{ reason }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { GameState, currentActor, regionRadius } from '@shared/index'

const props = defineProps<{
  state: GameState
  kind: 'move' | 'swap' | 'variant' | 'offers' | 'pick' | 'wait'
  draft?: number
  reason?: string
}>()

defineEmits<{
  (e: 'swap', accept: boolean): void
  (e: 'variant', v: 1 | 2): void
  (e: 'confirm-offers'): void
  (e: 'clear-offers'): void
}>()

const draft = computed(() => props.draft ?? 0)

/** 当前行使交换权的一方是否执黑（决定面板文案：黑方交换=让出黑棋） */
const deciderIsBlack = computed(() => {
  const a = currentActor(props.state)
  return a !== null && props.state.blackOwner === a.player
})
const moveHint = computed(() => {
  const r = regionRadius(props.state)
  const color = props.state.moves.length % 2 === 0 ? '黑' : '白'
  if (r === 0) return '第 1 手：点击天元（棋盘中心）落子。'
  if (r === 1) return '第 2 手：须落在高亮的中央 3×3 区域内。'
  if (r === 2) return '第 3 手：须落在高亮的中央 5×5 区域内。'
  if (r === 3) return '第 4 手：须落在高亮的中央 7×7 区域内。'
  if (r === 4) return '第 5 手（走法一）：须落在高亮的中央 9×9 区域内。'
  if (props.state.phase === 'S6_MOVE') return '第 6 手：可落在棋盘任意空点。'
  if (props.state.phase === 'PLAY')
    return props.state.moves.length % 2 === 0
      ? '你执黑落子。注意：三三 / 四四 / 长连为禁手（红 × 标记点），落子即判负。'
      : '你执白落子。白方无禁手，五连或以上即胜。'
  return `${color}方落子。`
})
</script>

<style scoped>
.action-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
}
.panel-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--accent);
}
.hint {
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.6;
  margin-bottom: 10px;
}
.btn-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.btn {
  flex: 1;
  min-width: 100px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn:hover:not(:disabled) {
  border-color: var(--accent);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.primary {
  background: var(--accent);
  color: #221600;
  font-weight: 700;
  border-color: var(--accent);
}
.variant-cards {
  display: grid;
  gap: 8px;
}
.variant-card {
  text-align: left;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s;
}
.variant-card:hover {
  border-color: var(--accent);
  background: rgba(255, 170, 0, 0.08);
}
.v-title {
  font-weight: 700;
  font-size: 13px;
  margin-bottom: 4px;
}
.v-desc {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
}
</style>
