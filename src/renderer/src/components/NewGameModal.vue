<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-title">开始新对局</div>
      <div class="field">
        <label>对弈模式</label>
        <div class="seg">
          <button :class="{ on: mode === 'human-vs-ai' }" @click="mode = 'human-vs-ai'">人机对弈</button>
          <button :class="{ on: mode === 'ai-vs-ai' }" @click="mode = 'ai-vs-ai'">AI 观战（AI vs AI）</button>
        </div>
      </div>
      <div class="field" v-if="mode === 'human-vs-ai'">
        <label>你的执子（开局身份）</label>
        <div class="seg">
          <button :class="{ on: side === 'black' }" @click="side = 'black'">执黑（先落天元）</button>
          <button :class="{ on: side === 'white' }" @click="side = 'white'">执白</button>
          <button :class="{ on: side === 'random' }" @click="side = 'random'">随机</button>
        </div>
        <p class="note">开局阶段双方均可通过"交换"改变执子身份，此处仅决定初始假黑/假白。</p>
      </div>
      <div class="field">
        <label>AI 引擎</label>
        <div class="seg">
          <button :class="{ on: engine === 'onnx' }" @click="engine = 'onnx'">神经网络（ONNX）</button>
          <button :class="{ on: engine === 'negamax' }" @click="engine = 'negamax'">Negamax 搜索</button>
        </div>
        <p class="note">Negamax 战术精准、可解释；ONNX 用训练出的网络（棋力取决于当前快照）。</p>
      </div>
      <div class="modal-actions">
        <button class="btn" @click="$emit('close')">取消</button>
        <button class="btn primary" @click="confirm">开始对局</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { AiEngine } from '@shared/index'
import { Mode, SideChoice, startNewGame } from '../store/game'

const emit = defineEmits<{ (e: 'close'): void }>()

const mode = ref<Mode>('human-vs-ai')
const side = ref<SideChoice>('black')
const engine = ref<AiEngine>('onnx')

const confirm = () => {
  startNewGame({ mode: mode.value, side: side.value, engine: engine.value })
  emit('close')
}
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
  width: 420px;
  max-width: 92vw;
  padding: 20px 22px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.modal-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 16px;
}
.field {
  margin-bottom: 14px;
}
.field label {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.note {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 6px;
  line-height: 1.5;
}
.seg {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.seg button {
  flex: 1;
  min-width: 80px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}
.seg button.on {
  border-color: var(--accent);
  background: rgba(255, 170, 0, 0.15);
  color: var(--accent);
  font-weight: 700;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.btn {
  padding: 9px 18px;
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
