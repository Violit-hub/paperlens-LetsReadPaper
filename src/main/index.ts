import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 主进程日志。Windows 上 Electron 是 GUI 子系统程序，stdout/stderr 不一定
 * 回传到控制台，所以关键节点直接写文件，否则出问题只能看到「静默退出」。
 */
const MAIN_LOG = process.env['PAPERLENS_LOG'] ?? join(process.cwd(), 'main-debug.log')

function logMain(message: string): void {
  try {
    appendFileSync(MAIN_LOG, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* 日志失败不能影响启动 */
  }
}

process.on('uncaughtException', (error) => {
  logMain('UNCAUGHT ' + String(error && error.stack ? error.stack : error))
})
process.on('unhandledRejection', (reason) => {
  logMain('UNHANDLED ' + String(reason))
})

logMain('module loaded')

/* ------------------------------------------------------------------ *
 *  调试开关（必须在 app ready 之前追加）
 * ------------------------------------------------------------------ */
if (process.env['PAPERLENS_USER_DATA']) {
  // 某些受限环境下 %APPDATA% 不可写，Electron 会在 ready 前直接段错误。
  // 允许把用户数据目录指到别处。
  app.setPath('userData', process.env['PAPERLENS_USER_DATA'])
  logMain('userData -> ' + process.env['PAPERLENS_USER_DATA'])
}
if (process.env['PAPERLENS_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['PAPERLENS_DEBUG_PORT'])
}
if (process.env['PAPERLENS_NO_SANDBOX'] === '1') {
  app.commandLine.appendSwitch('no-sandbox')
}

/* ------------------------------------------------------------------ *
 *  Provider 配置：加一个模型只需要在这里加一行
 * ------------------------------------------------------------------ */
const PROVIDERS: Record<string, { base: string; model: string; requiresKey: boolean }> = {
  deepseek: {
    base: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    requiresKey: true
  },
  ollama: {
    base: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    requiresKey: false
  }
}

/* ------------------------------------------------------------------ *
 *  Secret 存储（safeStorage / DPAPI）
 * ------------------------------------------------------------------ */
const secretsPath = (): string => join(app.getPath('userData'), 'secrets.json')

async function readSecrets(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(secretsPath(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

async function writeSecrets(data: Record<string, string>): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(secretsPath(), JSON.stringify(data, null, 2), 'utf8')
}

async function setSecret(name: string, plain: string): Promise<void> {
  const stored = safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(plain).toString('base64')
    : 'raw:' + Buffer.from(plain, 'utf8').toString('base64')
  const all = await readSecrets()
  all[name] = stored
  await writeSecrets(all)
}

async function getSecret(name: string): Promise<string | null> {
  const all = await readSecrets()
  const stored = all[name]
  if (!stored) return null
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    }
    if (stored.startsWith('raw:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    return stored
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 *  窗口
 * ------------------------------------------------------------------ */
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#14141a',
    autoHideMenuBar: true,
    title: 'PaperLens',
    icon: join(app.getAppPath(), 'resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 拖拽 PDF 时不要导航走
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl).then(
      () => logMain('loaded dev url ' + devUrl),
      (error) => logMain('dev url load failed ' + String(error))
    )
  } else {
    const indexFile = join(__dirname, '../renderer/index.html')
    logMain('loading file ' + indexFile)
    void mainWindow.loadFile(indexFile).then(
      () => logMain('loaded file'),
      (error) => logMain('file load failed ' + String(error))
    )
  }
}

app.whenReady().then(() => {
  logMain('app ready')
  try {
    createWindow()
    logMain('window created')
  } catch (error) {
    logMain('createWindow failed ' + String(error))
    throw error
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* ------------------------------------------------------------------ *
 *  IPC：文件
 * ------------------------------------------------------------------ */
ipcMain.handle('dialog:open-pdf', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开论文',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  const data = await readFile(path)
  return { path, name: path.split(/[\\/]/).pop() ?? 'untitled.pdf', data: new Uint8Array(data) }
})

/* ------------------------------------------------------------------ *
 *  IPC：密钥
 * ------------------------------------------------------------------ */
ipcMain.handle('secret:set', async (_e, name: string, value: string) => {
  await setSecret(name, value.trim())
  return true
})
ipcMain.handle('secret:has', async (_e, name: string) => (await getSecret(name)) !== null)

/**
 * 返回打码后的 Key（只留末四位）。
 * 设置页用它告诉用户「当前存的是哪一把」，避免复制错一串还不知道。
 */
ipcMain.handle('secret:mask', async (_e, name: string) => {
  const value = await getSecret(name)
  if (!value) return null
  const tail = value.slice(-4)
  return `••••${tail}`
})

ipcMain.handle('secret:clear', async (_e, name: string) => {
  const all = await readSecrets()
  delete all[name]
  await writeSecrets(all)
  return true
})

/* ------------------------------------------------------------------ *
 *  IPC：流式对话
 * ------------------------------------------------------------------ */
interface ChatRequest {
  id: string
  provider: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
  maxTokens?: number
}

const inflight = new Map<string, AbortController>()

/* ------------------------------------------------------------------ *
 *  错误分类
 *
 *  渲染进程只能拿到一串错误文本，所以在这里就把 HTTP 状态码和响应体
 *  翻译成「结论 + 建议」，序列化成 JSON 抛过去。
 * ------------------------------------------------------------------ */
interface ApiFailure {
  kind: 'auth' | 'quota' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'bad-request' | 'unknown'
  message: string
  hint?: string
  detail?: string
  status?: number
}

/** 从 DeepSeek 的 { error: { message } } 里取人类可读的那句 */
function extractApiMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string }
      message?: string
    }
    if (typeof parsed.error?.message === 'string') return parsed.error.message
    if (typeof parsed.message === 'string') return parsed.message
  } catch {
    /* 不是 JSON，直接截断原文 */
  }
  return body.slice(0, 300)
}

function classifyApiFailure(status: number, body: string): ApiFailure {
  const detail = extractApiMessage(body)

  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      status,
      message: 'API Key 无效或已过期',
      hint: 'Key 应该以 sk- 开头、没有多余空格。重新复制一次再去设置里保存。',
      detail
    }
  }
  if (status === 402) {
    return { kind: 'quota', status, message: '账户余额不足', hint: '去 DeepSeek 控制台充值后再试。', detail }
  }
  if (status === 429) {
    return {
      kind: 'rate-limit',
      status,
      message: '请求太频繁，被限流了',
      hint: '等十几秒再划选下一段。',
      detail
    }
  }
  if (status === 400) {
    return {
      kind: 'bad-request',
      status,
      message: '请求被拒绝（400）',
      hint: '可能是模型名不对，或者选中的段落太长。',
      detail
    }
  }
  if (status >= 500) {
    return {
      kind: 'server',
      status,
      message: '模型服务暂时不可用',
      hint: '通常几十秒内自己恢复，稍后重试。',
      detail
    }
  }
  return { kind: 'unknown', status, message: `请求失败（HTTP ${status}）`, detail }
}

