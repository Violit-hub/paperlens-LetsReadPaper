import { useState } from 'react'
import { isRetryable, needsSettings, type TranslationError } from '../ai/errors'
import { matchGlossary, type GlossaryEntry } from '../doc-context'
import type { ExtractedSelection } from '../viewer/selection'

export interface TranslationState {
  status: 'idle' | 'loading' | 'streaming' | 'done' | 'error'
  text: string
  error?: TranslationError
  cached?: boolean
  elapsedMs?: number
}

interface Props {
  selection: ExtractedSelection | null
  state: TranslationState
  explanation: TranslationState
  provider: string
  glossary: GlossaryEntry[]
  contextStatus: 'idle' | 'loading' | 'ready' | 'failed'
  autoExplain: boolean
  onRetranslate: () => void
  onExplain: () => void
  onToggleAutoExplain: (next: boolean) => void
  onOpenSettings: () => void
}

export function TranslationPanel({
  selection,
  state,
  explanation,
  provider,
  glossary,
  contextStatus,
  autoExplain,
  onRetranslate,
  onExplain,
  onToggleAutoExplain,
  onOpenSettings
}: Props) {
  const [copied, setCopied] = useState<'translate' | 'explain' | null>(null)

  const matchedTerms = selection ? matchGlossary(selection.modelText, glossary) : []

  const copy = async (kind: 'translate' | 'explain', text: string): Promise<void> => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      window.setTimeout(() => setCopied(null), 1400)
    } catch {
      /* 剪贴板不可用时静默失败 */
    }
  }

  const pages = selection
    ? selection.pages.length > 1
      ? `${selection.pages[0]}–${selection.pages[selection.pages.length - 1]}`
      : String(selection.pages[0] ?? 1)
    : ''

  if (!selection) {
    return (
      <aside className="panel">
        <header className="panel-header">
          <span className="label">AI 阅读</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onOpenSettings} title="设置">
            设置
          </button>
        </header>
        <div className="panel-empty">
          <div className="panel-empty-title">划一段开始</div>
          <div className="panel-empty-hint">
            在左侧论文里用鼠标划选一段文字，这里会同时给出
            <strong> 翻译 </strong>和<strong> 讲解</strong>。
          </div>
        </div>
      </aside>
    )
  }

  return (
    <aside
      className="panel"
      // 点击面板时不要清掉正文的选区
      onMouseDown={(event) => {
        const target = event.target as HTMLElement
        if (!target.closest('button, input, textarea, a, select, summary')) event.preventDefault()
      }}
    >
      <header className="panel-header">
        <span className="label">AI 阅读</span>
        <span className="meta">
          p.{pages} · {selection.wordCount} 词
        </span>
        <span style={{ flex: 1 }} />
        {state.status === 'done' && state.cached && <span className="badge">译文缓存</span>}
        <button className="btn ghost" onClick={onOpenSettings} title="设置">
          设置
        </button>
      </header>

      <div className="panel-split">
        {/* ------------------------------------------------ 上半：翻译 */}
        <section className="pane pane-translation">
          <div className="pane-head">
            翻译
            {state.status === 'done' && !state.cached && state.elapsedMs != null && (
              <span className="pane-meta">{(state.elapsedMs / 1000).toFixed(1)}s</span>
            )}
          </div>

          <div className="source">
            <span className="source-label">原文</span>
            {selection.displayText}
          </div>

          {state.status === 'loading' && (
            <div className="skeleton">
              <div className="bar" style={{ width: '88%' }} />
              <div className="bar" style={{ width: '96%' }} />
              <div className="bar" style={{ width: '72%' }} />
            </div>
          )}

          {state.status === 'error' && state.error && (
            <div className="notice error">
              <div className="notice-message">{state.error.message}</div>
              {state.error.hint && <div className="notice-hint">{state.error.hint}</div>}
              <div className="notice-actions">
                {needsSettings(state.error.kind) && (
                  <button className="btn" onClick={onOpenSettings}>
                    打开设置
                  </button>
                )}
                {(isRetryable(state.error.kind) || state.error.kind === 'unknown') && (
                  <button className="btn ghost" onClick={onRetranslate}>
                    重试
                  </button>
                )}
              </div>
              {state.error.detail && (
                <details className="notice-detail">
                  <summary>技术细节</summary>
                  <pre>{state.error.detail}</pre>
                </details>
              )}
            </div>
          )}

          {(state.status === 'streaming' || state.status === 'done') && (
            <div className="translation">
              {state.text}
              {state.status === 'streaming' && <span className="caret" />}
            </div>
          )}

          {matchedTerms.length > 0 && (
            <div className="glossary">
              <div className="glossary-head">这段里的术语</div>
              <div className="glossary-list">
                {matchedTerms.map((term) => (
                  <span className="term" key={term.en}>
                    <span className="term-en">{term.en}</span>
                    <span className="term-zh">{term.zh}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ------------------------------------------------ 下半：讲解 */}
        <section className="pane pane-explain">
          <div className="pane-head">
            讲解
            <span style={{ flex: 1 }} />
            <label className="auto-toggle" title="划选后自动生成讲解">
              <input
                type="checkbox"
                checked={autoExplain}
                onChange={(event) => onToggleAutoExplain(event.target.checked)}
              />
              自动
            </label>
            {explanation.status === 'done' && explanation.cached && (
              <span className="pane-meta">缓存</span>
            )}
          </div>

          {explanation.status === 'idle' && (
            <div className="pane-placeholder">
              划选后会用大白话讲一遍这段在做什么、为什么这么做。
              <button className="btn ghost" style={{ marginTop: 10 }} onClick={onExplain}>
                生成讲解
              </button>
            </div>
          )}

          {explanation.status === 'loading' && (
            <div className="skeleton">
              <div className="bar" style={{ width: '92%' }} />
              <div className="bar" style={{ width: '84%' }} />
              <div className="bar" style={{ width: '60%' }} />
            </div>
          )}

          {explanation.status === 'error' && explanation.error && (
            <div className="notice error">
              <div className="notice-message">{explanation.error.message}</div>
              {explanation.error.hint && <div className="notice-hint">{explanation.error.hint}</div>}
              <div className="notice-actions">
                {needsSettings(explanation.error.kind) && (
                  <button className="btn" onClick={onOpenSettings}>
                    打开设置
                  </button>
                )}
                <button className="btn ghost" onClick={onExplain}>
                  重试
                </button>
              </div>
            </div>
          )}

          {(explanation.status === 'streaming' || explanation.status === 'done') && (
            <div className="explanation">
              {explanation.text}
              {explanation.status === 'streaming' && <span className="caret" />}
            </div>
          )}
        </section>
      </div>

      <footer className="panel-footer">
        <button className="btn" onClick={() => void copy('translate', state.text)} disabled={!state.text}>
          {copied === 'translate' ? '已复制' : '复制译文'}
        </button>
        <button
          className="btn ghost"
          onClick={() => void copy('explain', explanation.text)}
          disabled={!explanation.text}
        >
          {copied === 'explain' ? '已复制' : '复制讲解'}
        </button>
        <span style={{ flex: 1 }} />
        {contextStatus === 'loading' && <span className="pane-meta">提取术语表…</span>}
        {contextStatus === 'ready' && glossary.length > 0 && (
          <span className="pane-meta">术语 {glossary.length}</span>
        )}
        <span className="pane-meta">{provider}</span>
      </footer>
    </aside>
  )
}
