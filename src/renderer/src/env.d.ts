/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface RenjuFileApi {
  openFile: (
    filtersName: 'json' | 'psq'
  ) => Promise<{ name: string; contents: string; error?: string } | null>
  saveFile: (opts: {
    defaultName: string
    contents: string
    psq?: boolean
  }) => Promise<{ name: string; error?: string } | null>
  rapfiMove: (req: {
    board: number[]
    color: 1 | 2
    timeMs: number
  }) => Promise<{ ok: true; pos: { x: number; y: number } } | { ok: false; error: string }>
  rapfiStop: () => Promise<void>
}

interface Window {
  renju?: RenjuFileApi
}
