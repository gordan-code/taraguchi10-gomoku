<template>
  <div class="replay-bar" v-if="visible">
    <button class="rbtn" title="回到开局" :disabled="index <= 0" @click="$emit('go', 0)">⏮</button>
    <button class="rbtn" title="上一手" :disabled="index <= 0" @click="$emit('go', index - 1)">◀</button>
    <span class="pos">{{ indexLabel }}</span>
    <button class="rbtn" title="下一手" :disabled="index >= total - 1" @click="$emit('go', index + 1)">▶</button>
    <button class="rbtn" title="跳到最新" :disabled="index >= total - 1" @click="$emit('go', total - 1)">⏭</button>
    <button class="rbtn play" :class="{ on: autoplay }" title="自动播放" @click="$emit('toggle-auto')">
      {{ autoplay ? '⏸' : '▶▶' }}
    </button>
    <button class="rbtn live" v-if="!liveOnly" @click="$emit('live')">回到当前</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  index: number
  total: number
  autoplay: boolean
  live: boolean
}>()

defineEmits<{ (e: 'go', i: number): void; (e: 'toggle-auto'): void; (e: 'live'): void }>()

const visible = computed(() => props.total > 1)
const indexLabel = computed(() => `${props.index + 1} / ${props.total}`)
const liveOnly = computed(() => props.live)
</script>

<style scoped>
.replay-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px;
  justify-content: center;
}
.rbtn {
  width: 32px;
  height: 30px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
}
.rbtn:hover:not(:disabled) {
  border-color: var(--accent);
}
.rbtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.rbtn.play.on {
  background: var(--accent);
  color: #221600;
}
.rbtn.live {
  width: auto;
  padding: 0 10px;
  font-size: 12px;
}
.pos {
  font-size: 12px;
  color: var(--text-dim);
  min-width: 64px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
</style>
