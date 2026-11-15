import type { PaperLensApi } from './index'

declare global {
  interface Window {
    /** Electron 环境下存在；纯浏览器调试时为 undefined */
    api?: PaperLensApi
  }
}

export {}
