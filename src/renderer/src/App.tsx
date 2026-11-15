import { useCallback, useEffect, useRef, useState } from 'react'
import { parseTranslationError } from './ai/errors'
import { runTask } from './ai/client'
import {
  extractDocContext,
  formatGlossary,
  getDocContext,
  saveDocContext,
  type DocContext
} from './doc-context'
import { hasBridge } from './platform'
import { EmptyState } from './ui/EmptyState'
import { SettingsDialog } from './ui/SettingsDialog'
import { Toolbar } from './ui/Toolbar'
import { TranslationPanel, type TranslationState } from './ui/TranslationPanel'
import { PdfViewer, type PdfViewerHandle } from './viewer/PdfViewer'
import type { PageTextModel } from './viewer/pageTextModel'
import { loadPdf, type LoadedDoc } from './viewer/pdf'
import { extractSelection, type ExtractedSelection } from './viewer/selection'

declare global {
  interface Window {
    /** 自动化测试钩子，只在渲染进程里存在，不参与产品逻辑 */
    __paperlens?: {
      debugInfo: () => Record<string, unknown>
      listBlocks: () => Array<Record<string, unknown>>
      selectBlock: (page: number, index: number, start?: number, end?: number) => string
    }
  }
}

const IDLE: TranslationState = { status: 'idle', text: '' }
const PROVIDER_STORAGE = 'paperlens.provider'

