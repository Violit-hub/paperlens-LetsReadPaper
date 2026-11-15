export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  id: string
  provider: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}

interface PaperLensBridge {
  isElectron: true
  openPdf(): Promise<{ path: string; name: string; data: Uint8Array } | null>
  setSecret(name: string, value: string): Promise<boolean>
  hasSecret(name: string): Promise<boolean>
  getSecretMask(name: string): Promise<string | null>
  clearSecret(name: string): Promise<boolean>
  abort(id: string): void
  streamChat(req: ChatRequest, onChunk: (delta: string) => void): Promise<void>
}

declare global {
  interface Window {
    api?: PaperLensBridge
  }
}

export const hasBridge = (): boolean => typeof window !== 'undefined' && !!window.api

/* ------------------------------------------------------------------ *
 *  浏览器调试模式的本地配置
 *  注意：这条通路只是开发用来验证界面的，Key 存在 localStorage 里，
 *  不要当作正式交付形态。正式版走 Electron 主进程 + safeStorage。
 * ------------------------------------------------------------------ */
const WEB_KEY = 'paperlens.key'
const WEB_MOCK = 'paperlens.mock'

export function getWebKey(): string {
  try {
    return localStorage.getItem(WEB_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setWebKey(value: string): void {
  try {
    localStorage.setItem(WEB_KEY, value)
  } catch {
    /* ignore */
  }
}

export function isMockMode(): boolean {
  try {
    return localStorage.getItem(WEB_MOCK) === '1'
  } catch {
    return false
  }
}

export function setMockMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(WEB_MOCK, '1')
    else localStorage.removeItem(WEB_MOCK)
  } catch {
    /* ignore */
  }
}

export function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/* ------------------------------------------------------------------ */

export async function streamChat(
  req: ChatRequest,
  onChunk: (delta: string) => void
): Promise<void> {
  if (window.api) {
    return window.api.streamChat(req, onChunk)
  }

  if (isMockMode()) return mockStream(req, onChunk)

  const key = getWebKey()
  if (!key) throw new Error('NO_API_KEY')

  // 浏览器模式下 /api/chat 由 Vite 代理转发到 DeepSeek，绕过 CORS
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      stream: true,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 2048,
      messages: req.messages
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const kind =
      res.status === 401 || res.status === 403
        ? 'auth'
        : res.status === 402
          ? 'quota'
          : res.status === 429
            ? 'rate-limit'
            : res.status >= 500
              ? 'server'
              : 'unknown'
    throw new Error(
      JSON.stringify({
        kind,
        status: res.status,
        message: kind === 'auth' ? 'API Key 无效或已过期' : `请求失败（HTTP ${res.status}）`,
        hint: kind === 'auth' ? 'Key 应该以 sk- 开头、没有多余空格。' : undefined,
        detail: text.slice(0, 300)
      })
    )
  }
  if (!res.body) throw new Error('响应没有 body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const delta = json.choices?.[0]?.delta?.content
        if (delta) onChunk(delta)
      } catch {
        /* 半包，忽略 */
      }
    }
  }
}

/** 没有 Key 的时候也能把「划选 → 面板 → 流式」整条链路跑通 */
async function mockStream(req: ChatRequest, onChunk: (delta: string) => void): Promise<void> {
  const system = req.messages.find((m) => m.role === 'system')?.content ?? ''

  // 术语抽取请求：返回一份固定的假数据，让整条文档上下文链路可测
  if (system.includes('论文信息抽取器')) {
    const fake = JSON.stringify(
      {
        title:
          'Retrieval-Augmented Instruction Tuning for Low-Resource Scientific Question Answering',
        abstract:
          'Scientific question answering demands models that can ground their answers in dense technical prose while remaining robust to terminology that is rare in general-domain corpora.',
        glossary: [
          { en: 'retrieval augmentation', zh: '检索增强' },
          { en: 'instruction tuning', zh: '指令微调' },
          { en: 'retriever', zh: '检索器' },
          { en: 'exact match', zh: '精确匹配' },
          { en: 'curriculum', zh: '课程式训练' },
          { en: 'distractor', zh: '干扰段落' },
          { en: 'ablation', zh: '消融实验' },
          { en: 'elaboration', zh: '展开论述' },
          { en: 'citation', zh: '引用' },
          { en: 'corpus', zh: '语料库' }
        ]
      },
      null,
      2
    )
    await typeOut(fake, onChunk)
    return
  }

  const userMessage = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''

  // 讲解请求
  if (userMessage.includes('[任务：讲解]')) {
    const fake =
      `【模拟讲解】这段在说：现在的大模型回答科学问题时会「编」，而且编得很像真的——` +
      `数字、机制、引用都能给你来一个，但原文里根本没有。\n\n` +
      `更直白一点：作者先点出问题（模型会一本正经地胡说），再举例说这在哪些领域最要命——` +
      `材料合成、临床剂量这种外行没法拿常识判断的地方。这一段其实是在给整篇论文立靶子，` +
      `后面要解决的就是这个「看着合理但没根据」的毛病。\n\n` +
      `隐含假设：作者默认「读者无法自行验证」是问题的核心，所以他把「有没有原文支撑」` +
      `看得比「答案流不流畅」更重要。这个取舍决定了后面所有评估指标的设计。`
    await typeOut(fake, onChunk)
    return
  }

  const source = userMessage.split('[待翻译]')[1]?.split(/\n\n\[/)[0]?.trim() ?? ''
  const preview = source.slice(0, 50).replace(/\s+/g, ' ')

  // 测试钩子：自定义 prompt 里带这个标记时，返回可识别的内容
  if (userMessage.includes('自定义测试标记')) {
    await typeOut('【自定义 prompt 生效】这段是用你改过的 prompt 翻出来的。', onChunk)
    return
  }

  const fake =
    `【模拟译文 · 未配置 API Key】\n\n` +
    `这段话的原文是：「${preview}…」。这是一段用于验证界面的模拟输出：` +
    `选区重建、面板弹出、逐段追加、缓存命中，这些环节都只有在真实运行时才会暴露问题，` +
    `所以先把链路跑通，再接真实模型。\n\n` +
    `去右上角「设置」填入 DeepSeek API Key，就可以看到真实译文了。`

  await typeOut(fake, onChunk)
}

async function typeOut(text: string, onChunk: (delta: string) => void): Promise<void> {
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i += 2) {
    onChunk(chars.slice(i, i + 2).join(''))
    await new Promise((resolve) => setTimeout(resolve, 8))
  }
}
