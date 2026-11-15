/**
 * 验证「自定义 Prompt」这条链路：
 *   设置里编辑 → 保存到 localStorage → 参与缓存键 → 真正进入请求
 *
 * 判定方式：往翻译 prompt 末尾加一个标记词，mock 收到后返回
 * 「【自定义 prompt 生效】」，说明改的内容确实送到模型了。
 *
 * 用法：node scripts/prompt-settings-test.mjs（需要 Vite dev server）
 * 输出：prompt-shot.png / prompt-settings-test.log
 */
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5199/?sample=1'
const PORT = 9666
const ROOT = resolve(import.meta.dirname, '..')

const lines = []
function log(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  lines.push(text)
  console.log(text)
  writeFileSync(resolve(ROOT, 'prompt-settings-test.log'), lines.join('\n') + '\n', 'utf8')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
rmSync(resolve(ROOT, '.chrome-profile-prompt'), { recursive: true, force: true })

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
    `--user-data-dir=${resolve(ROOT, '.chrome-profile-prompt')}`,
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

  await sleep(4000)
  await evaluate('MOCK_ON', 'localStorage.setItem("paperlens.mock","1"), "ok"')
  await cdp.send('Page.reload', { ignoreCache: false })
  log('RELOADED')
  await sleep(14000)

  // 打开设置 → 展开 prompt → 改写翻译 prompt
  await evaluate(
    'OPEN_SETTINGS',
    `(function(){var b=Array.from(document.querySelectorAll('.toolbar button')).find(x=>x.innerText==='设置'); if(!b) return 'NO-BUTTON'; b.click(); return 'clicked'})()`
  )
  await sleep(600)

  await evaluate(
    'EXPAND',
    `(function(){var t=document.querySelector('.prompt-toggle'); if(!t) return 'NO-TOGGLE'; t.click(); return 'expanded'})()`
  )
  await sleep(400)

  await evaluate(
    'EDIT',
    `(function(){
      var ta=document.querySelectorAll('.prompt-editor')[0];
      if(!ta) return 'NO-EDITOR';
      var setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(ta, ta.value + '\\n\\n（自定义测试标记）请只输出一句话。');
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      return 'edited len=' + ta.value.length;
    })()`
  )
  await sleep(300)

  await evaluate(
    'SAVE',
    `(function(){var b=Array.from(document.querySelectorAll('.modal-actions button')).find(x=>x.innerText==='保存'); if(!b) return 'NO-SAVE'; b.click(); return 'saved'})()`
  )
  await sleep(900)

  await evaluate(
    'STORED',
    `JSON.stringify({translate:(localStorage.getItem('paperlens.prompt.translate')||'').includes('自定义测试标记'), explain: !!localStorage.getItem('paperlens.prompt.explain'), badge: !!document.querySelector('.prompt-toggle .badge')})`
  )

  // 截图（设置在展开状态）
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(ROOT, 'prompt-shot.png'), Buffer.from(shot.data, 'base64'))
    log('SHOT ok')
  } catch (error) {
    log('SHOT_FAIL ' + String(error))
  }

  // 关闭设置，划选一段，确认自定义 prompt 真的生效
  await evaluate(
    'CLOSE',
    `(function(){var b=Array.from(document.querySelectorAll('.modal-actions button')).find(x=>x.innerText==='关闭'); if(b) b.click(); return 'closed'})()`
  )
  await sleep(500)
  await evaluate('SELECT', 'window.__paperlens.selectBlock(1, 7)')
  await sleep(6000)

  await evaluate(
    'TRANSLATION',
    '(function(){var e=document.querySelector(".pane-translation .translation"); return e ? e.innerText.slice(0,120) : "NO-TRANSLATION"})()'
  )
  await evaluate('INFO', 'JSON.stringify(window.__paperlens.debugInfo())')

  chrome.kill()
  rmSync(resolve(ROOT, '.chrome-profile-prompt'), { recursive: true, force: true })
  process.exit(0)
}

main().catch((error) => {
  log('FATAL ' + String(error && error.stack ? error.stack : error))
  chrome.kill()
  process.exit(1)
})