export default function App() {
  const [doc, setDoc] = useState<LoadedDoc | null>(null)
  const [loading, setLoading] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [scale, setScale] = useState(1.3)
  const [currentPage, setCurrentPage] = useState(1)
  const [selection, setSelection] = useState<ExtractedSelection | null>(null)
  const [translation, setTranslation] = useState<TranslationState>(IDLE)
  const [explanation, setExplanation] = useState<TranslationState>(IDLE)
  const [autoExplain, setAutoExplain] = useState<boolean>(() => {
    try {
      return localStorage.getItem('paperlens.autoExplain') !== '0'
    } catch {
      return true
    }
  })
  const [docContext, setDocContext] = useState<DocContext | null>(null)
  const [contextStatus, setContextStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [provider, setProvider] = useState<string>(() => {
    try {
      return localStorage.getItem(PROVIDER_STORAGE) ?? 'deepseek'
    } catch {
      return 'deepseek'
    }
  })

  const modelsRef = useRef<Map<number, PageTextModel>>(new Map())
  const viewerRef = useRef<PdfViewerHandle>(null)
  const seqRef = useRef(0)
  const explainSeqRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /* ---------------------------------------------------------------- 文档 */

  const loadDocument = useCallback(async (data: Uint8Array, name: string, path: string | null) => {
    setLoading(true)
    setOpenError(null)
    try {
      const loaded = await loadPdf(data, name, path)
      modelsRef.current.clear()
      seqRef.current += 1
      explainSeqRef.current += 1
      setDoc(loaded)
      setSelection(null)
      setTranslation(IDLE)
      setExplanation(IDLE)
      setCurrentPage(1)
    } catch (error) {
      setOpenError(`打开失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadFromFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        setToast('只支持 PDF 文件')
        return
      }
      const data = new Uint8Array(await file.arrayBuffer())
      await loadDocument(data, file.name, null)
    },
    [loadDocument]
  )

  const openDialog = useCallback(async () => {
    if (hasBridge()) {
      const result = await window.api!.openPdf()
      if (!result) return
      await loadDocument(result.data, result.name, result.path)
    } else {
      fileInputRef.current?.click()
    }
  }, [loadDocument])

  /* ---------------------------------------------------------- 文档上下文 */

  // 打开论文后抽一次「标题 + 摘要 + 术语表」，之后每段翻译都复用。
  // 注意这里不是「每篇论文一个对话会话」：固定前缀才能命中模型侧的 prompt cache，
  // 逐轮追加的历史只会把前缀打断。
  useEffect(() => {
    if (!doc) {
      setDocContext(null)
      setContextStatus('idle')
      return
    }

    let cancelled = false
    setDocContext(null)
    setContextStatus('loading')

    void (async () => {
      const cached = await getDocContext(doc.docId)
      if (cancelled) return
      if (cached) {
        setDocContext(cached)
        setContextStatus('ready')
        return
      }

      // 抽术语要用第一页重建出来的干净文本，等它渲染完
      const model = await waitForFirstPage(modelsRef)
      if (cancelled) return
      if (!model) {
        setContextStatus('failed')
        return
      }

      const pageText = model.blocks
        .filter((block) => block.kind === 'body' || block.kind === 'caption')
        .map((block) => block.text)
        .join('\n\n')

      const extracted = await extractDocContext({
        docId: doc.docId,
        provider,
        pageText
      })
      if (cancelled) return

      if (extracted) {
        setDocContext(extracted)
        setContextStatus('ready')
        void saveDocContext(extracted)
      } else {
        setContextStatus('failed')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [doc, provider])

  /* ---------------------------------------------------------- 翻译 / 讲解 */

  const explain = useCallback(
    async (target: ExtractedSelection, force = false) => {
      const seq = ++explainSeqRef.current
      setExplanation({ status: 'loading', text: '' })

      try {
        const result = await runTask(
          'explain',
          {
            text: target.modelText,
            before: target.before,
            after: target.after,
            title: docContext?.title,
            abstract: docContext?.abstract,
            glossary: docContext ? formatGlossary(docContext.glossary) : undefined
          },
          { provider, useCache: !force },
          (delta) => {
            if (seq !== explainSeqRef.current) return
            setExplanation((prev) => ({ status: 'streaming', text: prev.text + delta }))
          }
        )

        if (seq !== explainSeqRef.current) return
        setExplanation({
          status: 'done',
          text: result.text,
          cached: result.cached,
          elapsedMs: result.elapsedMs
        })
      } catch (error) {
        if (seq !== explainSeqRef.current) return
        setExplanation({ status: 'error', text: '', error: parseTranslationError(error) })
      }
    },
    [provider, docContext]
  )

  const translate = useCallback(
    async (target: ExtractedSelection, force = false) => {
      const seq = ++seqRef.current
      // 换段就作废上一段的讲解
      explainSeqRef.current += 1
      setTranslation({ status: 'loading', text: '' })
      setExplanation(IDLE)

      const input = {
        text: target.modelText,
        before: target.before,
        after: target.after,
        title: docContext?.title,
        abstract: docContext?.abstract,
        glossary: docContext ? formatGlossary(docContext.glossary) : undefined
      }

      let explainKicked = false

      try {
        const result = await runTask('translate', input, { provider, useCache: !force }, (delta) => {
          if (seq !== seqRef.current) return
          setTranslation((prev) => ({
            status: 'streaming',
            text: prev.text + delta,
            cached: prev.cached
          }))

          // 译文首字一到就并行去生成讲解，别让用户盯着空的下半区干等
          if (!explainKicked && autoExplain) {
            explainKicked = true
            void explain(target)
          }
        })

        if (seq !== seqRef.current) return
        setTranslation({
          status: 'done',
          text: result.text,
          cached: result.cached,
          elapsedMs: result.elapsedMs
        })
      } catch (error) {
        if (seq !== seqRef.current) return
        setTranslation({
          status: 'error',
          text: '',
          error: parseTranslationError(error)
        })
      }
    },
    [provider, docContext, autoExplain, explain]
  )

  /* ------------------------------------------------------------ 选区监听 */

  useEffect(() => {
    if (!doc) return

    let timer = 0

    const run = (delay: number): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const models = Array.from(modelsRef.current.values())
        if (models.length === 0) return

        const extracted = extractSelection(models)
        if (!extracted || extracted.modelText.length < 2) return

        setSelection(extracted)
        void translate(extracted)
      }, delay)
    }

    const onPointerUp = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      // 面板、弹窗、工具栏上的点击不算「划选」
      if (target?.closest('.panel, .modal, .toolbar, input, textarea, select')) return
      run(120)
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      // 键盘选择（Shift + 方向键）不会触发 pointerup
      if (event.key === 'Shift' || event.key.startsWith('Arrow')) run(260)
    }

    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [doc, translate])

  /* -------------------------------------------------------------- 快捷键 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openDialog()
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '0') {
        event.preventDefault()
        setScale(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openDialog, settingsOpen])

  /* -------------------------------------------------- 开发/自动化辅助 */

  // ?sample=1 自动加载内置示例论文，方便验证版面重建
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('sample')) return
    void (async () => {
      try {
        const response = await fetch('/sample-paper.pdf')
        if (!response.ok) return
        const buffer = new Uint8Array(await response.arrayBuffer())
        await loadDocument(buffer, 'sample-paper.pdf', null)
      } catch (error) {
        console.error('[paperlens] 加载示例论文失败', error)
      }
    })()
  }, [loadDocument])

  // 暴露给外部脚本：列出重建出的段落、程序化构造选区
  useEffect(() => {
    window.__paperlens = {
      debugInfo: () => ({
        pages: modelsRef.current.size,
        blocks: Array.from(modelsRef.current.values()).reduce((sum, m) => sum + m.blocks.length, 0),
        status: translation.status,
        errorKind: translation.error?.kind ?? null,
        errorMessage: translation.error?.message ?? null,
        errorDetail: translation.error?.detail?.slice(0, 200) ?? null,
        explanationStatus: explanation.status,
        explainChars: explanation.text.length,
        cached: translation.cached ?? false,
        selectionPages: selection?.pages ?? [],
        hasBridge: hasBridge(),
        contextStatus,
        docContext: docContext
          ? {
              title: docContext.title.slice(0, 70),
              terms: docContext.glossary.length,
              glossary: docContext.glossary.slice(0, 8)
            }
          : null,
        selection: selection
          ? {
              words: selection.wordCount,
              pages: selection.pages,
              // 送模型的文本：连字符应已被拼接（"ques- tion" → "question"）
              modelText: selection.modelText.slice(0, 260)
            }
          : null
      }),
      listBlocks: () => {
        const out: Array<Record<string, unknown>> = []
        for (const model of modelsRef.current.values()) {
          for (let index = 0; index < model.blocks.length; index++) {
            const block = model.blocks[index]
            out.push({
              page: model.page,
              index,
              id: block.id,
              kind: block.kind,
              chars: block.text.length,
              lines: block.lineCount,
              fontSize: Math.round(block.fontSize * 10) / 10,
              bbox: [
                Math.round(block.bbox.x0),
                Math.round(block.bbox.y0),
                Math.round(block.bbox.x1),
                Math.round(block.bbox.y1)
              ],
              text: block.text.slice(0, 110)
            })
          }
        }
        return out
      },
      selectBlock: (page: number, index: number, start?: number, end?: number) => {
        const model = modelsRef.current.get(page)
        if (!model) return 'no-model'
        const block = model.blocks[index]
        if (!block) return 'no-block'

        const from = start ?? 0
        const to = end ?? block.text.length
        const segments = block.segments.filter(
          (seg) => seg.blockStart + seg.len > from && seg.blockStart < to
        )
        if (segments.length === 0) return 'no-segments'

        const first = segments[0]
        const last = segments[segments.length - 1]
        const firstNode = first.el.firstChild
        const lastNode = last.el.firstChild
        if (!firstNode || !lastNode) return 'no-text-node'

        try {
          const range = document.createRange()
          range.setStart(firstNode, Math.max(0, from - first.blockStart))
          range.setEnd(lastNode, Math.min(last.len, to - last.blockStart))
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(range)
        } catch (error) {
          return `range-failed: ${String(error)}`
        }

        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        return `ok ${block.id} chars=${to - from}`
      }
    }
  }, [translation.status, explanation.status, selection])

  /* ------------------------------------------------------------------ */

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 2000)
  }, [])

  const changeProvider = useCallback((next: string) => {
    setProvider(next)
    try {
      localStorage.setItem(PROVIDER_STORAGE, next)
    } catch {
      /* ignore */
    }
  }, [])

  const zoom = useCallback((delta: number) => {
    setScale((value) => {
      const next = Math.round((value + delta) * 100) / 100
      return Math.min(4, Math.max(0.4, next))
    })
  }, [])

  const fitWidth = useCallback(() => {
    if (!doc) return
    const scroller = document.querySelector('.scroller')
    if (!(scroller instanceof HTMLElement)) return
    const available = scroller.clientWidth - 88
    const pageWidth = doc.pageSizes[0]?.width ?? 612
    setScale(Math.min(4, Math.max(0.4, available / pageWidth)))
  }, [doc])

  return (
    <div
      className="app"
      onDragOver={(event) => {
        event.preventDefault()
        if (!dragging) setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        const file = event.dataTransfer.files[0]
        if (file) void loadFromFile(file)
      }}
    >
      <Toolbar
        docName={doc?.name ?? null}
        currentPage={currentPage}
        totalPages={doc?.pageSizes.length ?? 0}
        scale={scale}
        busy={loading}
        onOpen={() => void openDialog()}
        onJump={(page) => viewerRef.current?.scrollToPage(page)}
        onZoom={zoom}
        onFit={fitWidth}
        onSettings={() => setSettingsOpen(true)}
      />

      {loading && <div className="loading-bar" />}

      <div className="workspace">
        <PdfViewer
          key={doc?.name ?? 'empty'}
          ref={viewerRef}
          pdf={doc?.pdf ?? null}
          pageSizes={doc?.pageSizes ?? []}
          scale={scale}
          models={modelsRef}
          onCurrentPageChange={setCurrentPage}
        />

        {!doc && !loading && (
          <EmptyState dragging={dragging} error={openError} onOpen={() => void openDialog()} />
        )}

        {doc && (
          <TranslationPanel
            selection={selection}
            state={translation}
            explanation={explanation}
            provider={provider}
            glossary={docContext?.glossary ?? []}
            contextStatus={contextStatus}
            autoExplain={autoExplain}
            onRetranslate={() => selection && void translate(selection, true)}
            onExplain={() => selection && void explain(selection, true)}
            onToggleAutoExplain={(next) => {
              setAutoExplain(next)
              try {
                localStorage.setItem('paperlens.autoExplain', next ? '1' : '0')
              } catch {
                /* ignore */
              }
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
      </div>

      <SettingsDialog
        open={settingsOpen}
        provider={provider}
        onProviderChange={changeProvider}
        onClose={() => setSettingsOpen(false)}
        onToast={showToast}
      />

      {toast && <div className="toast">{toast}</div>}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void loadFromFile(file)
          event.target.value = ''
        }}
      />
    </div>
  )
}

/**
 * 等第一页版面重建完成。
 * 术语表要基于干净文本抽取，而第一页是懒渲染的，所以这里得等一小会儿。
 */
async function waitForFirstPage(
  models: { current: Map<number, PageTextModel> },
  timeoutMs = 12000
): Promise<PageTextModel | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const model = models.current.get(1)
    if (model && model.blocks.length > 0) return model
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}
