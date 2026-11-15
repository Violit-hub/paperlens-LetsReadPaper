# PaperLens —— 划词翻译论文阅读器 · 技术实现规划

> 一句话定义：打开 PDF 论文，用鼠标划选任意段落，右侧面板自动出现该段的中文译文。
>
> 本文档只解决一个问题：**这件事的 90% 难度不在调用大模型，而在「你选中的到底是不是一段干净的话」。**

---

## 0. 先把产品闭环定死

```
打开 PDF  ──→  划选段落  ──→  右侧面板出现原文  ──→  译文流式填充  ──→  复制 / 存笔记 / 追问
              (0ms 反馈)     (骨架屏 120ms)          (首字 < 800ms)
```

三个必须达标的体验指标，后面所有技术决策都围绕它们：

| 指标 | 目标 | 为什么难 |
|---|---|---|
| 划选文本正确率 | > 98%（不串行、不漏字、不混入页眉和行号） | pdf.js 文本层是碎片化 `<span>`，`selection.toString()` 会直接乱序 |
| 划完到首字出现 | < 800ms | 需要骨架屏 + 流式 + 取消上一次请求 |
| 重复划同一段 | 0 请求 | 需要内容哈希缓存 |

---

## 1. 技术选型

**一条硬约束：PDF 渲染和文本层只能用 pdf.js（Mozilla）。** 自己写 PDF 渲染器、或者用商业 SDK（PDFTron / PSPDFKit，$ 数千美元/年），在这个场景下都不成立。所以三个方案的本质是「pdf.js + 一个壳」。

| | **A. Electron + React** | B. Tauri 2 + React | C. 纯 Web（Next.js） |
|---|---|---|---|
| 安装包体积 | ~120 MB | ~12 MB | 0（浏览器） |
| 本地文件 / 最近打开 | 强 | 强 | 拖拽或 File System Access API |
| API Key 安全 | `safeStorage` 加密，主进程持有 | Rust `keyring` | 只能放后端代管，或明放在浏览器 |
| 调用 LLM | 主进程 `fetch`，无 CORS | Rust `reqwest` | Route Handler 代理 |
| 跨平台 | Win / macOS / Linux | 同左 | 任意浏览器 |
| 开发速度 | 最快 | 中 | 快 |

### 推荐：A（Electron）

理由：这个产品的价值 90% 在前端（选区引擎 + 面板交互），Electron 能把「文件拖拽、最近打开、全局快捷键、Key 本地加密、无 CORS」这些琐事一天铺平，把时间留给真正的难点。

体积换少踩坑，是划算的。

**但要做一件事让退路保留**：把平台能力收敛到单一接口 `src/platform/index.ts`：

```ts
export interface Platform {
  openFile(): Promise<{ path: string; data: Uint8Array } | null>;
  getApiKey(provider: string): Promise<string | null>;
  streamChat(req: ChatRequest, onChunk: (t: string) => void, signal: AbortSignal): Promise<void>;
  openRecent(): Promise<RecentDoc[]>;
}
```

将来想瘦身迁 Tauri，前端 100% 不用改，只换这一个文件的实现。

> 如果想先花一天验证概念，C 方案能跑通完整交互，但用户得自己填 Key 且明文存浏览器——只适合自用，不适合交付。

---

## 2. 总体架构

