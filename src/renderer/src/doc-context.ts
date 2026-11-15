import { db, type DocContextRow } from './cache'
import { newRequestId, streamChat } from './platform'

/**
 * 文档级上下文。
 *
 * 为什么不是一个「每篇论文一个会话」：多轮历史每轮都在变，会把模型侧的
 * prompt cache 前缀打断，而且 token 随段数线性增长。正确做法是打开论文时
 * 抽一次固定的「标题 + 摘要 + 术语表」，之后每次翻译原样注入 —— 前缀稳定、
 * 成本恒定、术语还能保持一致。
 */

export interface GlossaryEntry {
  en: string
  zh: string
}

export interface DocContext {
  docId: string
  title: string
  abstract: string
  glossary: GlossaryEntry[]
  createdAt: number
}

export async function getDocContext(docId: string): Promise<DocContext | null> {
  try {
    const row = await db.docs.get(docId)
    if (!row) return null
    return {
      docId: row.docId,
      title: row.title,
      abstract: row.abstract,
      glossary: row.glossary ?? [],
      createdAt: row.createdAt
    }
  } catch {
    return null
  }
}

export async function saveDocContext(context: DocContext): Promise<void> {
  try {
    const row: DocContextRow = {
      docId: context.docId,
      title: context.title,
      abstract: context.abstract,
      glossary: context.glossary,
      createdAt: context.createdAt
    }
    await db.docs.put(row)
  } catch {
    /* 存不下就算了，下次重新抽 */
  }
}

export async function deleteDocContext(docId: string): Promise<void> {
  try {
    await db.docs.delete(docId)
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 *  抽取
 * ------------------------------------------------------------------ */

const EXTRACT_SYSTEM = `你是论文信息抽取器。用户给你一篇学术论文第一页的文本，你输出三样东西：

1. title：论文标题的英文原文，一行，不要翻译、不要加引号
2. abstract：摘要的英文原文，最多 120 词；找不到摘要就填空字符串
3. glossary：20-40 个本篇论文里反复出现、且中文译法容易不一致的技术术语

术语要求：
- 只收名词或名词短语，不要收 model / method / result / paper 这类通用词
- 英文保留原文大小写，专有名词照抄
- 中文用该领域国内通行的译法，不要生造
- 宁可少收，不要凑数

只输出 JSON，不要 markdown 代码块，不要任何解释或前后缀：
{"title":"...","abstract":"...","glossary":[{"en":"...","zh":"..."}]}`

export interface ExtractInput {
  docId: string
  provider: string
  /** 第一页的正文文本（已经过版面重建，比较干净） */
  pageText: string
}

export async function extractDocContext(input: ExtractInput): Promise<DocContext | null> {
  const text = input.pageText.replace(/\s+/g, ' ').trim().slice(0, 4500)
  if (text.length < 80) return null

  let raw = ''
  try {
    await streamChat(
      {
        id: newRequestId(),
        provider: input.provider,
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM },
          { role: 'user', content: `论文第一页文本：\n\n${text}` }
        ],
        temperature: 0.1,
        maxTokens: 1600
      },
      (delta) => {
        raw += delta
      }
    )
  } catch {
    // 抽不出来不影响阅读，翻译时就是没有术语表而已
    return null
  }

  return coerceContext(input.docId, parseJsonLoose(raw))
}

/** 模型有时会包 ```json，有时会加一句「好的」。把最外层的 {...} 抠出来。 */
function parseJsonLoose(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

function coerceContext(docId: string, data: unknown): DocContext | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>

  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 300) : ''
  const abstract =
    typeof record.abstract === 'string' ? record.abstract.trim().slice(0, 1400) : ''

  const rawGlossary = Array.isArray(record.glossary) ? record.glossary : []
  const glossary: GlossaryEntry[] = []
  const seen = new Set<string>()

  for (const item of rawGlossary) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (typeof entry.en !== 'string' || typeof entry.zh !== 'string') continue

    const en = entry.en.trim().slice(0, 80)
    const zh = entry.zh.trim().slice(0, 80)
    if (en.length < 2 || zh.length < 1) continue

    const key = en.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    glossary.push({ en, zh })
    if (glossary.length >= 40) break
  }

  if (!title && glossary.length === 0) return null

  return { docId, title, abstract, glossary, createdAt: Date.now() }
}

/* ------------------------------------------------------------------ *
 *  使用
 * ------------------------------------------------------------------ */

/** 把术语表拼成 prompt 里的一段文本 */
export function formatGlossary(glossary: GlossaryEntry[]): string | undefined {
  if (glossary.length === 0) return undefined
  return glossary.map((entry) => `${entry.en} → ${entry.zh}`).join('\n')
}

/** 找出这段原文里实际出现了哪些术语，用于在面板上展示 */
export function matchGlossary(text: string, glossary: GlossaryEntry[]): GlossaryEntry[] {
  if (glossary.length === 0) return []
  const haystack = text.toLowerCase()
  return glossary.filter((entry) => haystack.includes(entry.en.toLowerCase()))
}
