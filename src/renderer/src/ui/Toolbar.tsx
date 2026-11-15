interface Props {
  docName: string | null
  currentPage: number
  totalPages: number
  scale: number
  busy: boolean
  onOpen: () => void
  onJump: (page: number) => void
  onZoom: (delta: number) => void
  onFit: () => void
  onSettings: () => void
}

export function Toolbar({
  docName,
  currentPage,
  totalPages,
  scale,
  busy,
  onOpen,
  onJump,
  onZoom,
  onFit,
  onSettings
}: Props) {
  return (
    <div className="toolbar">
      <span className="title">PaperLens</span>
      <button className="btn" onClick={onOpen} disabled={busy}>
        打开论文
      </button>
      {docName && <span className="doc-name">{docName}</span>}
      <span className="spacer" />

      {totalPages > 0 && (
        <>
          <button className="btn ghost" onClick={() => onZoom(-0.1)} title="缩小">
            −
          </button>
          <span className="page-indicator" style={{ minWidth: 46 }}>
            {Math.round(scale * 100)}%
          </span>
          <button className="btn ghost" onClick={() => onZoom(0.1)} title="放大">
            +
          </button>
          <button className="btn ghost" onClick={onFit} title="适应宽度">
            适应
          </button>

          <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />

          <input
            className="page-input"
            type="number"
            min={1}
            max={totalPages}
            value={currentPage}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value) && value >= 1 && value <= totalPages) onJump(value)
            }}
            style={{
              width: 52,
              height: 30,
              textAlign: 'center',
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'var(--panel-2)',
              color: 'var(--text)',
              font: 'inherit',
              fontSize: 13
            }}
          />
          <span className="page-indicator">/ {totalPages}</span>
        </>
      )}

      <button className="btn ghost" onClick={onSettings} title="设置">
        设置
      </button>
    </div>
  )
}
