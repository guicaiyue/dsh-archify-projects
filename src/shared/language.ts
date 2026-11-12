/**
 * 产物语言：把配置里的写法收敛成「让 agent 用哪种语言写」+「图的 `meta.locale` 填什么」。
 *
 * 两件事必须分开：
 *   - `name` 是提示词里要求的**人类语言**，可以任意（`de`、`日本語`、`Español` 都行）；
 *   - `locale` 只是 Archify 渲染器的界面语言，目录里只有 `en` 和 `zh-CN` 两套
 *     （见 `skills/archify/renderers/shared/i18n.mjs` 的 `SUPPORTED_LOCALES`），
 *     认不出来就落 `en` —— 图例/工具栏是英文，正文照样用用户要的语言。
 *
 * 渲染器只本地化图例、工具栏、无障碍文案这几块 chrome；节点文字是 agent 写进
 * `candidate.json` 的，所以正文语言只能靠提示词要求。
 */

export interface OutputLanguage {
  /** 提示词里用的语言名（人类可读，例如 `English`）。 */
  readonly name: string
  /** 渲染器 `meta.locale` 的取值，只能是 `en` 或 `zh-CN`。 */
  readonly locale: 'en' | 'zh-CN'
}

/** 按主语言子标签识别的语言；键是小写主标签。 */
const PRIMARY: Record<string, OutputLanguage> = {
  en: { name: 'English', locale: 'en' },
  zh: { name: '中文', locale: 'zh-CN' },
}

/** 不是 BCP 47 标签、但用户会写的别名。 */
const NAMED_ALIASES: Record<string, string> = {
  english: 'en',
  eng: 'en',
  chinese: 'zh',
  中文: 'zh',
  简体中文: 'zh',
  简体: 'zh',
}

/**
 * 解析 `outputLanguage`。
 *
 * 认不出的语言不报错也不丢弃：正文按用户写的名字要求，`meta.locale` 落 `en`
 * （宁可图例英文，也不要中文图例配德文正文）。
 */
export function resolveOutputLanguage(raw: string): OutputLanguage {
  const value = raw.trim()
  const key = value.toLowerCase().replace(/_/g, '-')
  const primary = PRIMARY[NAMED_ALIASES[key] ?? (key.split('-')[0] as string)]
  if (primary !== undefined) return primary
  return { name: value, locale: 'en' }
}
