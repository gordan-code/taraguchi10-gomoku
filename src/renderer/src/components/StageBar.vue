<template>
  <div class="stage-bar">
    <div class="stage-track">
      <div
        v-for="(s, i) in stages"
        :key="i"
        class="stage-dot"
        :class="{ done: stageIndex > i, active: stageIndex === i }"
        :title="s"
      >
        <span class="dot"></span>
      </div>
    </div>
    <div class="stage-label">{{ label }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { GameState } from '@shared/index'

const props = defineProps<{ state: GameState }>()

const stages = [
  '第1手',
  '第2手',
  '第3手',
  '第4手',
  '走法选择',
  '第5手',
  '第6手',
  '中盘',
  '终局'
]

const stageIndex = computed(() => {
  switch (props.state.phase) {
    case 'S1_MOVE':
    case 'S1_SWAP':
      return 0
    case 'S2_MOVE':
    case 'S2_SWAP':
      return 1
    case 'S3_MOVE':
    case 'S3_SWAP':
      return 2
    case 'S4_MOVE':
      return 3
    case 'VARIANT_CHOICE':
      return 4
    case 'S4_SWAP':
    case 'V1_S5_MOVE':
    case 'V1_S5_SWAP':
    case 'V2_TEN_OFFER':
    case 'V2_TEN_PICK':
      return 5
    case 'S6_MOVE':
      return 6
    case 'PLAY':
      return 7
    case 'OVER':
      return 8
    default:
      return 0
  }
})

const label = computed(() => {
  const map: Record<string, string> = {
    S1_MOVE: '开局 · 黑落天元',
    S1_SWAP: '开局 · 交换决策（第1手后）',
    S2_MOVE: '开局 · 白落中央 3×3',
    S2_SWAP: '开局 · 交换决策（第2手后）',
    S3_MOVE: '开局 · 黑落中央 5×5',
    S3_SWAP: '开局 · 交换决策（第3手后）',
    S4_MOVE: '开局 · 白落中央 7×7',
    S4_SWAP: '走法一 · 交换决策（第4手后）',
    VARIANT_CHOICE: '开局 · 黑方选择走法一/走法二',
    V1_S5_MOVE: '走法一 · 黑落中央 9×9',
    V1_S5_SWAP: '走法一 · 最后一次交换决策',
    V2_TEN_OFFER: '走法二 · 黑方摆 10 个第5手候选点',
    V2_TEN_PICK: '走法二 · 白方十选一',
    S6_MOVE: '开局 · 白落第6手（任意位置）',
    PLAY: '中盘对弈 · 黑方禁手生效',
    OVER: '对局结束'
  }
  return map[props.state.phase] ?? ''
})
</script>

<style scoped>
.stage-bar {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}
.stage-track {
  display: flex;
  align-items: center;
}
.stage-dot {
  flex: 1;
  display: flex;
  justify-content: center;
  position: relative;
}
.stage-dot::before {
  content: '';
  position: absolute;
  top: 50%;
  left: -50%;
  width: 100%;
  height: 2px;
  background: var(--border);
}
.stage-dot:first-child::before {
  display: none;
}
.stage-dot.done::before {
  background: var(--accent);
}
.stage-dot.active::before {
  background: var(--accent);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--border);
  position: relative;
  z-index: 1;
}
.stage-dot.done .dot {
  background: var(--accent);
}
.stage-dot.active .dot {
  background: var(--accent);
  box-shadow: 0 0 0 4px rgba(255, 170, 0, 0.25);
}
.stage-label {
  margin-top: 8px;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
}
</style>
