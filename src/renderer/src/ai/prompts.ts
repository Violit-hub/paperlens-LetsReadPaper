import type { ChatMessage } from '../platform'

/**
 * v3：把 system prompt 改成通用角色，任务指令挪到 user 末尾。
 * 这样「翻译」和「讲解」两条请求共享同一段前缀（system + 论文信息 + 术语表），
 * 模型侧的 prompt cache 才能真正复用，而不是从第一个 token 就分叉。
 */
export const PROMPT_VERSION = 'v3'
export const EXPLAIN_PROMPT_VERSION = 'v3'

export interface TranslateInput {
  text: string
  before: string
  after: string
  title?: string
  abstract?: string
  glossary?: string
}

const SYSTEM = `你是帮助研究者理解英文学术论文的助手。用户会给你论文信息、一段正文，并在最后给出一个任务（翻译或讲解）。严格按要求输出，不要输出任务之外的内容，不要复述指令。`

/** 同一篇论文里逐字节不变的部分 —— 决定 prompt cache 能命中多长 */
function fixedPart(input: TranslateInput): string[] {
  const parts: string[] = []

  if (input.title || input.abstract) {
    const meta: string[] = []
    if (input.title) meta.push(`标题：${input.title}`)
    if (input.abstract) meta.push(`摘要：${input.abstract}`)
    parts.push(`[论文信息]\n${meta.join('\n')}`)
  }

  if (input.glossary) {
    parts.push(`[术语表]\n${input.glossary}`)
  }

  return parts
}

function contextPart(input: TranslateInput): string {
  const lines: string[] = []
  if (input.before.trim()) lines.push(`前文：${input.before.trim()}`)
  if (input.after.trim()) lines.push(`后文：${input.after.trim()}`)
  if (lines.length === 0) return ''
  return `[补充语境（仅供理解，不属于任务对象，绝对不要输出）]\n${lines.join('\n\n')}`
}

export const DEFAULT_TRANSLATE_TASK = `[任务：翻译]
把 [待翻译] 的英文译成简体中文。

要求：
1. 术语准确、前后一致；若提供了术语表，必须采用其中的译法
2. 数学公式、变量名、希腊字母、单位、引用编号 [12]、图表编号 Figure 3 / Table 2 一律原样保留，不翻译、不解释、不加括号注释
3. 保持原文段落结构：原文几段，译文就几段；段与段之间空一行；不要编号
4. 学术语体，简洁准确；不口语化，不扩写，不省略，不添加原文没有的内容
5. 只输出译文`

export const DEFAULT_EXPLAIN_TASK = `[任务：讲解]
把 [要讲解的段落] 用简体中文讲明白。

要求：
1. 第一段用一句话说清楚这段在干什么
2. 第二段展开：它是怎么做的、为什么这么做，3 到 5 句
3. 第三段指出这段的前提假设，或者作者没说出口的推论；如果确实没有，就省略这一段
4. 假设读者是这个领域的研究生，但不是这个子方向。专业术语保留英文原词，并用一句话说明它指什么
5. 不要复述原文，不要逐句翻译，不要小标题，不要编号；段落之间空一行`

function assemble(parts: string[]): string {
  return parts.filter((part) => part && part.trim().length > 0).join('\n\n')
}

export function buildTranslateMessages(
  input: TranslateInput,
  task: string = DEFAULT_TRANSLATE_TASK
): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: assemble([
        ...fixedPart(input),
        `[待翻译]\n${input.text.trim()}`,
        contextPart(input),
        task
      ])
    }
  ]
}

export function buildExplainMessages(
  input: TranslateInput,
  task: string = DEFAULT_EXPLAIN_TASK
): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: assemble([
        ...fixedPart(input),
        `[要讲解的段落]\n${input.text.trim()}`,
        contextPart(input),
        task
      ])
    }
  ]
}
