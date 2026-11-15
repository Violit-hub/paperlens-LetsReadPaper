/**
 * 验证文档级上下文（标题 + 摘要 + 术语表）整条链路。
 *
 * 依赖 mock 模式：platform.ts 遇到「论文信息抽取器」的 system prompt 时会
 * 返回一份固定的假术语表，这样不用真实 Key 也能验证：
 *   抽取 → 存库 → 注入 prompt → 面板展示
 *
 * 用法：node scripts/glossary-test.mjs（需要 Vite dev server）
 * 输出：glossary-shot.png / glossary-test.log
 */
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5199/?sample=1'
const PORT = 9555
const ROOT = resolve(import.meta.dirname, '..')

const lines = []
function log(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  lines.push(text)
  console.log(text)
  writeFileSync(resolve(ROOT, 'glossary-test.log'), lines.join('\n') + '\n', 'utf8')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
rmSync(resolve(ROOT, '.chrome-profile-gloss'), { recursive: true, force: true })

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
    `--user-data-dir=${resolve(ROOT, '.chrome-profile-gloss')}`,
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

  await sleep(5000)
  // mock 必须在页面加载前就位，否则首轮抽取会走真实接口
  await evaluate('MOCK_ON', 'localStorage.setItem("paperlens.mock","1"), "ok"')
  await cdp.send('Page.reload', { ignoreCache: false })
  log('RELOADED')

  // 等版面重建 + 术语抽取（mock 流式要几秒）
  await sleep(16000)

  await evaluate('BLOCKS', 'window.__paperlens ? window.__paperlens.listBlocks().length : -1')
  const info1 = await evaluate('INFO', 'JSON.stringify(window.__paperlens.debugInfo())')
  const parsed1 = typeof info1 === 'string' ? JSON.parse(info1) : {}
  log(
    'CTX ' +
      JSON.stringify({
        contextStatus: parsed1.contextStatus,
        terms: parsed1.docContext?.terms ?? 0,
        title: parsed1.docContext?.title ?? ''
      })
  )

  await evaluate('SELECT', 'window.__paperlens.selectBlock(1, 7)')
  await sleep(7000)

  await evaluate(
    'GLOSSARY',
    '(function(){var g=document.querySelector(".panel .glossary"); if(!g) return "NO-GLOSSARY"; return JSON.stringify({head:g.querySelector(".glossary-head")?.innerText, terms:Array.from(g.querySelectorAll(".term")).map(t=>t.innerText.replace(/\\n/g," | "))})})()'
  )
  await evaluate(
    'EXPLAIN',
    '(function(){var e=document.querySelector(".pane-explain .explanation"); return e ? e.innerText.slice(0,220) : "NO-EXPLANATION"})()'
  )
  await evaluate(
    'LAYOUT',
    '(function(){var p=document.querySelector(".panel"),s=document.querySelector(".scroller"); if(!p||!s) return "NO-LAYOUT"; var pr=p.getBoundingClientRect(),sr=s.getBoundingClientRect(); return JSON.stringify({panelLeft:Math.round(pr.left),panelWidth:Math.round(pr.width),scrollerWidth:Math.round(sr.width),docLeft:Math.round(document.querySelector(".page")?.getBoundingClientRect().left ?? -1)})})()'
  )
  await evaluate(
    'FOOTER',
    'document.querySelector(".panel .panel-footer")?.innerText ?? "NO-FOOTER"'
  )
  const info2 = await evaluate('INFO2', 'JSON.stringify(window.__paperlens.debugInfo())')

  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(ROOT, 'glossary-shot.png'), Buffer.from(shot.data, 'base64'))
    log('SHOT ok')
  } catch (error) {
    log('SHOT_FAIL ' + String(error))
  }

  chrome.kill()
  rmSync(resolve(ROOT, '.chrome-profile-gloss'), { recursive: true, force: true })
  process.exit(0)
}

main().catch((error) => {
  log('FATAL ' + String(error && error.stack ? error.stack : error))
  chrome.kill()
  process.exit(1)
})