```
┌───────────────────────────────────────────────────────────────┐
│  Renderer (React)                                             │
│                                                               │
│  ┌──────────────────┐        ┌──────────────────────────────┐ │
│  │  PdfViewer       │        │  TranslationPanel            │ │
│  │  ├ Page (canvas) │        │  ├ 原文摘录 + 页码            │ │
│  │  └ textLayer     │        │  ├ 译文（流式 / 逐句对照）    │ │
│  │     └ span[data] │        │  ├ 模型 · 耗时 · 缓存角标     │ │
│  └────────┬─────────┘        │  └ 追问输入框                │ │
│           │ Selection        └──────────────▲───────────────┘ │
│  ┌────────▼─────────────────────────────────┴───────────────┐ │
│  │  Selection Engine                                        │ │
│  │   buildPageTextModel() → 行/段/栏重建 + span↔char 映射    │ │
│  │   extractSelection()   → 精确字符区间 + 前后文            │ │
│  └────────┬─────────────────────────────────────────────────┘ │
│           │                                                     │
│  ┌────────▼─────────┐   ┌──────────────┐   ┌────────────────┐ │
│  │ Cache (Dexie /    │   │ Zustand Store│   │ Highlight Layer│ │
│  │  IndexedDB)       │   │              │   │ (持久化批注)   │ │
│  └───────────────────┘   └──────────────┘   └────────────────┘ │
└───────────────────────────────┬───────────────────────────────┘
                                │ IPC (contextBridge)
┌───────────────────────────────▼───────────────────────────────┐
│  Main Process                                                 │
│   · LLM 代理（流式转发，AbortController 管理）                 │
│   · API Key 加密存储（safeStorage）                            │
│   · 文件系统 / 最近打开列表 / 导出                            │
└───────────────────────────────────────────────────────────────┘
```

技术栈：

```
electron 33 + electron-vite 2 + React 19 + TypeScript 5
pdfjs-dist 5.x          ← 渲染 + 文本层
zustand                 ← 状态
dexie                   ← IndexedDB：译文缓存 / 高亮 / 术语表
tailwindcss 4           ← 样式
```

---

## 3. 五个真正难的地方

其余都是 CRUD，这五件事决定产品成不成。

### 3.1 为什么绝对不能直接 `selection.toString()`

pdf.js 的文本层是给「选中/搜索/无障碍」用的，不是给人读的。它有三个坑：

1. **一个 text item 可能被拆成多个 span**（字体宽度微调、字距调整时会拆）。所以「一个 span = 一句话」的假设不成立。
2. **DOM 顺序 ≠ 阅读顺序**。双栏论文里左右栏的 span 在 DOM 里可能是按对象流交错出现的。
3. **空格和换行不存在于文本里**。PDF 只存字形位置，词间距是坐标差，不是空格字符。`toString()` 拼出来常常是 `Theproposedmethod` 或满屏换行。

再加上页眉、页脚、行号、脚注、图注都会混进选区。

**结论：文本必须由我们自己按几何位置重建，不能信浏览器的字符串拼接。**

### 3.2 核心设计：以 DOM 几何为准的 `PageTextModel`

关键转身：**不解析 `getTextContent()` 的 item 流，而是解析 textLayer 渲染后的真实 `<span>`**。理由很简单——span 带 `getBoundingClientRect()`，坐标就是屏幕坐标，高亮直接可用，且天然处理了 pdf.js 内部的拆分逻辑。

```
每一页渲染完成后，做一次版面重建（约 5ms / 页）：

  spans  ──按 y 中心聚类──→  行 (line)
         ──行内按 x 排序──→  行片段 (fragment，遇大间隙切断)
         ──跨行拼接────→  段落 (block)
         ──几何规则────→  分类 (body / header / footer / lineno / math / caption / reference)
```

分类规则（按优先级，全部可失败降级）：

| 类型 | 判定规则 |
|---|---|
| `header` / `footer` | 中心 y 在页面上下 8% 内，且字号 < 正文中位字号 × 1.1 |
| `lineno` | 整个 block 宽度 < 页码宽度 × 6%，且文本匹配 `/^\d{1,3}$/` |
| `math` | 字体名匹配 `/Math\|Symbol\|CMMI\|CMSY\|CMEX\|STIX/`，或非 ASCII 符号密度 > 15% |
| `caption` | 文本匹配 `/^(Fig\.?\|Figure\|Table\|Algorithm)\s*\d/` |
| `reference` | 文本为 `References` / `Bibliography` 之后的所有 block |
| `body` | 兜底 |

**降级策略很重要**：如果某页检测不出段落（比如整页是扫描图、或者版面极怪），就退回「整页一个 block，按行切分」。永远给用户一个可用的结果，不是报错。

文本重建的两个细节：

