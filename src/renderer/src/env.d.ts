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
}

interface Window {
  renju?: RenjuFileApi
}
