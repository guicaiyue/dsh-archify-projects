/**
 * Agent 提示词构建与产物标记解析（纯函数）。
 *
 * 这段文本是插件与 agent 之间唯一的契约面：agent 只有 archify 一个 skill、
 * 只有 fs / fs-search 几个工具，所以提示词必须把「做什么、概念怎么报、产物写哪、
 * 怎么回报」讲死，不能依赖模型猜。
 *
 * 两种会话：
 *   - 出图会话：写产物 + 概念表（{@link buildRunPrompt}）；
 *   - 问答会话：只读代码 + 已生成的图（{@link buildAskPrompt}），没有任何写工具。
 */

import type { OutputLanguage } from './language.js'
import { ARTIFACT_MARKER } from './protocol.js'
import type { ArchifyType, Concept, DiagramMode, GitSnapshot, Persistence } from './types.js'

/** 一次出图要交付的一张图。 */
export interface PromptDiagram {
  readonly id: string
  readonly kind: DiagramMode
  readonly title: string
  readonly prompt: string | null
  readonly persistence: Persistence
  readonly conceptIds: readonly string[]
  readonly renderer: ArchifyType | null
  readonly pathScope: readonly string[]
}

/** 构建出图提示词需要的全部事实。 */
export interface RunPromptInput {
  readonly projectName: string
  readonly repoPath: string
  readonly workspaceDir: string
  readonly git: GitSnapshot
  readonly diagrams: readonly PromptDiagram[]
  /** 上一轮已经提取的概念（让 agent 复用而不是重造）。 */
  readonly concepts: readonly Concept[]
  /** `YYYYMMDD-HHMMSS`，用于 archify 目录名。 */
  readonly stamp: string
  /** archify Skill 的绝对根目录；null 表示环境降级（没有 skill 可用）。 */
  readonly archifySkillPath: string | null
  /** 产物语言；null / 缺省表示不干预（沿用历史行为，agent 跟随提示词语言）。 */
  readonly outputLanguage?: OutputLanguage | null
  /** 每张图上一版的分支（null 表示以前没生成过）。 */
  readonly previous: Readonly<Record<string, string | null>>
}

/** 问答会话的输入。 */
export interface AskPromptInput {
  readonly projectName: string
  readonly repoPath: string
  readonly diagram: PromptDiagram
  readonly concepts: readonly Concept[]
  /** 这张图当前的 candidate.json（截断后）；null 表示没有。 */
  readonly candidate: string | null
  readonly question: string
  /** 回答语言；null / 缺省表示不干预。 */
  readonly outputLanguage?: OutputLanguage | null
}

/** 默认两张图的建模口径。 */
const KIND_SPEC: Record<'structure' | 'domain', string> = {
  structure: [
    '项目结构图（structure）——回答「这个代码库由什么组成、怎么依赖」。',
    '必含：入口/装配层、核心业务模块、基础设施适配层、外部依赖（数据库/队列/第三方服务）。',
    '必须画出至少一条主调用链，以及必要的分支；不要把每个文件都画成一个节点。',
    '用 boundary 表达进程/网络/信任边界（如「主进程」「外部服务」）。',
  ].join('\n'),
  domain: [
    '领域图（domain）——回答「这块业务的领域模型是什么」。',
    '必含：限界上下文、聚合根、实体/值对象、领域事件，以及上下文之间的协作关系。',
    '必须写清聚合内的一致性边界；不要把它画成技术架构图。',
    '如果你判断仓库规模不足以建模领域层（例如纯脚手架），就在图的 meta 里写明这一点，并退化为「模块职责图」。',
  ].join('\n'),
}

/** 渲染 Git 事实块（分支级，不强调 commit）。 */
function gitBlock(git: GitSnapshot): string {
  if (!git.isRepo) {
    return [
      '- 这个目录**不是 Git 仓库**：没有分支。',
      '- 因此不要执行任何 git 命令，也不要在报告里编造分支名。',
      '- 分析对象就是当前目录下的代码。',
    ].join('\n')
  }
  const lines = [`- 分支：${git.detached ? `detached HEAD` : (git.branch ?? '未知')}`]
  if (git.tree !== null) {
    const { staged, unstaged, untracked } = git.tree
    if (staged + unstaged + untracked > 0) {
      lines.push(
        `- 工作区有改动（暂存 ${staged}、未暂存 ${unstaged}、未跟踪 ${untracked}）：**以工作区当前内容为准**，暂存区里的代码同样算数。`,
      )
    } else {
      lines.push('- 工作区干净。')
    }
  } else if (git.dirty === true) {
    lines.push('- 工作区**有未提交改动**：分析时以工作区当前内容为准。')
  }
  return lines.join('\n')
}

