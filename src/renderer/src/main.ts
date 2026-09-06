import { createApp } from 'vue'
import App from './App.vue'

// 启动诊断：跨源隔离状态决定 onnxruntime-web 多线程 WASM 是否生效
// （主进程注入 COOP/COEP 后应为 true）
console.log('[env] crossOriginIsolated =', String((self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated))

createApp(App).mount('#app')