```ts
// 1. 行内 span 拼接：间距 > 0.22 × 字号 视为一个空格
// 2. 跨行拼接：上一行以 "-" 结尾且下一行首字母小写 → 去连字符直接相连
//    （"pro-"/"posed" → "proposed"，这是论文高频坑）
```

最后得到：

```ts
interface TextBlock {
  id: string;                                    // "p3-b7"
  page: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  lines: Line[];
  text: string;                                  // 已修复空格/连字符的干净文本
  kind: BlockKind;
  charMap: Array<{ spanIndex: number; blockStart: number; spanStart: number; len: number }>;
}
```

`charMap` 是整个系统的枢纽：**段落字符偏移 ↔ DOM span 偏移的双向映射**。有了它，选区和持久化高亮才能精确落位。

### 3.3 选区 → 字符偏移

拿到 `Selection` 的 `Range` 后，逐个求交，注意端点归一化（端点可能落在 `.textLayer` 容器而不是 span 上）：

```ts
function clampRangeToSpan(range: Range, span: HTMLElement): Range | null {
  const spanR = document.createRange();
  spanR.selectNodeContents(span);

  const r = range.cloneRange();
  if (r.compareBoundaryPoints(Range.START_TO_START, spanR) < 0) {
    r.setStart(spanR.startContainer, spanR.startOffset);
  }
  if (r.compareBoundaryPoints(Range.END_TO_END, spanR) > 0) {
    r.setEnd(spanR.endContainer, spanR.endOffset);
  }
  if (r.collapsed) return null;

  // 交集起点在 span 内的字符偏移
  const pre = document.createRange();
  pre.selectNodeContents(span);
  pre.setEnd(r.startContainer, r.startOffset);

  return { s0: pre.toString().length, s1: pre.toString().length + r.toString().length };
}
```

主流程：

```ts
// 1. 找出所有被 range 覆盖的 span（不依赖 DOM 顺序）
const hitSpans = pageModel.spans.filter(s => range.intersectsNode(s.el));

// 2. 对每个 span 求交，得到 span 内区间
// 3. 通过 charMap 转成 block 内区间，合并连续区间
// 4. 按 block 输出 { blockId, start, end, text }

// 5. 关键：选区太短时做「段落补全」
//    用户往往只划半句。若选中的是 block 的一部分，
//    翻译时仍然送整个 block，但面板高亮只标选中部分。
```

**这是提升可用性最划算的一条**：用户划一个短语，你按整句/整段翻译，质量天差地别，用户还觉得「它懂我」。

### 3.4 划选之后：别让选区消失

极其容易踩的坑，会毁掉全部体感：

- 点击右侧面板时，浏览器默认清除 `Selection`，你的原文摘录会瞬间变空。
- 解决：面板根元素监听 `mousedown` 并 `preventDefault()`；同时在选区提取成功后立刻把选区**冻结成自定义高亮层**（绝对定位 div，`pointer-events: none`），此后不再依赖浏览器原生选择态。
- 原生 `::selection` 在 pdf.js 的透明文字上颜色很淡，也需要自定义高亮叠层才好看。

```css
.textLayer { position: absolute; inset: 0; color: transparent; user-select: text; }
.textLayer span { cursor: text; }
.highlight-layer { position: absolute; inset: 0; pointer-events: none; }
.highlight-layer .hl { position: absolute; background: rgb(255 214 0 / .35); border-radius: 2px; mix-blend-mode: multiply; }
```

### 3.5 触发时机与感知延迟

```
pointerdown  ── 清空上一个 timer
pointermove  ── 清空 timer（正在拖选，别动）
pointerup    ── 起 120ms 定时器
                 └─ 期间如果 selection 又变化 → 重置 timer
                 └─ 触发时：文本长度 < 2 忽略；< 5 且单词 → 只显示「查词」卡片
selectionchange + 240ms 防抖 ── 覆盖键盘选择（Shift + 方向键）
```

面板打开的动画顺序（这个顺序决定「快」的感觉）：

1. **0ms**：面板滑入，显示原文摘录 + 骨架屏（三行灰条）
2. **~120ms**：拿到本地缓存则直接全量渲染，结束
3. **否则**：发起流式请求，首字到达即替换骨架

