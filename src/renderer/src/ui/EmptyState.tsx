interface Props {
  dragging: boolean
  error: string | null
  onOpen: () => void
}

export function EmptyState({ dragging, error, onOpen }: Props) {
  return (
    <div className="empty">
      <div className="empty-inner">
        <h1>划一段，读中文</h1>
        <p>打开一篇 PDF 论文，用鼠标划选任意段落，右侧会立即给出该段的 AI 翻译。</p>
        <div className={`empty-drop${dragging ? ' over' : ''}`}>
          <p style={{ marginBottom: 14 }}>把 PDF 拖到这里</p>
          <button className="btn primary" onClick={onOpen}>
            选择文件
          </button>
        </div>
        <p className="hint" style={{ marginTop: 18 }}>
          翻译只发送选中的段落与相邻几句，整篇 PDF 不会离开本机
        </p>
        {error && (
          <div className="notice error" style={{ marginTop: 16, textAlign: 'left' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
