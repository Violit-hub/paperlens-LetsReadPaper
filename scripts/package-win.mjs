/**
 * 组装一个免安装的 Windows 绿色版。
 *
 * 不走 electron-builder：它会额外拉 winCodeSign / nsis 等几百 MB 的资源，
 * 而这个项目不需要安装程序。Electron 本身就支持「exe + resources/app 目录」
 * 的便携结构，手动组装反而更可控。
 *
 * 产出：dist/PaperLens-win32-x64/
 *
 * 用法：node scripts/package-win.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON_DIST = join(ROOT, 'node_modules/electron/dist')
const BUILD = join(ROOT, 'out')
const DIST = join(ROOT, 'dist')
const APP_ROOT = join(DIST, 'PaperLens-win32-x64')
const APP_DIR = join(APP_ROOT, 'resources/app')

function dirSize(dir) {
  let total = 0
  let files = 0
  const walk = (current) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        try {
          total += statSync(full).size
          files++
        } catch {
          /* 跳过被占用的文件 */
        }
      }
    }
  }
  walk(dir)
  return { total, files }
}

function fail(message) {
  console.error('✗ ' + message)
  process.exit(1)
}

/* ------------------------------------------------------------------ */

if (!existsSync(ELECTRON_DIST)) fail(`找不到 Electron 运行时：${ELECTRON_DIST}\n先执行 node node_modules/electron/install.js`)
if (!existsSync(BUILD)) fail(`找不到构建产物：${BUILD}\n先执行 pnpm build`)

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

console.log('清理旧的输出…')
rmSync(APP_ROOT, { recursive: true, force: true })
mkdirSync(APP_DIR, { recursive: true })

console.log('复制 Electron 运行时（约 268MB，慢一点）…')
cpSync(ELECTRON_DIST, APP_ROOT, { recursive: true })

// Electron 自带的默认应用会让程序去开一个空白窗口，删掉
rmSync(join(APP_ROOT, 'resources/default_app.asar'), { force: true })

// 语言包：Electron 自带 55 个，占 40MB。中文界面我们自己做，这里只需要
// 中英两个（缺语言时 Chromium 会回退到 en-US）。这一刀砍掉 39MB。
const LOCALES_KEEP = new Set(['en-US.pak', 'zh-CN.pak'])
const localesDir = join(APP_ROOT, 'locales')
if (existsSync(localesDir)) {
  for (const entry of readdirSync(localesDir)) {
    if (!LOCALES_KEEP.has(entry)) rmSync(join(localesDir, entry), { force: true })
  }
}

console.log('写入应用文件…')
cpSync(BUILD, join(APP_DIR, 'out'), { recursive: true })
cpSync(join(ROOT, 'resources/icon.png'), join(APP_DIR, 'resources/icon.png'))

// 精简的 package.json：Electron 只读 main 和 name
writeFileSync(
  join(APP_DIR, 'package.json'),
  JSON.stringify(
    {
      name: 'paperlens',
      productName: 'PaperLens',
      version: pkg.version,
      description: pkg.description,
      main: 'out/main/index.js',
      author: 'Violit-hub',
      license: 'MIT'
    },
    null,
    2
  ) + '\n',
  'utf8'
)

// 改名之后 Electron 依然按 resources/app 启动，只是任务管理器里好看
const exePath = join(APP_ROOT, 'electron.exe')
if (existsSync(exePath)) renameSync(exePath, join(APP_ROOT, 'PaperLens.exe'))

// 兼容模式入口：受限环境（公司电脑、沙箱、组策略）下 Chromium 沙箱
// 初始化会失败，表现为「双击没反应」。这个 bat 多带一个 --no-sandbox。
// 必须是 CRLF 换行，否则 cmd 解析会出问题。
writeFileSync(
  join(APP_ROOT, 'Start-if-crash.bat'),
  '@echo off\r\ncd /d "%~dp0"\r\nstart "" "PaperLens.exe" --no-sandbox\r\n',
  'ascii'
)

writeFileSync(
  join(APP_ROOT, 'README.txt'),
  `PaperLens —— 划选 PDF 论文，AI 翻译 + 讲解
================================================

用法
----
1. 双击 PaperLens.exe
2. 点「打开论文」，或者把 PDF 直接拖进窗口
3. 在论文里用鼠标划选一段，右侧会给出译文和讲解
4. 第一次用需要配 API Key：点右上角「设置」，
   填入 DeepSeek 的 Key（platform.deepseek.com 可以申请）

打不开怎么办
------------
如果双击 PaperLens.exe 没有任何反应，改用 Start-if-crash.bat。
它多带一个 --no-sandbox 参数，能绕过一部分受限环境（公司电脑、
开启了沙箱限制的系统）下 Chromium 初始化失败的问题。

注意
----
· 免安装版，整个文件夹可以放在任意位置，删除即卸载
· 别只拷走 exe：还需要同目录的 dll、resources 等文件
· 你的 API Key 用系统加密存在 paperlens-data 里，不会上传
· 只把「选中的段落 + 相邻几句」发给模型，整篇 PDF 不会离开本机
· 配置和数据都在 paperlens-data 目录，想清空就删掉它

配置
----
· 模型：DeepSeek（默认）或本地 Ollama（完全离线）
· 翻译和讲解的 prompt 都能在设置里改

版本：v${pkg.version}
`,
  'utf8'
)

const { total, files } = dirSize(APP_ROOT)
console.log('')
console.log(`✓ 打包完成：${APP_ROOT}`)
console.log(`  ${files} 个文件，${(total / 1024 / 1024).toFixed(0)} MB`)
console.log(`  入口：PaperLens.exe`)
