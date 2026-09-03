<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-title">{{ title }}</div>
      <p class="desc">{{ desc }}</p>
      <div v-if="lineInfo" class="line-info">{{ lineInfo }}</div>
      <div class="modal-actions">
        <button class="btn" @click="$emit('close')">关闭</button>
        <button class="btn" @click="$emit('replay')">复盘回放</button>
        <button class="btn" @click="$emit('export-json')">导出 JSON</button>
        <button class="btn" @click="$emit('export-psq')">导出 psq</button>
        <button class="btn primary" @click="$emit('rematch')">再来一局</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { GameState } from '@shared/index'

const props = defineProps<{ state: GameState }>()
defineEmits<{
  (e: 'close'): void
  (e: 'replay'): void
  (e: 'export-json'): void
  (e: 'export-psq'): void
  (e: 'rematch'): void
}>()

const REASONS: Record<string, string> = {
  five: '五连',
  overline: '长连',
  forbidden: '禁手判负',
  resign: '认输',
  timeout: '超时',
  draw: '满盘和棋'
}

const title = computed(() => {
  const r = props.state.result
  if (!r) return '对局结束'
  if (r.winner === null) return '和棋'
  const winnerName = props.state.players[r.winner].name
  return `${winnerName} 获胜`
})

const desc = computed(() => {
  const r = props.state.result
  if (!r) return ''
  if (r.winner === null) return '棋盘落满，双方未分胜负。'
  const reason = REASONS[r.reason] ?? r.reason
  const winColor = r.winner === props.state.blackOwner ? '黑' : '白'
  return `${winColor}方${r.reason === 'forbidden' ? '触犯禁手' : ''}获胜（${reason}${r.comment ? ' · ' + r.comment : ''}）`
})

const lineInfo = computed(() => {
  const r = props.state.result
  if (!r || !r.line || r.line.length === 0) return null
  const toName = (p: { x: number; y: number }) =>
    String.fromCharCode(97 + p.x) + String(15 - p.y)
  return `获胜连线：${r.line.map(toName).join(' ')}`
})
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  width: 440px;
  max-width: 92vw;
  padding: 22px 24px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.modal-title {
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 8px;
  color: var(--accent);
}
.desc {
  font-size: 14px;
  color: var(--text);
  margin-bottom: 6px;
}
.line-info {
  font-size: 12px;
  color: var(--text-dim);
  font-family: monospace;
  background: var(--bg-2);
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 6px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
  flex-wrap: wrap;
}
.btn {
  padding: 9px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: var(--accent);
  color: #221600;
  font-weight: 700;
  border-color: var(--accent);
}
</style>
