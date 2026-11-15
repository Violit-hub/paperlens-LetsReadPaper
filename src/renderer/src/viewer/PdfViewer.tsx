import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MutableRefObject
} from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { renderTextLayer } from './textLayer'
import { buildPageTextModel, type PageTextModel } from './pageTextModel'

export interface PdfViewerHandle {
  scrollToPage: (page: number) => void
  currentPage: () => number
}

interface Props {
  pdf: PDFDocumentProxy | null
  pageSizes: Array<{ width: number; height: number }>
  scale: number
  models: MutableRefObject<Map<number, PageTextModel>>
  onCurrentPageChange?: (page: number) => void
  onFirstPageReady?: () => void
}

/**
 * 文献阅读区。只渲染视口附近的页面（rootMargin 1200px），
 * 每页渲染完立刻重建 PageTextModel 并塞进 models。
 */
export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { pdf, pageSizes, scale, models, onCurrentPageChange, onFirstPageReady },
  ref
) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef(new Map<number, HTMLDivElement>())

  useImperativeHandle(ref, () => ({
    scrollToPage(page: number) {
      const el = pageRefs.current.get(page)
      const scroller = scrollerRef.current
      if (!el || !scroller) return
      scroller.scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' })
    },
    currentPage() {
      return computeCurrentPage(scrollerRef.current, pageRefs.current)
    }
  }))

  const handleScroll = useCallback(() => {
    const page = computeCurrentPage(scrollerRef.current, pageRefs.current)
    onCurrentPageChange?.(page)
  }, [onCurrentPageChange])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    let frame = 0
    const onScroll = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        handleScroll()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [handleScroll])

  const attachPageRef = useCallback((page: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(page, el)
    else pageRefs.current.delete(page)
    // 注意：这里绝对不能 setState。ref 回调每次 commit 都会执行，
    // 在里面更新 state 会造成「渲染 → commit → setState → 渲染」的死循环。
  }, [])

  if (!pdf) return <div className="scroller" ref={scrollerRef} />

  return (
    <div className="scroller" ref={scrollerRef}>
      <div className="pages">
        {pageSizes.map((size, index) => (
          <PageView
            key={index + 1}
            pdf={pdf}
            pageNumber={index + 1}
            scale={scale}
            size={size}
            models={models}
            attachRef={attachPageRef}
            onReady={index === 0 ? onFirstPageReady : undefined}
          />
        ))}
      </div>
    </div>
  )
})

/* ------------------------------------------------------------------ */

interface PageViewProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  size: { width: number; height: number }
  models: MutableRefObject<Map<number, PageTextModel>>
  attachRef: (page: number, el: HTMLDivElement | null) => void
  onReady?: () => void
}

function PageView({ pdf, pageNumber, scale, size, models, attachRef, onReady }: PageViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState(false)
  const renderSeq = useRef(0)
  const [padHeight, setPadHeight] = useState<{ w: number; h: number } | null>(null)
  const [rendered, setRendered] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setPadHeight({ w: size.width * scale, h: size.height * scale })
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(true)
        }
      },
      { rootMargin: '1200px 0px 1200px 0px' }
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [size.width, size.height, scale])

  useEffect(() => {
    if (!active) return
    const host = hostRef.current
    if (!host) return

    const seq = ++renderSeq.current
    let cancelled = false

    // 重新渲染会让旧的 span 引用失效，模型必须重建成新的
    models.current.delete(pageNumber)

    const run = async (): Promise<void> => {
      const page: PDFPageProxy = await pdf.getPage(pageNumber)
      if (cancelled || seq !== renderSeq.current) return

      const viewport = page.getViewport({ scale })
      const dpr = window.devicePixelRatio || 1

      host.replaceChildren()
      host.style.width = `${viewport.width}px`
      host.style.height = `${viewport.height}px`

      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      host.appendChild(canvas)

      await page.render({
        canvasContext: ctx,
        viewport,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      } as never).promise

      if (cancelled || seq !== renderSeq.current) return

      const textContent = await page.getTextContent()
      if (cancelled || seq !== renderSeq.current) return

      const layer = renderTextLayer(viewport, textContent)
      host.appendChild(layer.el)

      // 必须已经挂到 DOM 上，否则 getBoundingClientRect 全是 0
      const model = buildPageTextModel(host, layer.el, pageNumber)

      if (cancelled || seq !== renderSeq.current) return
      models.current.set(pageNumber, model)
      setRendered(true)
      onReady?.()
    }

    run().catch((error) => {
      if (!cancelled) console.error(`[paperlens] 第 ${pageNumber} 页渲染失败`, error)
    })

    return () => {
      cancelled = true
    }
  }, [active, scale, pageNumber, pdf, models, onReady])

  return (
    <div
      className={`page${rendered ? '' : ' page-placeholder'}`}
      // 这个节点的子元素完全由 useEffect 里的命令式 DOM 操作管理。
      // 千万不要在这里放 React 子节点：后面的 host.replaceChildren() 会把它们删掉，
      // React 再更新时就会因为找不到节点而崩溃。
      ref={(el) => {
        hostRef.current = el
        attachRef(pageNumber, el)
      }}
      style={{
        width: padHeight?.w,
        height: padHeight?.h,
        minHeight: 40
      }}
      data-page={pageNumber}
    />
  )
}

/* ------------------------------------------------------------------ */

function computeCurrentPage(
  scroller: HTMLDivElement | null,
  pages: Map<number, HTMLDivElement>
): number {
  if (!scroller) return 1
  const anchor = scroller.scrollTop + scroller.clientHeight * 0.35
  let current = 1
  let bestDelta = Number.POSITIVE_INFINITY
  for (const [page, el] of pages) {
    const center = el.offsetTop + el.offsetHeight / 2
    const delta = Math.abs(center - anchor)
    if (delta < bestDelta) {
      bestDelta = delta
      current = page
    }
  }
  return current
}
