<template>
  <section class="clocks" aria-label="对局计时">
    <div class="clocks-head">
      <div>
        <div class="clocks-title">对局计时</div>
        <div class="clocks-sub">双方各 30 分钟</div>
      </div>
      <button
        v-if="!replay && !gameOver"
        class="clock-control"
        :title="paused ? '继续计时' : '暂停计时'"
        :aria-label="paused ? '继续计时' : '暂停计时'"
        @click="$emit('toggle-pause')"
      >
        {{ paused ? '▶' : 'Ⅱ' }}
      </button>
      <span v-else class="clock-state">{{ replay ? '回放' : '终局' }}</span>
    </div>
    <div class="clock-grid">
      <article
        v-for="entry in entries"
        :key="entry.playerIndex"
        class="clock-card"
        :class="[entry.colorClass, entry.alert, { active: entry.active }]"
      >
        <div class="clock-card-head">
          <span class="color-dot" :class="entry.colorClass"></span>
          <span class="color-name">{{ entry.colorName }}</span>
        </div>
        <div class="clock-name" :title="entry.name">{{ entry.name }}</div>
        <div class="clock-value">{{ formatClock(entry.remainingMs) }}</div>
        <div class="clock-status">
          {{ entry.status }}
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Player } from '@shared/index'
import { clockAlert, formatClock } from '../store/clock'
import type { PlayerIndex } from '../store/clock'

const props = defineProps<{
  players: [Player, Player]
  blackOwner: PlayerIndex
  remainingMs: [number, number]
  activePlayer: PlayerIndex | null
  paused: boolean
  replay: boolean
  gameOver: boolean
}>()

defineEmits<{ (event: 'toggle-pause'): void }>()

const entries = computed(() => {
  const whiteOwner: PlayerIndex = props.blackOwner === 0 ? 1 : 0
  return [
    makeEntry(props.blackOwner, 1, '黑方'),
    makeEntry(whiteOwner, 2, '白方')
  ]
})

function makeEntry(playerIndex: PlayerIndex, color: 1 | 2, colorName: string) {
  const remaining = props.remainingMs[playerIndex]
  const active = props.activePlayer === playerIndex && !props.replay && !props.gameOver && !props.paused
  const alert = clockAlert(remaining)
  const status = props.replay
    ? '回放 · 不计时'
    : props.gameOver
      ? '终局'
      : props.paused
        ? '已暂停'
        : alert === 'expired'
          ? '超时'
          : active
            ? '计时中'
            : '等待行动'
  return {
    playerIndex,
    name: props.players[playerIndex].name,
    colorName,
    colorClass: color === 1 ? 'black' : 'white',
    remainingMs: remaining,
    active,
    alert,
    status
  }
}
</script>

<style scoped>
.clocks {
  padding: 2px 0;
}
.clocks-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  margin-bottom: 7px;
}
.clocks-title {
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
}
.clocks-sub {
  color: var(--text-dim);
  font-size: 11px;
  margin-top: 2px;
}
.clock-control {
  width: 30px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-2);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}
.clock-control:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.clock-state {
  color: var(--text-dim);
  font-size: 11px;
}
.clock-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.clock-card {
  min-width: 0;
  padding: 9px 10px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  transition: border-color 0.15s, background 0.15s;
}
.clock-card.active {
  border-color: var(--accent);
  background: rgba(255, 170, 0, 0.08);
}
.clock-card.warning {
  border-color: #d08a24;
}
.clock-card.danger,
.clock-card.expired {
  border-color: #d04343;
  background: rgba(208, 67, 67, 0.08);
}
.clock-card-head {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  font-size: 11px;
}
.color-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.color-dot.black {
  background: #202228;
  border: 1px solid #676a75;
}
.color-dot.white {
  background: #f5f1e8;
  border: 1px solid #b9b4aa;
}
.clock-name {
  margin-top: 5px;
  color: var(--text-dim);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clock-value {
  margin-top: 4px;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.1;
  min-width: 5ch;
}
.clock-card.active .clock-value {
  color: var(--accent);
}
.clock-card.warning .clock-value {
  color: #e5a33d;
}
.clock-card.danger .clock-value,
.clock-card.expired .clock-value {
  color: #ef6969;
}
.clock-status {
  min-height: 15px;
  margin-top: 3px;
  color: var(--text-dim);
  font-size: 10px;
}

@media (max-width: 1100px) {
  .clock-grid {
    grid-template-columns: 1fr;
  }
}
</style>