同时必须处理**并发**：用户连续划三段，要 `AbortController.abort()` 掉前两个，否则后到的响应会覆盖新内容。用请求 id 做单调校验，比 abort 更可靠（abort 有竞态）：

```ts
const seq = ++requestSeq;
for await (const chunk of stream) {
  if (seq !== requestSeq) return;  // 已被更新的请求取代
  append(chunk);
}
```

---

## 4. 发给模型的内容

### 4.1 上下文策略

论文翻译的质量瓶颈常常是**脱离上下文导致的术语不一致**。所以每次请求带四层信息：

```
[文档级]  标题 + 摘要 150 词 + 术语表（docGlossary，首次打开时生成并缓存）
[段落级]  选中 block 的完整文本（即使只选中半句）
[邻接级]  前一个 block 末 200 字 + 后一个 block 首 200 字
[选区级]  用户实际划中的部分（用于确认焦点）
```

Token 预算：primary ≤ 1800，context ≤ 600，输出 ≤ 2000。

术语表生成：文档首次打开后，异步用一次小请求从「摘要 + 引言」抽取 30 个领域术语的译法，存 `glossary` 表。后续每次翻译注入。成本一次，收益持续，这是性价比最高的一个优化。

### 4.2 Prompt

```text
你是学术论文翻译专家。把用户选中的英文段落翻译成简体中文。

硬性要求：
1. 术语准确、前后一致。优先采用[术语表]中的译法。
2. 数学公式、变量名、希腊字母、单位、引用编号 [12]、图表编号 Figure 3 / Table 2
   一律原样保留，不翻译、不解释、不加括号注释。
3. 保持原文段落结构：原文几段，译文就几段，段间空行分隔，不要编号。
4. 学术语体，简洁准确，不要口语化，不要扩写，不要省略。
5. 只输出译文。禁止输出「以下是译文」这类前言，禁止输出原文。

[论文信息]
标题：{title}
摘要：{abstract}

[术语表]
{glossary}

[前文（仅供理解，不要翻译）]
{contextBefore}

[待翻译]
{primary}

[后文（仅供理解，不要翻译）]
{contextAfter}
```

两个经验点：

- **`[前文]/[后文]` 明确标注「不要翻译」**，否则模型经常把上下文一起翻了。
- 段落对齐用 `\n\n` 分隔，不要要求 JSON。流式场景下 JSON 无法增量解析，而 `\n\n` 可以在流式过程中实时切段渲染。段数不一致时降级为整段显示，不报错。

### 4.3 逐句对照（Phase 3 的体验升级）

译文回来后，用 `Intl.Segmenter` 切句，原文也切句，按顺序配对。悬停译文句 → 原文对应句高亮；反之亦然。这是「论文阅读器」和「翻译网页」的核心差异。

---

## 5. 缓存与成本

```ts
// 缓存键：内容寻址，与文档无关，同一段出现在不同论文里也能命中
key = sha256(`${model}|${promptVersion}|${primary}|${contextBefore.slice(-80)}|${contextAfter.slice(0,80)}`)
```

- 存 Dexie，表 `translations`，附 `docId` 便于按文档清理。
- `promptVersion` 必须进 key：改 prompt 后旧译文自动失效，这条能省掉大量「改了 prompt 但看到的还是旧结果」的困惑。
- 命中时面板显示「缓存」角标，并提供「重新翻译」。
- 缓存是全离线可用的：**没有配置 Key 也能读已翻译过的段落**，这对演示和试用很重要。

成本参考：一段 200 词，gpt-4o-mini 级别约 $0.0001；deepseek-chat 更低。一篇 20 页论文全译约 $0.02–0.05。真正常用的是划选，成本可忽略。

---

## 6. Key 与隐私

