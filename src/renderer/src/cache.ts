import Dexie, { type Table } from 'dexie'

export interface CachedTranslation {
  key: string
  text: string
  source: string
  model: string
  createdAt: number
}

/** 每篇论文一份的文档级上下文：标题、摘要、术语表 */
export interface DocContextRow {
  docId: string
  title: string
  abstract: string
  glossary: Array<{ en: string; zh: string }>
  createdAt: number
}

class PaperLensDB extends Dexie {
  translations!: Table<CachedTranslation, string>
  docs!: Table<DocContextRow, string>

  constructor() {
    super('paperlens')
    this.version(1).stores({
      translations: 'key, createdAt'
    })
    // v2：加文档级上下文。已有的译文缓存不动。
    this.version(2).stores({
      translations: 'key, createdAt',
      docs: 'docId'
    })
  }
}

export const db = new PaperLensDB()

/** cyrb53：非加密哈希，用于缓存键，够快够散 */
export function hashText(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * 缓存键是内容寻址的：同一段话出现在不同论文里也能命中。
 * promptVersion 必须参与，否则改了 prompt 还会读到旧结果。
 * task 参与是因为同一段的「译文」和「讲解」是两份不同的东西。
 */
export function makeCacheKey(args: {
  provider: string
  promptVersion: string
  text: string
  before: string
  after: string
  task?: string
}): string {
  return [
    args.task ?? 'translate',
    args.provider,
    args.promptVersion,
    hashText(args.text),
    hashText(args.before.slice(-160)),
    hashText(args.after.slice(0, 160))
  ].join('|')
}

export async function readCache(key: string): Promise<CachedTranslation | null> {
  try {
    return (await db.translations.get(key)) ?? null
  } catch {
    return null
  }
}

export async function writeCache(row: CachedTranslation): Promise<void> {
  try {
    await db.translations.put(row)
  } catch {
    /* 存储失败不该影响阅读 */
  }
}

export async function clearCache(): Promise<void> {
  await db.translations.clear()
}

export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  const count = await db.translations.count()
  return { count, bytes: 0 }
}