function fail(failure: ApiFailure): never {
  throw new Error(JSON.stringify(failure))
}

ipcMain.handle('ai:stream', async (event, req: ChatRequest) => {
  const cfg = PROVIDERS[req.provider]
  if (!cfg) {
    fail({ kind: 'unknown', message: `未知的模型提供方：${req.provider}` })
  }

  let apiKey = ''
  if (cfg.requiresKey) {
    const stored = await getSecret(req.provider)
    if (!stored) throw new Error('NO_API_KEY')
    apiKey = stored
  }

  const controller = new AbortController()
  inflight.set(req.id, controller)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 2048,
        messages: req.messages
      })
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      logMain(`api ${res.status}: ${text.slice(0, 200)}`)
      fail(classifyApiFailure(res.status, text))
    }
    if (!res.body) {
      fail({ kind: 'unknown', message: '服务返回了空响应', hint: '重试一次；如果一直这样，可能是代理在中间截断了流。' })
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
          }
          const delta = json.choices?.[0]?.delta?.content
          if (delta && !event.sender.isDestroyed()) {
            event.sender.send(`ai:chunk:${req.id}`, delta)
          }
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }
    return { ok: true }
  } catch (error) {
    // 已经分类好的错误原样抛给渲染进程
    if (error instanceof Error && error.message.startsWith('{')) throw error

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(JSON.stringify({ kind: 'aborted', message: '已取消' }))
    }

    logMain('ai:stream failed ' + String(error))
    throw new Error(
      JSON.stringify({
        kind: 'network',
        message: '连不上模型服务',
        hint: '检查网络或代理设置；如果用的是本地 Ollama，确认 ollama serve 已经起来。',
        detail: String(error instanceof Error ? error.message : error).slice(0, 300)
      })
    )
  } finally {
    inflight.delete(req.id)
  }
})

ipcMain.on('ai:abort', (_e, id: string) => {
  inflight.get(id)?.abort()
  inflight.delete(id)
})
