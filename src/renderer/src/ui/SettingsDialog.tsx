import { useEffect, useState } from 'react'
import { DEFAULT_EXPLAIN_TASK, DEFAULT_TRANSLATE_TASK } from '../ai/prompts'
import { clearCache } from '../cache'
import { getWebKey, hasBridge, isMockMode, setMockMode, setWebKey } from '../platform'
import { hasPromptOverride, readPromptOverride, writePromptOverride } from '../settings'

interface Props {
  open: boolean
  provider: string
  onProviderChange: (provider: string) => void
  onClose: () => void
  onToast: (message: string) => void
}

export function SettingsDialog({ open, provider, onProviderChange, onClose, onToast }: Props) {
  const [keyInput, setKeyInput] = useState('')
  const [mask, setMask] = useState<string | null>(null)
  const [mock, setMock] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [translatePrompt, setTranslatePrompt] = useState(DEFAULT_TRANSLATE_TASK)
  const [explainPrompt, setExplainPrompt] = useState(DEFAULT_EXPLAIN_TASK)
  const [promptOpen, setPromptOpen] = useState(false)
  const [hasCustom, setHasCustom] = useState(false)
  const hasKey = mask !== null

  useEffect(() => {
    if (!open) return
    setMock(isMockMode())
    setTranslatePrompt(readPromptOverride('translate') ?? DEFAULT_TRANSLATE_TASK)
    setExplainPrompt(readPromptOverride('explain') ?? DEFAULT_EXPLAIN_TASK)
    setHasCustom(hasPromptOverride('translate') || hasPromptOverride('explain'))
    if (hasBridge()) {
      setKeyInput('')
      void window.api!.getSecretMask(provider).then(setMask)
    } else {
      const stored = getWebKey()
      setKeyInput(stored)
      setMask(stored ? `••••${stored.slice(-4)}` : null)
    }
  }, [open, provider])

  if (!open) return null

  const save = async (): Promise<void> => {
    const value = keyInput.trim()
    if (hasBridge()) {
      if (value) {
        await window.api!.setSecret(provider, value)
        setMask(`••••${value.slice(-4)}`)
      } else if (value === '') {
        await window.api!.clearSecret(provider)
        setMask(null)
      }
    } else {
      setWebKey(value)
      setMockMode(mock)
      setMask(value ? `••••${value.slice(-4)}` : null)
    }
    setKeyInput('')

    // prompt 覆盖：内容等于默认值就删除，避免存一份同步不了的副本
    writePromptOverride('translate', translatePrompt, DEFAULT_TRANSLATE_TASK)
    writePromptOverride('explain', explainPrompt, DEFAULT_EXPLAIN_TASK)
    setHasCustom(hasPromptOverride('translate') || hasPromptOverride('explain'))

    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 1600)
    onToast('已保存')
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal">
        <h2>设置</h2>
        <div className="sub">
          论文内容只在本机处理，划选时仅把选中的段落与相邻上下文发给模型，不上传整篇 PDF。
        </div>

        <div className="field">
          <label>模型提供方</label>
          <select value={provider} onChange={(event) => onProviderChange(event.target.value)}>
            <option value="deepseek">DeepSeek（deepseek-chat）</option>
            <option value="ollama">Ollama 本地（127.0.0.1:11434）</option>
          </select>
          <div className="help">
            {provider === 'ollama'
              ? '需要先在本地运行 ollama serve 并 pull 一个模型，完全离线，不产生费用。'
              : '默认使用 deepseek-chat，中文表达好、价格低，适合长段落翻译。'}
          </div>
        </div>

        {provider !== 'ollama' && (
          <div className="field">
            <label>
              API Key
              {hasKey && <span style={{ color: 'var(--ok)' }}> · 当前保存的是 {mask}</span>}
            </label>
            <input
              type="password"
              placeholder={hasKey ? '已保存，留空则保持不变' : 'sk-...'}
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="help">
              {hasBridge()
                ? 'Key 通过系统加密存储（safeStorage）保存在主进程，渲染进程拿不到明文。'
                : '当前是浏览器调试模式，Key 会存在 localStorage。正式版请使用桌面端。'}
            </div>
          </div>
        )}

        {!hasBridge() && (
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={mock}
                onChange={(event) => setMock(event.target.checked)}
                style={{ width: 'auto', marginRight: 8, verticalAlign: 'middle' }}
              />
              使用模拟译文（不请求网络，用来验证界面）
            </label>
          </div>
        )}

        <div className="field">
          <button
            className="prompt-toggle"
            onClick={() => setPromptOpen((value) => !value)}
            type="button"
          >
            <span className="prompt-caret">{promptOpen ? '▾' : '▸'}</span>
            自定义 Prompt
            {hasCustom && <span className="badge">已修改</span>}
          </button>
          <div className="help">
            改这里可以调整译文的风格和讲解的详细程度。改完立即生效，旧缓存会自动失效。
          </div>
        </div>

        {promptOpen && (
          <>
            <div className="field">
              <div className="prompt-label">
                <span>翻译任务</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setTranslatePrompt(DEFAULT_TRANSLATE_TASK)}
                >
                  恢复默认
                </button>
              </div>
              <textarea
                className="prompt-editor"
                rows={11}
                value={translatePrompt}
                onChange={(event) => setTranslatePrompt(event.target.value)}
                spellCheck={false}
              />
              <div className="help">
                <code>[待翻译]</code>、<code>[论文信息]</code>、<code>[补充语境]</code>{' '}
                这些标签由程序拼接，不用写；这里只放「要求」。
              </div>
            </div>

            <div className="field">
              <div className="prompt-label">
                <span>讲解任务</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setExplainPrompt(DEFAULT_EXPLAIN_TASK)}
                >
                  恢复默认
                </button>
              </div>
              <textarea
                className="prompt-editor"
                rows={11}
                value={explainPrompt}
                onChange={(event) => setExplainPrompt(event.target.value)}
                spellCheck={false}
              />
              <div className="help">
                讲解默认分三段：一句话概括 → 展开机制 → 指出隐含假设。想更短就把第三条删掉。
              </div>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button
            className="btn ghost"
            onClick={async () => {
              await clearCache()
              onToast('译文缓存已清空')
            }}
          >
            清空译文缓存
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={save}>
            {savedFlash ? '已保存' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
