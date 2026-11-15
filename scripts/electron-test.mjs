/**
 * 连接已经在运行的 Electron 渲染进程（需要以 --remote-debugging-port 启动），
 * 检查 preload 桥、页面加载状态、以及是否有运行时报错。
 *
 * 用法：
 *   1. electron . --no-sandbox --remote-debugging-port=9222
 *   2. node scripts/electron-test.mjs
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PORT = process.env.CDP_PORT || 9222
const ROOT = resolve(import.meta.dirname, '..')
const lines = []
function log(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  lines.push(text)
  console.log(text)
  writeFileSync(resolve(ROOT, 'electron-test.log'), lines.join('\n') + '\n', 'utf8')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* retry */
    }
    await sleep(400)
  }
  throw new Error('没有找到可调试的页面')
}

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  const events = []
  let seq = 0
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else res(msg.result)
      return
    }
    if (msg.method) events.push(msg)
  })
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res())
    ws.addEventListener('error', (e) => rej(new Error(String(e))))
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { send, events, ready }
}

async function main() {
  const target = await findTarget()
  log('TARGET ' + target.url)

  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')
  await sleep(2500)

  const evaluate = async (label, expression) => {
    try {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      const value = result.result?.value
      log(`${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      return value
    } catch (error) {
      log(`${label} EVAL_ERROR ${String(error)}`)
      return null
    }
  }

  await evaluate('URL', 'location.href')
  await evaluate('TITLE', 'document.title')
  await evaluate('BRIDGE', 'typeof window.api === "object" && window.api !== null ? "present" : "missing"')
  await evaluate('BRIDGE_KEYS', 'window.api ? Object.keys(window.api).join(",") : ""')
  await evaluate(
    'SECRET_IPC',
    'window.api ? window.api.hasSecret("deepseek").then(v => "hasSecret=" + v).catch(e => "ERR " + String(e)) : "no-bridge"'
  )
  // 存一把测试 key 再取打码值，验证「设置里能看到当前是哪一把」这条链路
  await evaluate(
    'MASK_SET',
    'window.api ? window.api.setSecret("deepseek","sk-test-abcd1234").then(() => "saved") : "no-bridge"'
  )
  await evaluate('MASK_GET', 'window.api ? window.api.getSecretMask("deepseek") : "no-bridge"')
  await evaluate(
    'MASK_CLEAR',
    'window.api ? window.api.clearSecret("deepseek").then(() => "cleared") : "no-bridge"'
  )
  await evaluate(
    'ROOT',
    'JSON.stringify({ rootChildren: document.querySelector("#root")?.children.length ?? -1, empty: !!document.querySelector(".empty"), toolbar: !!document.querySelector(".toolbar"), hook: typeof window.__paperlens })'
  )
  await evaluate('BODYTEXT', 'document.body.innerText.slice(0,200)')

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(ROOT, 'electron-shot.png'), Buffer.from(shot.data, 'base64'))
  log('SHOT ok')

  const problems = cdp.events
    .filter(
      (e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
    )
    .slice(-10)
    .map((e) => JSON.stringify(e.params).slice(0, 300))
  log('PROBLEMS ' + JSON.stringify(problems, null, 1))
  // WebSocket 会让事件循环一直活着，必须显式退出
  process.exit(0)
}

main().catch((error) => {
  log('FATAL ' + String(error && error.stack ? error.stack : error))
  process.exit(1)
})