/** 渲染 archify 调用方式。 */
function archifyBlock(
  skillPath: string | null,
  diagrams: readonly PromptDiagram[],
  stamp: string,
): string {
  if (skillPath === null) {
    return [
      '## 环境降级：archify Skill 不可用',
      '',
      '本次没有挂载 archify skill。请退化为「手写 JSON + 内联 SVG 的单页 HTML」：',
      '每张图输出一个自包含的 HTML 文件（inline SVG，深浅色都可用），放在当前工作目录的 `.archify/` 下：',
      ...diagrams.map((d) => `  - ${d.id} -> .archify/${d.id}-<slug>-${stamp}/`),
      '仍然要遵守下面的回报标记约定；并在最终回复里明确说明本次是降级产物。',
    ].join('\n')
  }
  return [
    '## 出图方式（必须用 archify skill）',
    '',
    `1. 先用 \`skill\` 工具加载 \`archify\`（name 必须正好是 \`archify\`）。`,
    `2. 按 Skill 里的「Fast authoring path」执行：选类型 → 读 references → 写 \`candidate.json\` → 跑 \`finalize\`。`,
    '3. 每张图一个独立目录，统一放在当前工作目录下的 `.archify/` 里（目录名以图的 id 开头）：',
    ...diagrams.map((d) => `   - ${d.id} → \`.archify/${d.id}-<slug>-${stamp}/\``),
    `4. \`finalize\` 命令（把 \`<skill>\` 换成 \`${skillPath}\`，把 \`<slug>\` 换成你选的短名）：`,
    '   ```',
    `   node "${skillPath}/bin/archify.mjs" finalize architecture ` +
      `<目录>/candidate.json <目录>/<slug>.html --repo-root "<REPO_ROOT>" --quality showcase --json`,
    '   ```',
    '5. 全部图都用 type `architecture`（structure 与 domain 的区别在建模口径，不在 type）。',
    '6. `finalize` 非 0 退出就是失败：按 Skill 的修复流程改 candidate 再跑，别把失败当成功上报。',
  ].join('\n')
}

/** 渲染已有概念块。 */
function conceptBlock(concepts: readonly Concept[]): string {
  if (concepts.length === 0) {
    return '（还没有概念表：这次先提取，写到 `concepts.json`。）'
  }
  return concepts
    .map(
      (c) =>
        `- \`${c.id}\` ${c.name}：${c.summary}` +
        (c.evidence.length > 0 ? `（证据：${c.evidence.slice(0, 4).join('、')}）` : ''),
    )
    .join('\n')
}

/** 每张图的建模段。 */
function diagramBlock(diagram: PromptDiagram, previousBranch: string | null): string {
  const head = `### ${diagram.title}（id: \`${diagram.id}\`，${diagram.persistence === 'permanent' ? '永久图' : '临时图'}）`
  const prev =
    previousBranch === null
      ? '- 这张图以前没生成过。'
      : `- 上一版生成于分支 \`${previousBranch}\`，本次请基于当前代码重新取证，不要沿用旧结论。`
  const renderer =
    diagram.renderer === null
      ? '- 渲染器：由你按 prompt 自行选择（architecture / workflow / sequence / dataflow / lifecycle 之一）。'
      : `- 渲染器：**必须使用 \`${diagram.renderer}\`**（用户已选）。`
  const scope =
    diagram.pathScope.length === 0
      ? '- 取证范围：全仓库。'
      : `- 取证范围：**只看这些目录** —— ${diagram.pathScope.map((dir) => `\`${dir}\``).join('、')}；不要读范围外的文件。`
  if (diagram.kind === 'custom') {
    return [
      head,
      `用户的出图要求（最高优先级）：\n${diagram.prompt ?? '（没有给 prompt，请按代码库最重要的结构画）'}`,
      renderer,
      scope,
      prev,
    ].join('\n')
  }
  return [head, KIND_SPEC[diagram.kind], renderer, scope, prev].join('\n')
}

/**
 * 构建一次出图运行的完整提示词。
 *
 * 结果是**自包含**的：agent 看不到本插件的任何文档，只有这段文本 + SKILL.md。
 */
/**
 * 产物语言要求（出图会话）。
 *
 * 渲染器只本地化 chrome，节点文字是 agent 写进 candidate.json 的；不在这里写死
 * 要求，agent 就会跟着提示词本身的语言走（历史上就是中文，见 README「语言」）。
 */
function runLanguageBlock(language: OutputLanguage | null): string {
  if (language === null) return ''
  return `## 产物语言（硬性）

