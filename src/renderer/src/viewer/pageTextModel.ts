/**
 * PageTextModel —— 整个产品的技术核心。
 *
 * pdf.js 的文本层是一堆绝对定位的 <span>，它们的顺序不等于阅读顺序，
 * 空格和换行在 PDF 里根本不存在（词间距是坐标差，不是字符）。
 * 所以文本必须按几何位置重建，不能信浏览器的 selection.toString()。
 *
 * 重建流程：
 *   spans ──y 中心聚类──▶ 行
 *         ──x 排序 + 大间隙切断──▶ 行片段（这一步把双栏分开）
 *         ──左边界对齐 + 行距连续──▶ 段落
 *
 * 产出的 TextBlock 里同时有：
 *   · text      —— 干净、连续的段落文本（送往模型）
 *   · segments  —— 段落字符偏移 ↔ DOM span 的双向映射（用于精确高亮）
 */

export type BlockKind = 'body' | 'header' | 'footer' | 'lineno' | 'caption' | 'math' | 'reference'

export interface SpanBox {
  el: HTMLSpanElement
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  fontSize: number
}

/** 段落内的一段连续字符落在哪个 span 上 */
export interface CharSegment {
  el: HTMLSpanElement
  /** 这段字符在 block.text 里的起点 */
  blockStart: number
  /** 在 span.textContent 里的起点（目前恒为 0） */
  spanStart: number
  len: number
}

export interface BBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface TextBlock {
  id: string
  page: number
  kind: BlockKind
  text: string
  bbox: BBox
  segments: CharSegment[]
  /** 该段主字号，用于判断行距、页眉页脚 */
  fontSize: number
  /** 该段由几行拼成（调试用） */
  lineCount: number
}

export interface PageTextModel {
  page: number
  el: HTMLDivElement
  width: number
  height: number
  blocks: TextBlock[]
}

interface Frag {
  spans: SpanBox[]
  x0: number
  y0: number
  x1: number
  y1: number
  fontSize: number
  col: number
}

interface RawBlock {
  lines: Frag[]
  x0: number
  y0: number
  x1: number
  y1: number
  fontSize: number
}

const MIN_LINE_GAP = -0.6

/**
 * 从一页的 DOM 重建段落模型。必须在 textLayer 已插入 DOM 且可见时调用
 * （否则 getBoundingClientRect 全是 0）。
 */
