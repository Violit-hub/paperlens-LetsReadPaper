/**
 * 验证「API Key 无效」这条路径的 UI 表现。
 *
 * 手法：把 localStorage 里的 key 换成一个任意字符串，关掉 mock，
 * 让请求真的打到 DeepSeek，拿回 401，然后看面板怎么显示。
 * 无效 Key 不会产生任何费用。
 *
 * 用法：node scripts/error-test.mjs（需要 Vite dev server 在跑）
 * 输出：error-shot.png / error-test.log
 */
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5199/?sample=1'
const PORT = 9444
const ROOT = resolve(import.meta.dirname, '..')

const lines = []
function log(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  lines.push(text)
  console.log(text)
  writeFileSync(resolve(ROOT, 'error-test.log'), lines.join('\n') + '\n', 'utf8')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(resolve(ROOT, '.chrome-profile-err'), { recursive: true, force: true })

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
    `--user-data-dir=${resolve(ROOT, '.chrome-profile-err')}`,
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
  return { send, ready }
}

async function main() {
  const target = await findTarget()
  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  log('WAIT page')
  await sleep(11000)

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

  await evaluate('BLOCKS', 'window.__paperlens ? window.__paperlens.listBlocks().length : -1')

  // 关掉 mock、塞一个坏 key，让请求真打出去
  await evaluate(
    'SETUP',
    'localStorage.setItem("paperlens.mock","0"); localStorage.setItem("paperlens.key","sk-invalid-key-for-testing-000"); "ok"'
  )

  await evaluate('SELECT', 'window.__paperlens.selectBlock(1, 7)')
  await sleep(6000)

  await evaluate(
    'STATUS',
    'JSON.stringify(window.__paperlens.debugInfo())'
  )
  await evaluate(
    'NOTICE',
    '(function(){var n=document.querySelector(".panel .notice"); if(!n) return "NO-NOTICE"; return JSON.stringify({cls:n.className, text:n.innerText.slice(0,400)})})()'
  )
  await evaluate(
    'BUTTONS',
    '(function(){var n=document.querySelector(".panel .notice"); if(!n) return "[]"; return JSON.stringify(Array.from(n.querySelectorAll("button")).map(b=>b.innerText))})()'
  )

  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(ROOT, 'error-shot.png'), Buffer.from(shot.data, 'base64'))
    log('SHOT ok')
  } catch (error) {
    log('SHOT_FAIL ' + String(error))
  }

  chrome.kill()
  rmSync(resolve(ROOT, '.chrome-profile-err'), { recursive: true, force: true })
  process.exit(0)
}

main().catch((error) => {
  log('FATAL ' + String(error && error.stack ? error.stack : error))
  chrome.kill()
  process.exit(1)
})
