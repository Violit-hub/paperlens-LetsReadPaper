/**
 * 翻译错误的分类与展示。
 *
 * 主进程会把失败原因序列化成一段 JSON 塞进 Error.message，这里负责反解。
 * 之所以要在主进程分类而不是渲染进程：主进程能看到 HTTP 状态码和原始响应体，
 * 而经过 IPC 之后这些东西通常只剩下一坨难看的字符串。
 */

export type ErrorKind =
  | 'no-key'
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'bad-request'
  | 'unknown'

export interface TranslationError {
  kind: ErrorKind
  /** 一句话结论，直接显示给用户 */
  message: string
  /** 该怎么做，一句话 */
  hint?: string
  /** 原始报错，折叠在「技术细节」里 */
  detail?: string
  status?: number
}

/** 这些错误重新点「重试」有意义；Key 相关的没有 */
export function isRetryable(kind: ErrorKind): boolean {
  return kind === 'network' || kind === 'timeout' || kind === 'rate-limit' || kind === 'server'
}

export function needsSettings(kind: ErrorKind): boolean {
  return kind === 'no-key' || kind === 'auth' || kind === 'quota'
}

/**
 * 从 IPC 抛回来的错误里还原结构化信息。
 * Electron 的 invoke reject 会在前面加 "Error invoking remote method ..."，
 * 所以用正则找出那段 JSON。
 */
export function parseTranslationError(error: unknown): TranslationError {
  const raw = error instanceof Error ? error.message : String(error)
  const jsonMatch = raw.match(/\{[\s\S]*\}/)

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown
      if (parsed && typeof parsed === 'object' && typeof (parsed as TranslationError).kind === 'string') {
        return parsed as TranslationError
      }
    } catch {
      /* 不是我们的 JSON，继续往下兜底 */
    }
  }

  if (raw.includes('NO_API_KEY')) {
    return {
      kind: 'no-key',
      message: '还没有配置 API Key',
      hint: '点「打开设置」填入 DeepSeek 的 Key，格式是 sk- 开头的一串字符。'
    }
  }

  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(raw)) {
    return {
      kind: 'network',
      message: '连不上模型服务',
      hint: '检查网络或代理设置；如果是本地 Ollama，确认它已经启动。',
      detail: raw.slice(0, 400)
    }
  }

  if (/abort/i.test(raw)) {
    return { kind: 'aborted', message: '请求已取消' }
  }

  return {
    kind: 'unknown',
    message: '翻译失败',
    hint: '可以点「重试」；连续失败的话看一眼技术细节。',
    detail: raw.slice(0, 400)
  }
}
