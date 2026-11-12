// @vitest-environment node
/**
 * 产物语言：配置解析 + 两类提示词的语言要求。
 *
 * 这条链是「图能不能被不读中文的人看懂」的唯一开关：`outputLanguage` 走配置 →
 * `resolveOutputLanguage` 归一 → 提示词把要求写死。断言写具体值，不做松断言。
 */

import { describe, expect, test } from 'vitest'
import { resolveConfig } from '../../src/host/config.js'
import { resolveOutputLanguage } from '../../src/shared/language.js'
import { buildAskPrompt, buildRunPrompt, type PromptDiagram } from '../../src/shared/prompt.js'
import { emptyGitSnapshot } from '../../src/shared/types.js'

const diagram: PromptDiagram = {
  id: 'structure',
  kind: 'structure',
  title: '项目结构',
  prompt: null,
  persistence: 'permanent',
  conceptIds: [],
  renderer: null,
  pathScope: [],
}

const base = {
  projectName: 'Demo',
  repoPath: '/repo',
  workspaceDir: '/ws/demo',
  stamp: '20261106-130509',
  archifySkillPath: null,
  concepts: [],
  previous: {},
  git: emptyGitSnapshot('2026-11-06T12:00:00Z'),
  diagrams: [diagram],
}

describe('resolveOutputLanguage', () => {
  test('英文的常见写法都归到 English + en', () => {
    for (const raw of ['en', 'EN', 'English', 'english', 'en-US', 'eng']) {
      expect(resolveOutputLanguage(raw)).toEqual({ name: 'English', locale: 'en' })
    }
  })

  test('中文的常见写法都归到 中文 + zh-CN', () => {
    for (const raw of ['zh', 'zh-CN', 'zh_TW', '中文', '简体中文', 'Chinese']) {
      expect(resolveOutputLanguage(raw)).toEqual({ name: '中文', locale: 'zh-CN' })
    }
  })

  test('认不出的语言照用正文，图例落英文', () => {
    expect(resolveOutputLanguage('de')).toEqual({ name: 'de', locale: 'en' })
    expect(resolveOutputLanguage('  Español  ')).toEqual({ name: 'Español', locale: 'en' })
  })
})

describe('resolveConfig：outputLanguage', () => {
  test('给了语言就归一，缺省是 null', () => {
    const warnings: string[] = []
    expect(resolveConfig({ dataDir: '/tmp/x' }, warnings).outputLanguage).toBeNull()
    expect(
      resolveConfig({ dataDir: '/tmp/x', outputLanguage: 'en' }, warnings).outputLanguage,
    ).toEqual({ name: 'English', locale: 'en' })
    expect(warnings).toEqual([])
  })

  test('不是字符串就忽略并记一条 warning，不炸启动', () => {
    const warnings: string[] = []
    const config = resolveConfig({ dataDir: '/tmp/x', outputLanguage: 42 }, warnings)
    expect(config.outputLanguage).toBeNull()
    expect(warnings.join('\n')).toContain('outputLanguage')
  })
})

describe('buildRunPrompt：产物语言', () => {
  test('指定语言时写死字段清单与 meta.locale，且排在硬约束之前', () => {
    const text = buildRunPrompt({ ...base, outputLanguage: { name: 'English', locale: 'en' } })
    expect(text).toContain('## 产物语言（硬性）')
    expect(text).toContain('English')
    expect(text).toContain('"en"')
    expect(text).toContain('candidate.json')
    expect(text.indexOf('## 产物语言（硬性）')).toBeLessThan(text.indexOf('## 硬约束'))
  })

  test('不指定语言时一个字的语言要求都不加（历史行为不变）', () => {
    const text = buildRunPrompt(base)
    expect(text).not.toContain('产物语言')
  })
})

describe('buildAskPrompt：回答语言', () => {
  const ask = {
    projectName: 'Demo',
    repoPath: '/repo',
    diagram,
    concepts: [],
    candidate: null,
    question: '这个模块怎么初始化？',
  }

  test('指定语言时要求用该语言回答', () => {
    const text = buildAskPrompt({ ...ask, outputLanguage: { name: 'English', locale: 'en' } })
    expect(text).toContain('## 回答语言（硬性）')
    expect(text).toContain('用 English')
  })

  test('不指定语言时不加语言要求', () => {
    expect(buildAskPrompt(ask)).not.toContain('回答语言')
  })
})