```ts
// main.ts —— 渲染进程永远拿不到明文 Key
import { safeStorage } from 'electron';

const store = new Store({ name: 'secrets' });          // electron-store
ipcMain.handle('key:set', (_, provider, plain) => {
  store.set(provider, safeStorage.encryptString(plain).toString('base64'));
});

ipcMain.handle('ai:stream', async (e, req) => {
  const enc = store.get(req.provider);
  const key = safeStorage.decryptString(Buffer.from(enc, 'base64'));
  // ... fetch 流式，逐块 e.sender.send(`ai:chunk:${req.id}`, delta)
});
```

- 只发**选中段落 + 少量邻接文本**，绝不整篇上传（这是用户信任的底线，也是和「上传 PDF 到网页」类产品的差异）。
- 支持 Ollama（`http://127.0.0.1:11434/v1`，OpenAI 兼容），完全离线，适合处理未发表/涉密稿。
- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，所有能力走 preload 白名单。

提供商抽象成一张表，加新模型只加一行：

```ts
const PROVIDERS = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai:   { base: 'https://api.openai.com/v1',   model: 'gpt-4o-mini' },
  ollama:   { base: 'http://127.0.0.1:11434/v1',   model: 'qwen2.5:14b' },
} as const;
```

---

## 7. 代码骨架

### 7.1 页面渲染 + 文本层

```tsx
// src/viewer/Page.tsx
import { getDocument, TextLayer } from 'pdfjs-dist';

async function renderPage(pdf: PDFDocumentProxy, pageNo: number, scale: number, host: HTMLDivElement) {
  const page = await pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = viewport.width * dpr;
  canvas.height = viewport.height * dpr;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  canvas.style.display = 'block';

  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  textLayerDiv.style.setProperty('--scale-factor', String(scale));

  host.append(canvas, textLayerDiv);

  await page.render({
    canvasContext: canvas.getContext('2d')!,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  }).promise;

  // pdfjs-dist 5.x：TextLayer 类；4.x 用 pdf_viewer 的 TextLayerBuilder
  const tl = new TextLayer({
    textContentSource: await page.getTextContent(),
    container: textLayerDiv,
    viewport,
  });
  await tl.render();

  // ★ 渲染完立刻做版面重建，给每个 span 打上 data 标记
  const model = buildPageTextModel(host, textLayerDiv, pageNo);
  return { canvas, textLayerDiv, model };
}
```

### 7.2 版面重建（核心）

