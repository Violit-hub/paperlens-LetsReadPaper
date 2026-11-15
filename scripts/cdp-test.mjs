/**
 * 用 CDP 驱动 headless Chrome 做端到端验证。
 * 好处：能读到 console 错误、执行页面脚本、截图，全部走协议，不依赖 stdout。
 *
 * 用法：node scripts/cdp-test.mjs
 * 输出：cdp.log / cdp-shot.png
 */
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = process.env.TEST_URL || 'http://localhost:5199/?sample=1'
const PORT = 9333
const ROOT = resolve(import.meta.dirname, '..')

const lines = []
function log(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  lines.push(text)
  console.log(text)
  writeFileSync(resolve(ROOT, 'cdp.log'), lines.join('\n') + '\n', 'utf8')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(resolve(ROOT, '.chrome-profile'), { recursive: true, force: true })

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${resolve(ROOT, '.chrome-profile')}`,
    '--window-size=1440,1000',
    URL
  ],
  { stdio: 'ignore' }
)

async function findTarget() {
  for (let i = 0; i < 60; i++) {
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
  throw new Error('Chrome DevTools 端口未就绪')
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
    ws.addEventListener('error', (e) => rej(new Error('ws error ' + String(e))))
  })

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id, method, params }))
    })

  return { ws, send, events, ready }
}

async function main() {
  const target = await findTarget()
  log('TARGET ' + target.url)

  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')

  log('WAIT start')
  await sleep(12000)

  const evaluate = async (label, expression) => {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      const value = result.result?.value
      log(`${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      return value
    } catch (error) {
      log(`${label} EVAL_ERROR ${String(error)}`)
      return null
    }
  }

  await evaluate('READY', 'document.readyState')
  await evaluate(
    'HOOK',
    'typeof window.__paperlens === "object" ? "yes" : "no"'
  )
  await evaluate(
    'INFO',
    'window.__paperlens ? JSON.stringify(window.__paperlens.debugInfo()) : "no-hook"'
  )
  await evaluate(
    'BLOCKS',
    'window.__paperlens ? JSON.stringify(window.__paperlens.listBlocks()) : "[]"'
  )

  // 看看页面上到底有没有渲染出页面
  await evaluate(
    'DOM',
    'JSON.stringify({ pages: document.querySelectorAll(".page").length, canvases: document.querySelectorAll(".page canvas").length, spans: document.querySelectorAll(".textLayer span").length, empty: !!document.querySelector(".empty"), loadingBar: !!document.querySelector(".loading-bar"), bodyText: document.body.innerText.slice(0,200) })'
  )

  await evaluate('MOCK', 'localStorage.setItem("paperlens.mock","1"), "mock-on"')

  await evaluate('SELECT', 'window.__paperlens ? window.__paperlens.selectBlock(1, 7) : "no-hook"')

  await sleep(9000)

  await evaluate(
    'INFO2',
    'window.__paperlens ? JSON.stringify(window.__paperlens.debugInfo()) : "no-hook"'
  )
  await evaluate(
    'PANEL',
    '(function(){var p=document.querySelector(".panel");return p?p.innerText.slice(0,700):"NO-PANEL"})()'
  )

  // 第二次划同一段：应该直接命中缓存（0 网络请求、秒出）
  await evaluate('SELECT2', 'window.__paperlens ? window.__paperlens.selectBlock(1, 7) : "no-hook"')
  await sleep(1800)
  await evaluate(
    'INFO3',
    'window.__paperlens ? JSON.stringify(window.__paperlens.debugInfo()) : "no-hook"'
  )
  await evaluate(
    'PANEL2',
    '(function(){var p=document.querySelector(".panel");return p?p.innerText.slice(0,160):"NO-PANEL"})()'
  )

  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(ROOT, 'cdp-shot.png'), Buffer.from(shot.data, 'base64'))
    log('SHOT ok')
  } catch (error) {
    log('SHOT_FAIL ' + String(error))
  }

  const consoleEvents = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded' || e.method === 'Runtime.exceptionThrown')
    .slice(-15)
    .map((e) => JSON.stringify(e.params).slice(0, 400))
  log('EVENTS ' + JSON.stringify(consoleEvents, null, 1))

  chrome.kill()
  process.exit(0)
}

main().catch((error) => {
  log('FATAL ' + String(error && error.stack ? error.stack : error))
  chrome.kill()
  process.exit(1)
})
