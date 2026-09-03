import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('renju', {
  openFile: (filtersName: 'json' | 'psq') =>
    ipcRenderer.invoke('renju:openFile', filtersName) as Promise<{
      name: string
      contents: string
      error?: string
    } | null>,
  saveFile: (opts: { defaultName: string; contents: string; psq?: boolean }) =>
    ipcRenderer.invoke('renju:saveFile', opts) as Promise<{ name: string; error?: string } | null>
})