```ts
// src/viewer/pageTextModel.ts
export function buildPageTextModel(pageEl: HTMLElement, textLayerDiv: HTMLElement, page: number) {
  const base = pageEl.getBoundingClientRect();

  const spans = [...textLayerDiv.querySelectorAll<HTMLSpanElement>('span')]
    .map(el => {
      const r = el.getBoundingClientRect();
      const fontSize = parseFloat(getComputedStyle(el).fontSize) || r.height || 10;
      return {
        el,
        text: el.textContent ?? '',
        x0: r.left - base.left, x1: r.right - base.left,
        y0: r.top - base.top,   y1: r.bottom - base.top,
        fontSize,
      };
    })
    .filter(s => s.text.trim() && s.x1 - s.x0 > 0);

  // ① 按 y 中心聚成行
  const sorted = [...spans].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const rows: (typeof spans)[] = [];
  for (const s of sorted) {
    const cy = (s.y0 + s.y1) / 2;
    const row = rows.at(-1);
    if (row) {
      const rc = (row[0].y0 + row[0].y1) / 2;
      if (Math.abs(rc - cy) <= Math.max(2, 0.45 * s.fontSize)) { row.push(s); continue; }
    }
    rows.push([s]);
  }

  // ② 行内按 x 排序，在大间隙处切成 fragment（双栏、表格式排版的关键）
  const fragments = rows.flatMap(row => {
    const r = [...row].sort((a, b) => a.x0 - b.x0);
    const out: (typeof spans)[] = [];
    let cur: typeof spans = [];
    let prevX1 = -Infinity;
    for (const s of r) {
      if (cur.length && s.x0 - prevX1 > 2.2 * s.fontSize) { out.push(cur); cur = []; }
      cur.push(s);
      prevX1 = Math.max(prevX1, s.x1);
    }
    if (cur.length) out.push(cur);
    return out;
  });

  // ③ fragment 拼段：左边界对齐 + 行距合理 → 同一段
  const blocks: RawBlock[] = [];
  for (const frag of fragments) {
    const x0 = frag[0].x0, x1 = frag.at(-1)!.x1;
    const y0 = Math.min(...frag.map(s => s.y0)), y1 = Math.max(...frag.map(s => s.y1));
    const prev = blocks.at(-1);
    const fontSize = Math.max(...frag.map(s => s.fontSize));

    const sameColumn = prev && Math.abs(prev.x0 - x0) < 1.6 * fontSize;
    const lineGap = prev ? y0 - prev.y1 : Infinity;
    const continues = sameColumn && lineGap < 0.9 * fontSize && !isParagraphBreak(prev, frag);

    if (continues) {
      prev.lines.push(frag);
      prev.y1 = y1; prev.x1 = Math.max(prev.x1, x1);
    } else {
      blocks.push({ x0, x1, y0, y1, lines: [frag], fontSize });
    }
  }

  // ④ 生成干净文本 + charMap
  return blocks.map((b, i) => {
    const id = `p${page}-b${i}`;
    let text = '';
    const charMap: CharMapEntry[] = [];
    b.lines.forEach((lineSpans, li) => {
      const lineText = joinSpans(lineSpans);            // 处理空格
      if (li > 0) {
        const prev = text;
        if (/-$/.test(prev) && /^[a-z]/.test(lineText)) text = prev.slice(0, -1);  // 拆行连字符
        else text += ' ';
      }
      const offset = text.length;
      text += lineText;
      for (const s of lineSpans) {
        charMap.push({ spanIndex: spanIndexOf(s), blockStart: text.length - lineText.length + s._localStart, ... });
      }
    });
    // 写回 DOM，供选区/高亮定位
    charMap.forEach(e => e.el.dataset.block = id);
    return { id, page, kind: classify(b, page), text, charMap, bbox: { ... } };
  });
}
```

> 实现提示：`classify()` 和 `isParagraphBreak()` 先用简单规则，等有真实论文样本后再调。**不要一开始就做完美版面分析**——它没有止境，而 80% 的论文用「行对齐 + 间隙切分」就能得到正确段落。

### 7.3 流式转发（主进程）

```ts
// electron/main.ts
ipcMain.handle('ai:stream', async (event, req: ChatRequest) => {
  const provider = PROVIDERS[req.provider];
  const key = decryptKey(req.provider);
  const ac = new AbortController();
  inflight.set(req.id, ac);

  const res = await fetch(`${provider.base}/chat/completions`, {
    method: 'POST',
    signal: ac.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: provider.model, stream: true, temperature: 0.2,
      messages: buildMessages(req),
    }),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') return;
      const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
      if (delta) event.sender.send(`ai:chunk:${req.id}`, delta);
    }
  }
});

ipcMain.on('ai:abort', (_, id) => { inflight.get(id)?.abort(); inflight.delete(id); });
```

### 7.4 持久化高亮重放

