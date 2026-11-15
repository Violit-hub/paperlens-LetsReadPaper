import { contextBridge, ipcRenderer } from 'electron'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  id: string
  provider: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}

const api = {
  isElectron: true as const,

  openPdf: (): Promise<{ path: string; name: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke('dialog:open-pdf'),

  setSecret: (name: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke('secret:set', name, value),

  hasSecret: (name: string): Promise<boolean> => ipcRenderer.invoke('secret:has', name),

  getSecretMask: (name: string): Promise<string | null> => ipcRenderer.invoke('secret:mask', name),

  clearSecret: (name: string): Promise<boolean> => ipcRenderer.invoke('secret:clear', name),

  abort: (id: string): void => {
    ipcRenderer.send('ai:abort', id)
  },

  /**
   * 流式对话。onChunk 每收到一段增量调用一次。
   * 返回的 Promise 在流结束（或出错）时 settle。
   */
  streamChat: async (req: ChatRequest, onChunk: (delta: string) => void): Promise<void> => {
    const channel = `ai:chunk:${req.id}`
    const listener = (_e: unknown, delta: string): void => onChunk(delta)
    ipcRenderer.on(channel, listener)
    try {
      await ipcRenderer.invoke('ai:stream', req)
    } finally {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

export type PaperLensApi = typeof api

contextBridge.exposeInMainWorld('api', api)
