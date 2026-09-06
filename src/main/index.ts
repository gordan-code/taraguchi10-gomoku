import { app, BrowserWindow, ipcMain, dialog, protocol, session } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join, normalize, sep, extname } from 'path'

/**
 * 跨源隔离（COOP/COEP）：启用 SharedArrayBuffer，
 * onnxruntime-web 的多线程 WASM 后端（numThreads）依赖它。
 * - 生产：app:// 协议的每个响应都带隔离头 + CORP
 * - 开发：Vite dev server (http://localhost:5173) 经 webRequest 注入
 * COEP 用 credentialless：Chromium 支持且不要求跨源子资源带 CORP，兼容性最好。
 */
const ISOLATION_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

/**
 * 生产环境下渲染进程通过 `file://` 加载，而 Chromium 禁止 `file://` 页面
 * 创建 ES Module Worker（CORS 会因 origin 为 null 而失败），导致 AI 无法运行。
 * 这里注册一个特权 `app://` 协议把打包产物作为标准源提供，
 * 使 import.meta.url / Worker / fetch 都具备正常的同源语义。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

const RENDERER_DIR = join(__dirname, '../renderer')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
}

function resolveRendererFile(pathname: string): string {
  let p = decodeURIComponent(pathname)
  if (p === '/' || p === '') p = '/index.html'
  const filePath = normalize(join(RENDERER_DIR, p))
  if (filePath !== RENDERER_DIR && !filePath.startsWith(RENDERER_DIR + sep)) {
    throw new Error('拒绝越界路径: ' + p)
  }
  return filePath
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    title: 'RenjuMaster 连珠大师',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`)
  })
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadURL('app://renderer/index.html')
  }
}

app.whenReady().then(() => {
  // 开发模式：给 Vite dev server 的响应注入隔离头
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith('http://localhost:') || details.url.startsWith('http://127.0.0.1:')) {
      callback({ responseHeaders: { ...details.responseHeaders, ...ISOLATION_HEADERS } })
    } else {
      callback({})
    }
  })

  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    const filePath = resolveRendererFile(url.pathname)
    try {
      const data = readFileSync(filePath)
      const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      return new Response(data, { headers: { 'Content-Type': mime, ...ISOLATION_HEADERS } })
    } catch (err) {
      console.error('[protocol] 读取失败', filePath, String(err))
      return new Response('Not Found', { status: 404, headers: { ...ISOLATION_HEADERS } })
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---- 文件读写 IPC：棋谱导入导出 ----

ipcMain.handle('renju:openFile', async (_e, filtersName: string) => {
  const filters =
    filtersName === 'psq'
      ? [{ name: 'Renju psq 棋谱', extensions: ['psq', 'txt'] }]
      : [{ name: 'RenjuMaster 棋谱', extensions: ['json'] }]
  const r = await dialog.showOpenDialog({
    title: '导入棋谱',
    properties: ['openFile'],
    filters
  })
  if (r.canceled || r.filePaths.length === 0) return null
  try {
    const contents = readFileSync(r.filePaths[0], 'utf-8')
    return { name: r.filePaths[0], contents }
  } catch (err) {
    return { name: r.filePaths[0], contents: '', error: String(err) }
  }
})

ipcMain.handle('renju:saveFile', async (_e, opts: { defaultName: string; contents: string; psq?: boolean }) => {
  const r = await dialog.showSaveDialog({
    title: '导出棋谱',
    defaultPath: opts.defaultName,
    filters: opts.psq
      ? [{ name: 'Renju psq 棋谱', extensions: ['psq'] }]
      : [{ name: 'RenjuMaster 棋谱', extensions: ['json'] }]
  })
  if (r.canceled || !r.filePath) return null
  try {
    writeFileSync(r.filePath, opts.contents, 'utf-8')
    return { name: r.filePath }
  } catch (err) {
    return { name: r.filePath, error: String(err) }
  }
})
