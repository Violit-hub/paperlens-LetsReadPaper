/**
 * 验证 prompt 的「固定前缀」真的固定。
 *
 * 这是这次改动的核心目的：同一篇论文、不同段落发出去的请求，
 * 从第一个 token 到术语表结束必须逐字节一致，否则模型侧的 prompt cache
 * 会在中间断掉，省钱的收益就没了。
 *
 * 做法：把 prompts.ts 单独编译成 cjs，直接调纯函数比较两次请求的公共前缀。
 *
 * 用法：node scripts/prompt-prefix-test.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = resolve(ROOT, '.tmp/prompts-test.cjs')
const require = createRequire(import.meta.url)

async function main() {
  await build({
    entryPoints: [resolve(ROOT, 'src/renderer/src/ai/prompts.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: OUT,
    logLevel: 'silent'
  })

  const { buildTranslateMessages, PROMPT_VERSION } = require(OUT)

  const shared = {
    title: 'Retrieval-Augmented Instruction Tuning for Low-Resource Scientific QA',
    abstract: 'We study whether retrieval-augmented instruction tuning closes the gap.',
    glossary: 'retrieval augmentation → 检索增强\ninstruction tuning → 指令微调',
    before: '前一段的结尾内容，只用来理解语境。',
    after: '后一段的开头内容，同样只是语境。'
  }

  const a = buildTranslateMessages({ ...shared, text: 'Large language models have become the default interface.' })
  const b = buildTranslateMessages({ ...shared, text: 'A completely different paragraph from another column.' })

  const ua = a[1].content
  const ub = b[1].content

  // 逐字符比较公共前缀
  let prefix = 0
  while (prefix < ua.length && prefix < ub.length && ua[prefix] === ub[prefix]) prefix++

  const fixedPart = ua.slice(0, prefix)
  const iTranslate = ua.indexOf('[待翻译]')
  const iContext = ua.indexOf('[补充语境')

  const report = {
    promptVersion: PROMPT_VERSION,
    systemSame: a[0].content === b[0].content,
    commonPrefixChars: prefix,
    commonPrefixRatio: `${((prefix / ua.length) * 100).toFixed(1)}%`,
    prefixHasTitle: fixedPart.includes('[论文信息]'),
    prefixHasGlossary: fixedPart.includes('[术语表]'),
    prefixEndsCleanly: fixedPart.endsWith('\n\n'),
    translateBeforeContext: iTranslate >= 0 && iContext > iTranslate,
    messageOrder: ua.indexOf('[论文信息]') < ua.indexOf('[术语表]')
      ? '[论文信息] → [术语表] → [待翻译] → [补充语境]'
      : 'UNEXPECTED ORDER',
    prefixTail: JSON.stringify(fixedPart.slice(-80))
  }

  console.log(JSON.stringify(report, null, 2))

  const ok =
    report.systemSame &&
    report.prefixHasTitle &&
    report.prefixHasGlossary &&
    report.translateBeforeContext &&
    prefix > 200

  console.log(ok ? '\nPASS 前缀稳定' : '\nFAIL 前缀不稳定')

  rmSync(resolve(ROOT, '.tmp'), { recursive: true, force: true })
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exit(1)
})
