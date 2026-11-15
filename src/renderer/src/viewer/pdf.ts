import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PageSize {
  width: number
  height: number
}

export interface LoadedDoc {
  pdf: PDFDocumentProxy
  /** 内容指纹，用于绑定文档级上下文（术语表、标题、摘要） */
  docId: string
  name: string
  path: string | null
  pageSizes: PageSize[]
}

export type LoadProgress = (loaded: number, total: number) => void

/**
 * 文档指纹：只采样，不逐字节哈希。
 * 20MB 的 PDF 完整算一遍要几十毫秒，而这里只需要「同一份文件得到同一个 id」。
 * 采样 8192 个点 + 文件长度，对这个用途碰撞概率足够低。
 */
export function hashDocument(data: Uint8Array): string {
  const size = data.length
  let h1 = 0xdeadbeef ^ size
  let h2 = 0x41c6ce57 ^ size
  const step = Math.max(1, Math.floor(size / 8192))

  for (let i = 0; i < size; i += step) {
    const byte = data[i]
    h1 = Math.imul(h1 ^ byte, 2654435761)
    h2 = Math.imul(h2 ^ byte, 1597334677)
  }

  return (
    (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
  )
}

export async function loadPdf(
  data: Uint8Array,
  name: string,
  path: string | null,
  onProgress?: LoadProgress
): Promise<LoadedDoc> {
  const docId = hashDocument(data)

  // pdf.js 会接管这块内存，复制一份避免 detach 调用方的 buffer
  const own = new Uint8Array(data)
  const pdf = await pdfjs.getDocument({ data: own, isEvalSupported: false }).promise

  const pageSizes: PageSize[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    pageSizes.push({ width: viewport.width, height: viewport.height })
    onProgress?.(i, pdf.numPages)
  }

  return { pdf, docId, name, path, pageSizes }
}
