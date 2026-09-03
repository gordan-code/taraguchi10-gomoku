<template>
  <div class="app">
    <header class="toolbar">
      <div class="brand">
        <span class="logo">⚫</span> RenjuMaster <span class="rule-tag">塔拉山口-10</span>
      </div>
      <div class="tools">
        <button class="tbtn primary" @click="showNewGame = true">新对局</button>
        <button class="tbtn" :disabled="!canUndo" @click="undoLast" title="回退到你最近一次决策之前">悔棋</button>
        <button class="tbtn" :disabled="!isHumanTurn || gameOver" @click="resignGame">认输</button>
        <span class="divider"></span>
        <button class="tbtn" @click="importGame(false)">导入 JSON</button>
        <button class="tbtn" @click="importGame(true)">导入 psq</button>
        <button class="tbtn" :disabled="game.moves.length === 0" @click="exportGame(false)">导出 JSON</button>
        <button class="tbtn" :disabled="game.moves.length === 0" @click="exportGame(true)">导出 psq</button>
        <span class="divider"></span>
        <button class="tbtn" :class="{ on: store.settings.showForbidden }" @click="store.settings.showForbidden = !store.settings.showForbidden" title="标记黑方禁手点">
          禁手标记
        </button>
        <button class="tbtn" @click="showHelp = true">规则</button>
        <button class="tbtn" @click="showSettings = true">设置</button>
      </div>
    </header>

    <main class="main">
      <section class="board-area">
        <BoardCanvas
          :board="displayState.board"
          :last-move="lastMove"
          :region-r="regionR"
          :offers="displayState.offers"
          :offer-draft="store.offerDraft"
          :offer-stage="offerStage"
          :win-line="displayState.result?.line ?? null"
          :forbidden-pos="displayState.result?.forbiddenPos ?? null"
          :forbidden-marks="forbiddenMarks"
          :ghost="ghost"
          :ghost-color="ghostColor"
          @cell="clickCell"
          @hover="onHover"
        />
        <ReplayBar
          class="replay"
          :index="store.replayIndex ?? store.snapshots.length - 1"
          :total="store.snapshots.length"
          :autoplay="store.autoplay"
          :live="store.replayIndex === null"
          @go="replayGo"
          @toggle-auto="replayToggleAutoplay"
          @live="replayLive"
        />
      </section>

      <aside class="side">
        <StageBar :state="displayState" />
        <GameClocks
          :players="game.players"
          :black-owner="game.blackOwner"
          :remaining-ms="displayClockRemainingMs"
          :active-player="displayClockActivePlayer"
          :paused="clockIsPaused"
          :replay="store.replayIndex !== null"
          :game-over="gameOver"
          @toggle-pause="toggleGamePause"
        />
        <PlayerCard
          :player="game.players[game.blackOwner]"
          :color="1"
          :is-active="activePlayer === game.blackOwner && !gameOver"
          :thinking="store.aiThinking === game.blackOwner"
        />
        <PlayerCard
          :player="game.players[game.blackOwner === 0 ? 1 : 0]"
          :color="2"
          :is-active="activePlayer === (game.blackOwner === 0 ? 1 : 0) && !gameOver"
          :thinking="store.aiThinking === (game.blackOwner === 0 ? 1 : 0)"
        />
        <ActionPanel
          :state="displayState"
          :kind="panelKind"
          :draft="store.offerDraft.length"
          :reason="store.lastReason"
          @swap="humanSwap"
          @variant="humanVariant"
          @confirm-offers="humanConfirmOffers"
          @clear-offers="store.offerDraft = []"
        />
        <AnalysisPanel
          :state="displayState"
          :report="store.lastReport"
          :eval-trail="store.evalTrail"
        />
        <div v-if="store.mode === 'ai-vs-ai'" class="speed-panel">
          <span class="speed-label">观战速度</span>
          <button
            v-for="sp in [1, 2, 4, 0] as const"
            :key="sp"
            class="sbtn"
            :class="{ on: store.speed === sp }"
            @click="store.speed = sp"
          >
            {{ sp === 0 ? '瞬时' : sp + 'x' }}
          </button>
        </div>
        <div v-if="store.lastReason && store.mode === 'ai-vs-ai'" class="ai-bubble">💡 {{ store.lastReason }}</div>
      </aside>
    </main>

    <footer class="statusbar">
      <span>{{ phaseText }}</span>
      <span class="sep">·</span>
      <span>黑：{{ blackOwnerName }}</span>
      <span class="sep">·</span>
      <span>白：{{ whiteOwnerName }}</span>
      <span class="sep">·</span>
      <span>第 {{ displayState.moves.length }} 手</span>
      <span v-if="store.replayIndex !== null" class="replay-badge">回放模式</span>
    </footer>

    <!-- 禁手确认 -->
    <div v-if="store.confirmForbidden" class="modal-mask" @click.self="store.confirmForbidden = null">
      <div class="modal small">
        <div class="modal-title">⚠️ 禁手警告</div>
        <p class="modal-text">
          该点是黑方<strong>禁手点</strong>。连珠规则下落子即判负（黑方三三 / 四四 / 长连禁用）。
          确认要在此落子吗？
        </p>
        <div class="modal-actions">
          <button class="btn" @click="store.confirmForbidden = null">换个位置</button>
          <button class="btn danger" @click="confirmForbiddenMove">确认落子（判负）</button>
        </div>
      </div>
    </div>

    <NewGameModal v-if="showNewGame" @close="showNewGame = false" />
    <GameOverModal
      v-if="gameOver && !overDismissed && store.replayIndex === null"
      :state="game"
      @close="overDismissed = true"
      @replay="enterReplay"
      @export-json="exportGame(false)"
      @export-psq="exportGame(true)"
      @rematch="rematch"
    />

    <!-- 规则速查 -->
    <div v-if="showHelp" class="modal-mask" @click.self="showHelp = false">
      <div class="modal help">
        <div class="modal-title">塔拉山口-10 规则速查</div>
        <ol class="help-list">
          <li>第 1 手黑落<strong>天元</strong> → <strong>白方</strong>可交换</li>
          <li>第 2 手白落中央 <strong>3×3</strong> → <strong>黑方</strong>可交换</li>
          <li>第 3 手黑落中央 <strong>5×5</strong> → <strong>白方</strong>可交换</li>
          <li>第 4 手白落中央 <strong>7×7</strong> → <strong>走法选择</strong>（黑方二选一）：
            <br />· 走法一：<strong>黑方</strong>可交换（E4）→ 黑落中央 <strong>9×9</strong> → <strong>白方</strong>最后一次交换（E5）→ 白落第 6 手
            <br />· 走法二：黑摆 <strong>10 个第 5 手候选点</strong>（不得中心对称，无第 4/5 手交换）→ 白十选一 → 白落第 6 手
          </li>
          <li>第 6 手起进入中盘：<strong>黑方禁手</strong>（三三 / 四四 / 长连）落子即负；白方无禁手</li>
          <li>黑恰好五连胜；白五连或以上胜（黑长连也为负）</li>
        </ol>
        <div class="modal-actions">
          <button class="btn primary" @click="showHelp = false">知道了</button>
        </div>
      </div>
    </div>

    <!-- 设置 -->
    <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
      <div class="modal">
        <div class="modal-title">设置</div>
        <div class="setting-row">
          <span class="setting-label">搜索线程数</span>
          <div class="thread-opts">
            <button
              v-for="n in [1, 2, 4, 8, 16, 32]"
              :key="n"
              class="sbtn"
              :class="{ on: store.settings.searchThreads === n }"
              @click="store.settings.searchThreads = n"
            >{{ n === 1 ? '单线程' : n + ' 线程' }}</button>
          </div>
        </div>
        <p class="modal-text">多线程仅在 Negamax 引擎下生效；选单线程则关闭并行根拆分。</p>
        <div class="modal-actions">
          <button class="btn primary" @click="showSettings = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <transition name="toast">
      <div v-if="store.toast" class="toast">{{ store.toast }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Pos, idx, regionRadius } from '@shared/index'