```ts
// 存：{ docId, page, blockId, charStart, charEnd, textSnapshot, color }
// 读：blockId 还在 → 用 charMap 直接定位 span 区间 → getClientRects → 画 div
//     blockId 失效（PDF 版本变了/解析规则变了）→ 用 textSnapshot 在本页 blocks 里做模糊匹配
function paintHighlight(block: TextBlock, start: number, end: number, layer: HTMLElement) {
  const segs = sliceCharMap(block.charMap, start, end);      // 二分 → 若干 span 片段
  for (const seg of segs) {
    const r = document.createRange();
    r.setStart(seg.textNode, seg.spanStart);
    r.setEnd(seg.textNode, seg.spanStart + seg.len);
    for (const rect of r.getClientRects()) {
      const d = document.createElement('div');
      d.className = 'hl';
      Object.assign(d.style, {
        left: `${rect.left - layer.getBoundingClientRect().left}px`,
        top: `${rect.top - layer.getBoundingClientRect().top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      });
      layer.appendChild(d);
    }
  }
}
```

---

## 8. 分阶段路线图

| 阶段 | 内容 | 验收标准 | 工时 |
|---|---|---|---|
| **P0 骨架** | electron-vite 脚手架、窗口、拖拽打开、pdf.js 渲染单页 | 能打开本地 PDF 并看到正文 | 0.5d |
| **P1 阅读器** | 虚拟滚动、缩放、页码跳转、大纲、暗色 | 30 页论文流畅滚动，无白屏 | 1.5d |
| **P2 选区引擎** | PageTextModel、行/段重建、span↔char 映射、选区提取、自定义高亮 | 双栏 IEEE 论文选一整段，输出文本无页眉/无串行/连字符已修复 | 2d |
| **P3 AI 面板** | 右侧面板、流式、取消、骨架屏、prompt、四层上下文 | 划选到首字 < 800ms；连续快划 3 次不串内容 | 1.5d |
| **P4 记忆层** | Dexie 缓存、文档库、阅读位置、术语表 | 重复划同一段 0 请求；重启后回到上次位置 | 1d |
| **P5 打磨** | 逐句对照、追问、导出 Markdown、快捷键、设置页 | 能把一篇论文的翻译笔记导出成 md | 2d |

**P0–P3 就是可用 MVP，约 5.5 人天。** 到 P3 结束时，产品定义里的核心闭环已经跑通。

建议的推进顺序有一个反直觉的点：**先做 P2 再做 P3**。因为选区引擎烂的时候，你会误以为翻译质量差，然后疯狂调 prompt——实际上问题在喂进去的文本是乱的。这个弯路很多人走过。

---

## 9. 风险清单

| 风险 | 表现 | 应对 |
|---|---|---|
| 扫描版 PDF | 没有文本层，选不中任何字 | 检测 `getTextContent().items.length === 0` → 提示并提供 OCR（Tesseract.js 或调用视觉模型），标注为实验特性 |
| 极端排版 | 三栏、杂志式环绕、竖排 | 允许用户「手动框选区域」，把框内 span 按 y 排序直接成段，绕过自动分析 |
| 公式选的乱 | 选中 `∑` 和上下标乱序 | prompt 层已保护；P5 做公式块检测，用 `⟦M1⟧` 占位符替换后还原 |
| 长段落超长 | 一次选中好几页 | 超过 1500 词自动切块并发翻译，按顺序拼接，共享术语表 |
| 模型胡译 | 术语瞎编 | 术语表 + `temperature: 0.2` + 面板上「这译得不对」按钮收集坏例，用于改 prompt |
| 内存 | 30 页 canvas 占 500MB+ | 只渲染视口 ±1 页，离屏页降为缩略图 |
| provider 宕机 | 面板转圈 | 超时 20s + 自动重试 1 次 + 明确错误提示，缓存仍可用 |

---

## 10. 之后可以加什么

优先级从高到低，都是「同一个选区引擎」上长出来的能力：

1. **追问**：选中段落 + 多轮对话（「这段的假设是什么」「解释这个公式」）——交互增量最小，价值最大。
2. **全文摘要 / 章节速览**：打开时生成 TL;DR + 每节一句话。
3. **术语表与生词本**：选中术语 → 收藏 → 导出 Anki。
4. **双文档对照**：同一篇的两个版本（v1/v2）或原文/译稿并排。
5. **朗读**：Web Speech API 或本机 TTS，配合逐句高亮做「听论文」。
6. **引用网络**：解析参考文献，点 [12] 跳转/预览。
7. **写作辅助**：把读到的段落存成素材库，按主题聚类，写 related work 时检索。

---

## 11. 立刻要做的三个决定

1. **壳选哪个** —— 推荐 Electron（A）。
2. **面板是挤压还是浮层** —— 建议两种都做，默认浮层（overlay，半透明覆盖在右侧），因为挤压会改变 PDF 的 scale，导致整页重渲染和阅读位置跳动。
3. **默认模型** —— 建议 deepseek-chat 或 gpt-4o-mini 起步（便宜、快、中文好），Ollama 作为离线选项。