图是给人读的，面向读者的文字一律用 ${language.name} 写：

- 必须翻译：\`meta.title\` / \`meta.subtitle\` / \`meta.description\`、\`components[].label\` / \`sublabel\` / \`tag\`、\`connections[].label\`、\`cards[].title\` / \`items\`、\`boundaries[].label\`，以及所有清单条目的说明文字。
- 保持原文：文件路径、目录名、类型/函数/类名、命令、环境变量、产品与协议名（如 FastAPI、Redis、mTLS）。
- \`candidate.json\` 的 \`meta.locale\` 必须写 \`"${language.locale}"\`：图例、工具栏、无障碍文案才会和正文同一语言。
- \`concepts.json\` 的 \`name\` / \`summary\` 也用 ${language.name} —— 页面与问答会话直接显示它们。

`
}

/** 回答语言要求（问答会话）：不改提示词语言，只约束回答文字。 */
function askLanguageBlock(language: OutputLanguage | null): string {
  if (language === null) return ''
  return `## 回答语言（硬性）

用 ${language.name} 回答；文件路径、符号名、命令与产品名保持原文。

`
}

export function buildRunPrompt(input: RunPromptInput): string {
  const { projectName, repoPath, workspaceDir, git, diagrams, concepts, stamp, archifySkillPath } =
    input

  const sections = diagrams
    .map((diagram) => diagramBlock(diagram, input.previous[diagram.id] ?? null))
    .join('\n\n')

  const markers = diagrams
    .map((d) => `${ARTIFACT_MARKER} ${d.id} <该图的 HTML 绝对路径>`)
    .join('\n')

  return `# 任务：为代码库「${projectName}」生成 Archify 图谱

## 环境事实

- 你的工作目录（也是产物目录）：\`${workspaceDir}\`
- 待分析的代码库根目录：\`${repoPath}\`
- 本次时间戳：\`${stamp}\`
${gitBlock(git)}

## 概念表（先提取，再画图）

这个仓库已经有一份项目级概念表；本次先读它、按需补充，然后在**工作目录根**写回
\`concepts.json\`（覆盖写，保留仍然成立的概念）：

\`\`\`json
{
  "concepts": [
    {
      "id": "cpt_ledger",
      "name": "项目台账",
      "summary": "一句话说明它是什么、边界在哪",
      "evidence": ["src/host/store.ts"],
      "tags": ["data"]
    }
  ]
}
\`\`\`

要求：id 用 \`cpt_<小写短名>\`；只写能从代码里指出证据的概念（约 10–25 个）；
不要写「工具函数」「index 文件」这类没有架构意义的条目。

已有概念：

${conceptBlock(concepts)}

## 本次要交付的图

${sections}

${archifyBlock(archifySkillPath, diagrams, stamp)}
${runLanguageBlock(input.outputLanguage ?? null)}
## 硬约束

0. **先建 todo**：开工第一步就调用 \`todo_write\`，把这次工作拆成 4–7 步（例：读代码 → 提概念 → 每张图 candidate → finalize → 回报），之后每完成一步就更新一次；最后一步固定是「回报产物标记」。页面靠这份 todo 显示进度。
1. **只读代码库**：可以 read / grep / glob 任意文件，可以跑只读 git 命令；不许 write / edit / 删除 / 移动代码库里的任何文件，不许切分支、不许 commit。
2. **产物只写工作目录**：\`candidate.json\`、HTML 与 \`concepts.json\` 都落在工作目录下，不要写进代码库。
3. 不要输出与图谱无关的总结长文；不要中途问问题，需要的信息自己去代码里查。
4. 证据优先：每个节点/关系都要能对应到真实文件或目录，别凭项目名猜。

## 结束前必须打印的回报

在最终回复的最后，单独列出这几行（替换尖括号内容，路径必须是绝对路径）：

\`\`\`
${markers}
\`\`\`

另外请一并说明每张图的节点数、关系数，以及你在代码里实际读过的关键路径（3–8 条）。`
}