import BoardCanvas from './components/BoardCanvas.vue'
import StageBar from './components/StageBar.vue'
import PlayerCard from './components/PlayerCard.vue'
import ActionPanel from './components/ActionPanel.vue'
import AnalysisPanel from './components/AnalysisPanel.vue'
import NewGameModal from './components/NewGameModal.vue'
import GameOverModal from './components/GameOverModal.vue'
import ReplayBar from './components/ReplayBar.vue'
import GameClocks from './components/GameClocks.vue'
import {
  actor,
  autosaveNow,
  blackOwnerName,
  canUndo,
  clockIsPaused,
  displayClockActivePlayer,
  displayClockRemainingMs,
  clickCell,
  confirmForbiddenMove,
  displayState,
  exportGame,
  forbiddenMarks,
  game,
  gameOver,
  humanSwap,
  humanVariant,
  humanConfirmOffers,
  importGame,
  isHumanTurn,
  pauseGame,
  phaseText,
  replayGo,
  replayLive,
  resumeGame,
  replayToggleAutoplay,
  resignGame,
  startNewGame,
  store,
  tryRestore,
  undoLast,
  whiteOwnerName
} from './store/game'

const showNewGame = ref(false)
const showHelp = ref(false)
const showSettings = ref(false)
const overDismissed = ref(false)
const hoverPos = ref<Pos | null>(null)