export function buildPageTextModel(
  pageEl: HTMLDivElement,
  layer: HTMLElement,
  pageNumber: number
): PageTextModel {
  const base = pageEl.getBoundingClientRect()
  const pageWidth = base.width || pageEl.clientWidth || 600
  const pageHeight = base.height || pageEl.clientHeight || 800

  /* ① 收集所有非空 span，坐标换成相对页面的坐标 */
  const spans: SpanBox[] = []
  for (const el of Array.from(layer.querySelectorAll<HTMLSpanElement>('span'))) {
    const text = el.textContent ?? ''
    if (text.trim().length === 0) continue
    const r = el.getBoundingClientRect()
    if (r.width < 0.5 || r.height < 0.5) continue
    const fontSize = Number.parseFloat(el.style.fontSize) || r.height || 10
    spans.push({
      el,
      text,
      x0: r.left - base.left,
      y0: r.top - base.top,
      x1: r.right - base.left,
      y1: r.bottom - base.top,
      fontSize
    })
  }

  if (spans.length === 0) {
    return { page: pageNumber, el: pageEl, width: pageWidth, height: pageHeight, blocks: [] }
  }

  /* ② 按 y 聚类成行。按 y 排序后同一行的 span 一定相邻，所以只需比上一行。 */
  const byY = [...spans].sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1))
  const rows: SpanBox[][] = []
  for (const span of byY) {
    const cy = (span.y0 + span.y1) / 2
    const last = rows[rows.length - 1]
    if (last) {
      const lcy = (last[0].y0 + last[0].y1) / 2
      const tolerance = Math.max(2, Math.min(span.fontSize, last[0].fontSize) * 0.45)
      if (Math.abs(cy - lcy) <= tolerance) {
        last.push(span)
        continue
      }
    }
    rows.push([span])
  }

  /* ③ 行内按 x 排序，遇到大间隙切断 —— 双栏、多列表格就是在这里被分开的 */
  const frags: Frag[] = []
  for (const row of rows) {
    const ordered = [...row].sort((a, b) => a.x0 - b.x0)
    let current: SpanBox[] = []
    let prevX1 = Number.NEGATIVE_INFINITY

    const flush = (): void => {
      if (current.length === 0) return
      const x0 = Math.min(...current.map((s) => s.x0))
      const x1 = Math.max(...current.map((s) => s.x1))
      const y0 = Math.min(...current.map((s) => s.y0))
      const y1 = Math.max(...current.map((s) => s.y1))
      const fontSize = Math.max(...current.map((s) => s.fontSize))
      frags.push({ spans: current, x0, x1, y0, y1, fontSize, col: 0 })
      current = []
    }

    for (const span of ordered) {
      const gap = span.x0 - prevX1
      // 2.2em 是一个非常宽松的阈值：正常词间距约 0.25em，只有栏间距才这么大
      if (current.length > 0 && gap > Math.max(span.fontSize * 2.2, 7)) flush()
      current.push(span)
      prevX1 = Math.max(prevX1, span.x1)
    }
    flush()
  }

  /* ④ 分栏检测：右侧起点出现足够多的行 → 双栏 */
  assignColumns(frags, pageWidth)

  /* ⑤ 逐栏拼段落：左边界对齐 + 行距连续 + 上一行排满 */
  const rawBlocks: RawBlock[] = []
  for (const col of [2, 0, 1]) {
    const list = frags.filter((f) => f.col === col).sort((a, b) => a.y0 - b.y0)
    if (list.length === 0) continue

    // 用中位数而不是极值：跨栏标题、脚注这类离群行会把 min/max 拉爆，
    // 从而让「栏宽」失去意义
    const colLeft = median(list.map((f) => f.x0))
    const colRight = percentile(
      list.map((f) => f.x1),
      0.9
    )
    const colWidth = Math.max(1, colRight - colLeft)

    // 该栏里相邻行的「行距中位数」，用来识别段落之间的额外间距。
    // 绝对阈值在这里不可靠：不同字体的行高差异很大，必须用这一页自己的基准。
    const gaps: number[] = []
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].y0 - list[i - 1].y1
      if (gap > -8 && gap < 48) gaps.push(gap)
    }
    const typicalGap = median(gaps)

    let current: RawBlock | null = null
    let prev: Frag | null = null

    for (const frag of list) {
      const alignedX = prev ? Math.abs(frag.x0 - prev.x0) <= Math.max(frag.fontSize * 1.6, 9) : false
      const gap = prev ? frag.y0 - prev.y1 : Number.POSITIVE_INFINITY

      // 行距只能是「常规行距附近」；明显更大说明是段间空行
      const spacingLimit = Math.max(typicalGap * 1.7 + 1.5, frag.fontSize * 0.45)
      const lineSpacingOk = gap <= spacingLimit && gap >= frag.fontSize * MIN_LINE_GAP

      // 上一行是否排满：用「相对栏宽」而不是绝对像素。
      // 阈值放宽到 0.62 —— 比例字体下 46 个字符的行宽能差 20%，
      // 卡太紧会把段内每一行都误判成段末。
      const prevLineFull = prev ? prev.x1 >= colLeft + colWidth * 0.62 : false

      if (current && prev && alignedX && lineSpacingOk && prevLineFull) {
        current.lines.push(frag)
        current.y1 = Math.max(current.y1, frag.y1)
        current.x1 = Math.max(current.x1, frag.x1)
      } else {
        current = {
          lines: [frag],
          x0: frag.x0,
          y0: frag.y0,
          x1: frag.x1,
          y1: frag.y1,
          fontSize: frag.fontSize
        }
        rawBlocks.push(current)
      }
      prev = frag
    }
  }

  /* ⑥ 生成干净文本 + 字符映射 */
  const medianFont = median(rawBlocks.map((b) => b.fontSize)) || 10
  const blocks: TextBlock[] = rawBlocks.map((raw, index) => {
    const id = `p${pageNumber}-b${index}`
    const { text, segments } = buildText(raw.lines)
    const kind = classify(raw, text, pageWidth, pageHeight, medianFont)

    for (const seg of segments) seg.el.dataset.block = id

    return {
      id,
      page: pageNumber,
      kind,
      text,
      bbox: { x0: raw.x0, y0: raw.y0, x1: raw.x1, y1: raw.y1 },
      segments,
      fontSize: raw.fontSize,
      lineCount: raw.lines.length
    }
  })

  return { page: pageNumber, el: pageEl, width: pageWidth, height: pageHeight, blocks }
}

/* ------------------------------------------------------------------ */