/**
 * 构建问答会话的提示词。
 *
 * 这个会话是**只读**的：只有 read / glob / grep / skill(archify) 四个工具，
 * 上下文里只给「这张图的产物摘要 + 概念表 + 代码库根」，回答必须落在这三样上。
 */
export function buildAskPrompt(input: AskPromptInput): string {
  const { projectName, repoPath, diagram, concepts, candidate, question } = input
  const relevant = diagram.conceptIds
    .map((id) => concepts.find((c) => c.id === id))
    .filter((c): c is Concept => c !== undefined)
  const conceptLines =
    relevant.length > 0
      ? relevant
          .map(
            (c) =>
              `- \`${c.id}\` ${c.name}：${c.summary}` +
              (c.evidence.length > 0 ? `（证据：${c.evidence.slice(0, 5).join('、')}）` : ''),
          )
          .join('\n')
      : '（这张图没有绑定具体概念，可参考项目概念表。）'

  return `# 任务：就「${projectName}」的一张已生成的架构图回答细节问题

## 环境事实

- 代码库根目录：\`${repoPath}\`（只读；可以 read / grep / glob）
- 这张图：\`${diagram.title}\`（id: \`${diagram.id}\`）
- 图的建模要求：${diagram.prompt ?? '（默认口径）'}
${diagram.pathScope.length === 0 ? '- 取证范围：全仓库。' : `- 取证范围：只看 ${diagram.pathScope.join('、')}，回答时不要引用范围外的文件。`}
${diagram.pathScope.length === 0 ? '- 取证范围：全仓库。' : `- 取证范围：只看 ${diagram.pathScope.join('、')}，回答时不要引用范围外的文件。`}

## 这张图已绑定的概念

${conceptLines}

## 这张图当前的产物摘要（candidate.json 截断）

\`\`\`json
${candidate === null ? '（没有读到 candidate.json，只能依据代码回答）' : candidate}
\`\`\`

## 用户的问题

${question}

${askLanguageBlock(input.outputLanguage ?? null)}
## 回答要求

0. **先建 todo**：开工第一步调用 \`todo_write\`，把这次回答拆成 3–5 步（例：看图的产物 → 读相关代码 → 整理结论），每完成一步更新一次。
1. **只看代码库和上面的图**：不要引用外部资料，不要猜没读过的文件。
2. 先给结论（一句话），再给依据；依据要写清文件路径（相对仓库根）与关键符号/函数名。
3. 如果代码里查不到，直接说「代码里没有找到」，不要编。
4. 如果问题指向图里没有覆盖的细节，在最后列出「建议补进图里的节点/关系」（2–5 条），
   用短句描述，方便用户一键并进图里。
5. 不要输出与问题无关的长篇总结。`
}

/**
 * 从 agent 的最终文本里解析产物标记。
 *
 * 容错：大小写不敏感、行内可有前后空白、路径可带引号。同一 id 多次出现取最后一次。
 * 旧格式（`ARCHIFY_ARTIFACT structure <path>`）仍然接受。
 */
export function parseArtifactMarkers(text: string): Map<string, string> {
  const result = new Map<string, string>()
  const pattern = new RegExp(`^\\s*${ARTIFACT_MARKER}\\s+([A-Za-z0-9_-]+)\\s+(.+?)\\s*$`, 'gim')
  for (const match of text.matchAll(pattern)) {
    const id = match[1]?.trim().toLowerCase()
    const rawPath = match[2]?.trim()
    if (id === undefined || id.length === 0 || rawPath === undefined) continue
    const cleaned = rawPath.replace(/^[`'"]+|[`'"]+$/g, '').trim()
    if (cleaned.length === 0) continue
    result.set(id, cleaned)
  }
  return result
}