// 首次进入：尝试恢复未完成对局，否则直接开一局默认人机
const saveBeforeClose = () => autosaveNow()

onMounted(() => {
  window.addEventListener('beforeunload', saveBeforeClose)
  document.addEventListener('visibilitychange', saveBeforeClose)
  if (!tryRestore()) {
    startNewGame({ mode: 'human-vs-ai', side: 'black', engine: 'onnx' })
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', saveBeforeClose)
  document.removeEventListener('visibilitychange', saveBeforeClose)
})

const activePlayer = computed(() => actor.value?.player ?? null)

const lastMove = computed(() => {
  const m = displayState.value.moves
  return m.length > 0 ? m[m.length - 1] : null
})

const regionR = computed(() => regionRadius(displayState.value))

const offerStage = computed<'draft' | 'pick' | 'none'>(() => {
  const s = displayState.value
  if (s.phase === 'V2_TEN_OFFER') {
    // 回放时不展示草稿
    return store.replayIndex === null && store.offerDraft.length > 0 ? 'draft' : 'none'
  }
  if (s.phase === 'V2_TEN_PICK') return 'pick'
  return 'none'
})

const ghostColor = computed<1 | 2>(() => (displayState.value.moves.length % 2 === 0 ? 1 : 2))

const ghost = computed(() => {
  if (!isHumanTurn.value) return null
  const a = actor.value
  if (!a || a.kind !== 'move') return null
  const p = hoverPos.value
  if (!p) return null
  if (displayState.value.board[idx(p.x, p.y)] !== 0) return null
  return p
})

const panelKind = computed<'move' | 'swap' | 'variant' | 'offers' | 'pick' | 'wait'>(() => {
  if (store.replayIndex !== null) return 'wait'
  const a = actor.value
  if (!a || gameOver.value) return 'wait'
  if (store.game.players[a.player].kind === 'human') return a.kind
  return 'wait'
})

const onHover = (p: Pos | null) => {
  hoverPos.value = p
}

const toggleGamePause = () => {
  if (clockIsPaused.value) resumeGame()
  else pauseGame()
}

const enterReplay = () => {
  overDismissed.value = true
  replayGo(0)
}

const rematch = () => {
  overDismissed.value = false
  startNewGame(store.lastConfig)
}

// 结算弹窗在新对局时重置
watch(
  () => game.value.result,
  () => {
    if (!game.value.result) overDismissed.value = false
  }
)

// 回放自动播放
watch(
  () => store.autoplay,
  (on) => {
    if (on) {
      if (store.replayIndex === null) replayGo(0)
      autoplayTimer()
    }
  }
)

let autoTimer: ReturnType<typeof setTimeout> | null = null
const autoplayTimer = () => {
  if (!store.autoplay) return
  if (store.replayIndex === null) return
  if (store.replayIndex >= store.snapshots.length - 1) {
    store.autoplay = false
    return
  }
  autoTimer = setTimeout(() => {
    if (store.autoplay) {
      replayGo((store.replayIndex ?? 0) + 1)
      autoplayTimer()
    }
  }, 700)
}
</script>

<style src="./styles.css"></style>

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
  padding: 22px 24px;
  width: 420px;
  max-width: 92vw;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.modal.small {
  width: 360px;
}
.modal.help {
  width: 460px;
  max-height: 80vh;
  overflow: auto;
}
.modal-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 10px;
}
.modal-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-dim);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.btn {
  padding: 9px 16px;
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
.btn.danger {
  background: #c0392b;
  color: #fff;
  font-weight: 700;
  border-color: #c0392b;
}
.help-list {
  font-size: 13px;
  line-height: 1.9;
  color: var(--text);
  padding-left: 18px;
}
.help-list strong {
  color: var(--accent);
}
.toast {
  position: fixed;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(30, 32, 38, 0.95);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 13px;
  z-index: 200;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  max-width: 70vw;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
.speed-panel {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px;
}
.speed-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-right: 4px;
}
.sbtn {
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.sbtn.on {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 700;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 14px 0;
}
.setting-label {
  font-size: 13px;
  color: var(--text-dim);
  white-space: nowrap;
}
.thread-opts {
  display: flex;
  gap: 6px;
}
.ai-bubble {
  background: rgba(255, 170, 0, 0.08);
  border: 1px solid rgba(255, 170, 0, 0.35);
  color: var(--text);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
}
.replay {
  margin-top: 10px;
}
</style>
