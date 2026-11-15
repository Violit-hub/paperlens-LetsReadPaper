import { Util } from 'pdfjs-dist'

/**
 * pdf.js 的文本层渲染。
 *
 * 我们不用官方的 TextLayer/TextLayerBuilder，而是自己画 —— 因为后面整套
 * 「版面重建 → 选区 → 高亮」都要求我们能完全掌控 DOM 结构，并给每个
 * span 挂上自己的标记。官方实现只保证「能选中」，不保证结构稳定。
 *
 * 只用 pdf.js 里跨版本最稳的 API：getTextContent() 的 item 结构 +
 * Util.transform()。这套结构从 2.x 到 5.x 没变过。
 */

/** item.transform 是 6 元组矩阵 [a,b,c,d,e,f]；相同于 pdf.js 的 TextItem */
interface TextItemLike {
  str: string
  dir?: string
  width?: number
  height?: number
  transform?: number[]
  fontName?: string
}

export interface ViewportLike {
  width: number
  height: number
  scale: number
  transform: number[]
}

/** span 顶部到基线的距离占字号的比例。用 0.8 近似 ascent。 */
const ASCENT_RATIO = 0.8

let measureCtx: CanvasRenderingContext2D | null = null

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx
  const canvas = document.createElement('canvas')
  measureCtx = canvas.getContext('2d')
  return measureCtx
}

export interface TextLayerResult {
  el: HTMLDivElement
  spans: HTMLSpanElement[]
}

/**
 * 把一页的文字画进 textLayer。
 * 文字是透明的（color: transparent），只用于框选和高亮，视觉文字来自 canvas。
 */
export function renderTextLayer(
  viewport: ViewportLike,
  textContent: { items: Array<TextItemLike | unknown> }
): TextLayerResult {
  const layer = document.createElement('div')
  layer.className = 'textLayer'
  layer.style.width = `${viewport.width}px`
  layer.style.height = `${viewport.height}px`

  const fragment = document.createDocumentFragment()
  const spans: HTMLSpanElement[] = []
  const ctx = getMeasureCtx()

  for (const raw of textContent.items) {
    const item = raw as TextItemLike
    if (typeof item.str !== 'string' || item.str.length === 0) continue
    if (!Array.isArray(item.transform)) continue

    // PDF 用户空间 → 视口坐标
    const tx = Util.transform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    if (!Number.isFinite(fontHeight) || fontHeight < 0.1) continue

    const left = tx[4]
    const baseline = tx[5]
    if (!Number.isFinite(left) || !Number.isFinite(baseline)) continue

    const span = document.createElement('span')
    span.textContent = item.str

    span.style.left = `${left.toFixed(2)}px`
    span.style.top = `${(baseline - fontHeight * ASCENT_RATIO).toFixed(2)}px`
    span.style.fontSize = `${fontHeight.toFixed(2)}px`
    span.style.height = `${fontHeight.toFixed(2)}px`
    span.style.fontFamily = 'sans-serif'

    // 横向拉伸：让 span 的视觉宽度和 PDF 里记录的文字宽度一致。
    // 这决定了整行文字的右端是否对齐，对「选中一行」的准确性影响很大。
    const targetWidth = (item.width ?? 0) * viewport.scale
    if (targetWidth > 1 && ctx) {
      ctx.font = `${fontHeight}px sans-serif`
      const natural = ctx.measureText(item.str).width
      if (natural > 0.5) {
        const sx = targetWidth / natural
        if (Math.abs(sx - 1) > 0.03 && sx > 0.1 && sx < 10) {
          span.style.transform = `scaleX(${sx.toFixed(4)})`
        }
      }
    }

    // 旋转文本（图表标注里偶尔有）。正文几乎不会走到这里。
    const angle = Math.atan2(tx[1], tx[0])
    if (Math.abs(angle) > 0.02) {
      span.style.transform = `${span.style.transform ?? ''} rotate(${angle.toFixed(5)}rad)`
    }

    fragment.appendChild(span)
    spans.push(span)
  }

  layer.appendChild(fragment)
  return { el: layer, spans }
}
