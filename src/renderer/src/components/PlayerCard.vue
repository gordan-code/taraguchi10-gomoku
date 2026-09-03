<template>
  <div class="player-card" :class="{ active: isActive, black: color === 1, white: color === 2 }">
    <div class="stone-icon" :class="color === 1 ? 'b' : 'w'"></div>
    <div class="info">
      <div class="name">
        {{ player.name }}
        <span v-if="player.kind === 'ai'" class="tag">AI</span>
      </div>
      <div class="sub">
        <template v-if="isActive">
          <template v-if="thinking">思考中…</template>
          <template v-else>轮到行动</template>
        </template>
        <template v-else>{{ color === 1 ? '执黑' : '执白' }}</template>
      </div>
    </div>
    <div v-if="isActive" class="pulse"></div>
  </div>
</template>

<script setup lang="ts">
import { Player } from '@shared/index'

defineProps<{
  player: Player
  color: 1 | 2
  isActive: boolean
  thinking?: boolean
}>()
</script>

<style scoped>
.player-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  position: relative;
  overflow: hidden;
}
.player-card.active {
  border-color: var(--accent);
}
.stone-icon {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex: none;
}
.stone-icon.b {
  background: radial-gradient(circle at 35% 32%, #4a4d55, #14161b 70%);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
}
.stone-icon.w {
  background: radial-gradient(circle at 35% 32%, #ffffff, #d9d5ca 75%);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}
.info {
  min-width: 0;
}
.name {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag {
  font-size: 10px;
  background: var(--accent);
  color: #221600;
  border-radius: 4px;
  padding: 1px 4px;
  margin-left: 4px;
  vertical-align: 1px;
}
.sub {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
}
.pulse {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent);
  opacity: 0.9;
}
</style>
