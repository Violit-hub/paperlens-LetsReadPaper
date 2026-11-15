/**
 * 用户自定义的 prompt 覆盖。
 *
 * 只允许改「任务要求」那一段（翻译要什么风格、讲解讲到多细），
 * 论文信息 / 术语表 / 待翻译这些标签由程序拼接，不暴露给用户 ——
 * 否则很容易改坏结构，模型就不知道该翻哪一段了。
 *
 * 覆盖内容会参与缓存键计算：改完 prompt，旧译文自动失效，不会拿旧结果糊弄你。
 */

export type PromptTask = 'translate' | 'explain'

const STORAGE_KEYS: Record<PromptTask, string> = {
  translate: 'paperlens.prompt.translate',
  explain: 'paperlens.prompt.explain'
}

export function readPromptOverride(task: PromptTask): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEYS[task])
    return value && value.trim().length > 0 ? value : null
  } catch {
    return null
  }
}

export function writePromptOverride(task: PromptTask, value: string, defaultValue: string): void {
  try {
    // 内容和默认值一样就删掉，别在 localStorage 里留一份永远同步不了的副本
    if (value.trim().length === 0 || value.trim() === defaultValue.trim()) {
      localStorage.removeItem(STORAGE_KEYS[task])
    } else {
      localStorage.setItem(STORAGE_KEYS[task], value)
    }
  } catch {
    /* ignore */
  }
}

export function hasPromptOverride(task: PromptTask): boolean {
  return readPromptOverride(task) !== null
}
