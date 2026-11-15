import { hashText, makeCacheKey, readCache, writeCache } from '../cache'
import { newRequestId, streamChat } from '../platform'
import { readPromptOverride } from '../settings'
import {
  buildExplainMessages,
  buildTranslateMessages,
  DEFAULT_EXPLAIN_TASK,
  DEFAULT_TRANSLATE_TASK,
  EXPLAIN_PROMPT_VERSION,
  PROMPT_VERSION,
  type TranslateInput
} from './prompts'

export type AiTask = 'translate' | 'explain'

export interface TaskOptions {
  provider: string
  useCache?: boolean
}

export interface TaskResult {
  text: string
  cached: boolean
  elapsedMs: number
}

const TASK_CONFIG = {
  translate: {
    build: buildTranslateMessages,
    version: PROMPT_VERSION,
    defaultTask: DEFAULT_TRANSLATE_TASK,
    temperature: 0.2,
    maxTokens: 2048
  },
  explain: {
    build: buildExplainMessages,
    version: EXPLAIN_PROMPT_VERSION,
    defaultTask: DEFAULT_EXPLAIN_TASK,
    temperature: 0.3,
    maxTokens: 1400
  }
} as const

/**
 * 跑一次翻译或讲解。
 * 命中缓存时同步吐出全文，否则流式追加；调用方用序号校验丢弃过期结果。
 *
 * 用户改过 prompt 的话，改写后的内容会进缓存键 —— 改完立即生效，
 * 也不会读到用旧 prompt 生成的结果。
 */
export async function runTask(
  task: AiTask,
  input: TranslateInput,
  options: TaskOptions,
  onChunk: (delta: string) => void
): Promise<TaskResult> {
  const config = TASK_CONFIG[task]
  const started = performance.now()

  const override = readPromptOverride(task)
  const taskPrompt = override ?? config.defaultTask
  const promptVersion = override ? `${config.version}~${hashText(override).slice(0, 8)}` : config.version

  const cacheKey = makeCacheKey({
    task,
    provider: options.provider,
    promptVersion,
    text: input.text,
    before: input.before,
    after: input.after
  })

  if (options.useCache !== false) {
    const cached = await readCache(cacheKey)
    if (cached) {
      onChunk(cached.text)
      return { text: cached.text, cached: true, elapsedMs: performance.now() - started }
    }
  }

  let text = ''
  await streamChat(
    {
      id: newRequestId(),
      provider: options.provider,
      messages: config.build(input, taskPrompt),
      temperature: config.temperature,
      maxTokens: config.maxTokens
    },
    (delta) => {
      text += delta
      onChunk(delta)
    }
  )

  if (text.trim().length > 0) {
    void writeCache({
      key: cacheKey,
      text,
      source: input.text.slice(0, 500),
      model: options.provider,
      createdAt: Date.now()
    })
  }

  return { text, cached: false, elapsedMs: performance.now() - started }
}
