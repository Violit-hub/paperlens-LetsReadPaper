import type { PageTextModel, TextBlock } from './pageTextModel'
import { cleanForModel, neighborBlocks } from './pageTextModel'

/**
 * 选区提取。
 *
 * 关键点：我们不读 selection.toString()（它是 DOM 顺序拼的，双栏会串行、
 * 空格会丢），而是把 Range 和每个 span 求交，通过 PageTextModel 里的
 * charMap 反推成「段落字符区间」，再从 block.text 精确切片。
 */

export interface SelectionPart {
  block: TextBlock
  page: number
  /** 在 block.text 中的字符区间 */
  start: number
  end: number
  order: number
}

export interface ExtractedSelection {
  parts: SelectionPart[]
  /** 面板里展示的原文（用户实际划中的部分） */
  displayText: string
  /** 送往模型的文本（已去连字符、合并空白） */
  modelText: string
  before: string
  after: string
  pages: number[]
  wordCount: number
}

const CONTEXT_RADIUS = 2
const CONTEXT_CHARS = 700

export function extractSelection(models: PageTextModel[]): ExtractedSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

  const range = selection.getRangeAt(0)
  if (range.collapsed) return null

  const parts: SelectionPart[] = []
  const bounds = range.getBoundingClientRect()

  for (const model of models) {
    const pageBase = model.el.getBoundingClientRect()
    if (pageBase.width < 1) continue // 页面还没渲染

    // 选区与整页的纵向粗筛
    if (bounds.top > pageBase.bottom + 8 || bounds.bottom < pageBase.top - 8) continue

    for (let blockIndex = 0; blockIndex < model.blocks.length; blockIndex++) {
      const block = model.blocks[blockIndex]
      const b = block.bbox

      // 块级粗筛（相对页面坐标）
      const blockTop = pageBase.top + b.y0
      const blockBottom = pageBase.top + b.y1
      const blockLeft = pageBase.left + b.x0
      const blockRight = pageBase.left + b.x1
      if (bounds.bottom < blockTop - 4 || bounds.top > blockBottom + 4) continue
      if (bounds.right < blockLeft - 4 || bounds.left > blockRight + 4) continue

      const hit = intersectBlock(range, block)
      if (!hit) continue

      parts.push({
        block,
        page: model.page,
        start: hit.start,
        end: hit.end,
        order: model.page * 1000 + blockIndex
      })
    }
  }

  if (parts.length === 0) return null
  parts.sort((a, b) => a.order - b.order)

  /* 太短的选区（一个词）自动扩到整句 —— 划一个词时用户想要的是这句的意思 */
  const rawLength = parts.reduce((sum, p) => sum + (p.end - p.start), 0)
  if (rawLength < 24) {
    for (const part of parts) {
      const [s, e] = expandToSentence(part.block.text, part.start, part.end)
      part.start = s
      part.end = e
    }
  }

  let displayText = ''
  const pages: number[] = []
  for (const part of parts) {
    const slice = part.block.text.slice(part.start, part.end).trim()
    if (!slice) continue
    displayText += displayText ? '\n\n' + slice : slice
    if (!pages.includes(part.page)) pages.push(part.page)
  }

  if (!displayText) return null

  const first = parts[0]
  const last = parts[parts.length - 1]
  const firstModel = models.find((m) => m.page === first.page)
  const lastModel = models.find((m) => m.page === last.page)

  const before = firstModel
    ? neighborBlocks(firstModel, first.block, CONTEXT_RADIUS)
        .before.map((b) => b.text)
        .join(' ')
        .slice(-CONTEXT_CHARS)
    : ''
  const after = lastModel
    ? neighborBlocks(lastModel, last.block, CONTEXT_RADIUS)
        .after.map((b) => b.text)
        .join(' ')
        .slice(0, CONTEXT_CHARS)
    : ''

  return {
    parts,
    displayText,
    modelText: cleanForModel(displayText),
    before,
    after,
    pages: pages.sort((a, b) => a - b),
    wordCount: displayText.split(/\s+/).filter(Boolean).length
  }
}

/* ------------------------------------------------------------------ */

function intersectBlock(range: Range, block: TextBlock): { start: number; end: number } | null {
  let start = -1
  let end = -1

  for (const segment of block.segments) {
    const span = segment.el
    if (!span.isConnected) continue

    const clamp = clampToSpan(range, span)
    if (!clamp) continue

    const s0 = segment.blockStart + Math.max(0, clamp.start)
    const s1 = segment.blockStart + Math.min(segment.len, clamp.end)
    if (s1 <= s0) continue

    if (start < 0) start = s0
    end = Math.max(end, s1)
  }

  if (start < 0 || end <= start) return null
  return { start, end }
}

/**
 * 求 Range 与单个 span 的交集，并换算成 span 内的字符偏移。
 *
 * 不能假设 range 的端点落在 span 内部 —— 它可能落在 .textLayer 容器、
 * 甚至 canvas 上。compareBoundaryPoints 可以安全地跨节点比较位置。
 */
function clampToSpan(range: Range, span: HTMLElement): { start: number; end: number } | null {
  const spanRange = document.createRange()
  spanRange.selectNodeContents(span)

  const intersection = range.cloneRange()

  try {
    if (intersection.compareBoundaryPoints(Range.START_TO_START, spanRange) < 0) {
      intersection.setStart(spanRange.startContainer, spanRange.startOffset)
    }
    if (intersection.compareBoundaryPoints(Range.END_TO_END, spanRange) > 0) {
      intersection.setEnd(spanRange.endContainer, spanRange.endOffset)
    }
  } catch {
    return null
  }

  if (intersection.collapsed) return null

  let start: number
  try {
    const prefix = document.createRange()
    prefix.selectNodeContents(span)
    prefix.setEnd(intersection.startContainer, intersection.startOffset)
    start = prefix.toString().length
  } catch {
    return null
  }

  let length: number
  try {
    length = intersection.toString().length
  } catch {
    return null
  }

  if (length <= 0) return null
  return { start, end: start + length }
}

/** 把选区扩到相邻的句子边界，最多向两侧各扩 400 字符 */
function expandToSentence(text: string, start: number, end: number): [number, number] {
  const isStop = (ch: string): boolean => ch === '.' || ch === '!' || ch === '?' || ch === '。'

  let s = start
  let guard = 0
  while (s > 0 && guard < 400) {
    if (isStop(text[s - 1])) break
    s--
    guard++
  }
  while (s < start && /\s/.test(text[s])) s++

  let e = end
  guard = 0
  while (e < text.length && guard < 400) {
    const ch = text[e]
    e++
    if (isStop(ch)) break
    guard++
  }
  while (e > end && /\s/.test(text[e - 1])) e--

  return [s, e]
}

/** 供调试/状态栏使用：当前选区落在哪些段落上 */
export function describeSelection(parts: SelectionPart[]): string {
  return parts.map((p) => `${p.block.id}[${p.start},${p.end}]`).join(' · ')
}
