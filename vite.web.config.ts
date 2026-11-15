import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 纯浏览器调试配置。
 * 只用来在没有 Electron 二进制的机器上验证界面与选区逻辑，
 * 正式形态走 electron-vite。浏览器模式下 API Key 由 /api/chat 代理转发。
 */
export default defineConfig({
  root: 'src/renderer',
  resolve: {
    alias: { '@': resolve('src/renderer/src') }
  },
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: false,
    watch: {
      // 编辑器的原子写入会在源目录里留下 .xxx.tmpdir 临时目录，
      // chokidar 去 watch 它必然 EBUSY，直接把这类路径排除掉
      ignored: ['**/*.tmpdir/**', '**/*.tmpdir']
    },
    proxy: {
      '/api/chat': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: () => '/v1/chat/completions'
      }
    }
  },
  build: {
    outDir: resolve('dist-web'),
    emptyOutDir: true
  }
})