function assignColumns(frags: Frag[], pageWidth: number): void {
  if (frags.length < 8) {
    for (const f of frags) f.col = 0
    return
  }

  const mid = pageWidth / 2
  const tolerance = pageWidth * 0.02
  let left = 0
  let right = 0
  let full = 0

  for (const f of frags) {
    // 判定通栏的唯一可靠标准是「跨越版面中线」。
    // 用宽度比例判断会漏掉那些刚好差几个像素的跨栏摘要，
    // 而一旦摘要被算进某一栏，那一栏的栏宽统计就被撑爆，
    // 结果是整栏正文永远拼不成段落。
    const crossesMiddle = f.x0 < mid - tolerance && f.x1 > mid + tolerance
    if (crossesMiddle) {
      f.col = 2
      full++
    } else if (f.x0 >= mid - tolerance) {
      f.col = 1
      right++
    } else {
      f.col = 0
      left++
    }
  }

  const body = frags.length - full
  const twoColumn = body >= 8 && right >= body * 0.18 && left >= body * 0.18

  if (!twoColumn) {
    // 单栏版式：所有内容（包括标题）放回同一栏，按 y 顺序拼接
    for (const f of frags) f.col = 0
  }
}

function buildText(lines: Frag[]): { text: string; segments: CharSegment[] } {
  let text = ''
  const segments: CharSegment[] = []

  for (let li = 0; li < lines.length; li++) {
    const frag = lines[li]
    if (li > 0 && !/\s$/.test(text)) text += ' '

    let prevX1: number | null = null
    for (const span of frag.spans) {
      if (span.text.length === 0) continue

      if (prevX1 !== null) {
        const gap = span.x0 - prevX1
        const needsSpace =
          gap > Math.max(span.fontSize * 0.22, 1.2) && !/\s$/.test(text) && !/^\s/.test(span.text)
        if (needsSpace) text += ' '
      }

      segments.push({ el: span.el, blockStart: text.length, spanStart: 0, len: span.text.length })
      text += span.text
      prevX1 = span.x1
    }
  }

  // 注意：这里故意不删除行末连字符（"pro- posed"）。
  // 删掉会让字符偏移和 segments 对不上，高亮就会错位。
  // 去连字符放到送模型之前做，见 cleanForModel()。
  return { text, segments }
}

const MATH_CHAR = /[∑∫√≈≤≥±×÷∂∇∞∏∈∪∩⊂⊆∀∃αβγδεζηθικλμνξοπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]/

function classify(
  raw: RawBlock,
  text: string,
  pageWidth: number,
  pageHeight: number,
  bodyFont: number
): BlockKind {
  const trimmed = text.trim()
  const cy = (raw.y0 + raw.y1) / 2
  const width = raw.x1 - raw.x0

  if (cy < pageHeight * 0.075 && raw.fontSize <= bodyFont * 1.15) return 'header'
  if (cy > pageHeight * 0.93 && raw.fontSize <= bodyFont * 1.15) return 'footer'
  if (width < pageWidth * 0.09 && /^\d{1,3}$/.test(trimmed)) return 'lineno'
  if (/^(fig\.?|figure|table|algorithm)\s*\d/i.test(trimmed)) return 'caption'
  if (trimmed.length >= 3) {
    let mathChars = 0
    for (const ch of trimmed) if (MATH_CHAR.test(ch)) mathChars++
    if (mathChars / trimmed.length > 0.12) return 'math'
  }
  return 'body'
}

/* ------------------------------------------------------------------ */

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[index]
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  return percentile(values, 0.5)
}

/**
 * 送模型前的文本清理：
 * · 拼接跨行断词  "pro- posed" → "proposed"
 * · 合并多余空白
 * 只在「发给模型」时用，不改变 block.text，所以不影响字符偏移。
 */
export function cleanForModel(text: string): string {
  return text
    .replace(/([A-Za-z])-[ \t]*(?=[a-z])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 找出所有 block 的上下文邻接块（跳过页眉页脚行号） */
export function neighborBlocks(
  model: PageTextModel,
  block: TextBlock,
  radius = 2
): { before: TextBlock[]; after: TextBlock[] } {
  const usable = model.blocks.filter((b) => b.kind === 'body' || b.kind === 'caption')
  const index = usable.indexOf(block)
  if (index < 0) return { before: [], after: [] }
  return {
    before: usable.slice(Math.max(0, index - radius), index),
    after: usable.slice(index + 1, index + 1 + radius)
  }
}
