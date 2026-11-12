/**
 * Agent 编排：一次运行 = 一个 DSH 会话 + 一段结构化提示词 + 产物/概念回收。
 *
 * 走的是宿主已经有的东西，不新造轮子：
 *   - 会话由 `ctx.sessionController.create({ cwd, agentPreset })` 起（复用 DSH 的
 *     模型/日志/审批），preset 就是 `cordis.patch.yml` 里那个受限组合；
 *   - 提示词经 `ctx.sessionController.prompt(...)` 进 agent 收件箱；
 *   - 结束靠 `agent.whenIdle()`，产物靠「标记优先 + 目录兜底」回收。
 *
 * 两种会话：
 *   - 出图：可写工作目录，跑 archify；
 *   - 提问：只读（read / glob / grep / skill），上下文只有这张图 + 概念表 + 代码库。
 */

import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  buildAskPrompt,
  buildRunPrompt,
  parseArtifactMarkers,
  type PromptDiagram,
} from '../shared/prompt.js'
import {
  allDiagrams,
  DIAGRAM_KINDS,
  findDiagram,
  settleTodos,
  usageTotalOf,
  type Concept,
  type DiagramKind,
  type DiagramState,
  type Project,
  type RunKind,
  type RunRecord,
  type QaEntry,
  type TodoItem,
  type TokenUsage,
  type TreeState,
} from '../shared/types.js'
import { projectDir, workspaceRoot, type ResolvedConfig } from './config.js'
import {
  serviceOf,
  type AgentDefaultModelLike,
  type AgentLike,
  type AgentModelLike,
  type AgentPresetsLike,
  type AgentsLike,
  type HostContext,
  type SessionControllerLike,
  type SessionProjectionsLike,
} from './context.js'
import type { ModelRef } from '../shared/protocol.js'
import { readModelCatalog, readModelRef } from './models.js'
import {
  allowedToolNames,
  readonlyToolNames,
  tightenAgent,
  tightenReadOnlyAgent,
} from './policy.js'
import { readSettings } from './settings.js'
import type { ProjectStore } from './store.js'
import { ensureProjectWorkspace } from './workspace.js'

/** 运行发起后的回执。 */
export interface StartedRun {
  readonly runId: string
  readonly sessionId: string | null
  readonly kind: RunKind
}

/** runner 的依赖。 */
export interface RunnerDeps {
  readonly ctx: HostContext
  readonly store: ProjectStore
  readonly config: ResolvedConfig
  /** 懒解析 archify skill 目录（可能为 null，表示降级）。 */
  readonly skillDir: () => Promise<string | null>
}

/** 一次提问的结果。 */
export interface AskResult {
  readonly sessionId: string | null
  readonly entry: QaEntry
}

/** 生成可读的运行 id（不追求全局唯一，台账里可区分即可）。 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 6)
  return `run_${stamp}_${rand}`
}

/** 生成请求 id（prompt 的幂等标识）。 */
function newRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 跑一次运行。 */
export class Runner {
  private readonly deps: RunnerDeps
  private readonly busy = new Map<string, Promise<void>>()

  constructor(deps: RunnerDeps) {
    this.deps = deps
  }

  /** 该项目是否已有任务在跑。 */
  isBusy(projectId: string): boolean {
    return this.busy.has(projectId)
  }

  /** 等某个项目当前的运行结束（没有在跑就返回 undefined）。 */
  whenSettled(projectId: string): Promise<void> | undefined {
    return this.busy.get(projectId)
  }

  /**
   * 起一次出图运行。
   *
   * `diagramIds` 里默认图用 `structure` / `domain`，自定义图用 `dgm_xxx`。
   * 临时图不参与「更新图册」，只会在被显式创建/重画时进来。
   */
  async start(project: Project, kind: RunKind, diagramIds: readonly string[]): Promise<StartedRun> {
    if (this.isBusy(project.id)) {
      throw new RunnerBusy(project.id)
    }
    const { store, config } = this.deps
    const diagrams = diagramIds
      .map((id) => findDiagram(project, id))
      .filter((d): d is DiagramState => d !== undefined)
    if (diagrams.length === 0) throw new RunnerUnavailable('没有可运行的图')

    const runId = newRunId()
    const startedAt = new Date().toISOString()

    const workspaceDir = await ensureProjectWorkspace(config, project.id)
    const skillDir = await this.deps.skillDir()
    const prompt = buildRunPrompt({
      projectName: project.name,
      repoPath: project.repoPath,
      workspaceDir,
      git: project.git,
      diagrams: diagrams.map(toPromptDiagram),
      concepts: project.concepts,
      stamp: stampOf(new Date()),
      archifySkillPath: skillDir,
      outputLanguage: config.outputLanguage,
      previous: previousBranches(diagrams),
    })

    const sessionId = await this.openSession(workspaceDir, prompt, 'draw')

    const record: RunRecord = {
      id: runId,
      kind,
      status: 'running',
      sessionId,
      startedAt,
      finishedAt: null,
      error: null,
      note: null,
      diagramIds: diagrams.map((d) => d.id),
      todos: [],
      usage: null,
    }
    await store.patch(project.id, (current) => ({
      ...current,
      updatedAt: startedAt,
      lastRun: record,
      runs: pushRun(current.runs, record, config.keepRuns),
      ...markStatuses(
        current,
        diagrams.map((d) => d.id),
        'running',
      ),
    }))

    const tracked = this.follow(
      project.id,
      runId,
      diagrams.map((d) => d.id),
    ).finally(() => {
      this.busy.delete(project.id)
    })
    this.busy.set(project.id, tracked)

    return { runId, sessionId, kind }
  }

  /**
   * 对一张图提问（只读会话）。
   *
   * 上下文只有三样：这张图的 prompt + 产物摘要、项目概念表、代码库根目录。
   * 工具面是 read / glob / grep / skill(archify) —— 没有 shell、没有写工具。
   */
  async ask(project: Project, diagramId: string, question: string): Promise<AskResult> {
    if (this.isBusy(project.id)) {
      throw new RunnerBusy(project.id)
    }
    const { store, config } = this.deps
    const diagram = findDiagram(project, diagramId)
    if (diagram === undefined) throw new RunnerUnavailable('图不存在')

    const workspaceDir = await ensureProjectWorkspace(config, project.id)
    const candidate = await readCandidate(config, project, diagram)
    const prompt = buildAskPrompt({
      projectName: project.name,
      repoPath: project.repoPath,
      diagram: toPromptDiagram(diagram),
      concepts: project.concepts,
      candidate,
      question,
      outputLanguage: config.outputLanguage,
    })

    const qaId = `qa_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const createdAt = new Date().toISOString()
    const pending: QaEntry = {
      id: qaId,
      diagramId: diagram.id,
      question,
      answer: '',
      at: createdAt,
      applied: false,
      status: 'running',
      todos: [],
      usage: null,
    }
    await store.patch(project.id, (current) => ({
      ...current,
      updatedAt: createdAt,
      qa: [...current.qa, pending],
    }))

    const run = (async (): Promise<AskResult> => {
      const { ctx } = this.deps
      const sessionId = await this.openSession(workspaceDir, prompt, 'ask')
      const agent = agentOf(ctx, sessionId)
      let stop = (): void => {}
      let text = ''
      let usage: TokenUsage | null = null
      try {
        if (agent !== undefined) {
          stop = this.watchQaTodos(project.id, qaId, agent)
          await withTimeout(agent.whenIdle(), config.askTimeoutMs)
          text = readFinalText(agent)
          usage = usageOf(ctx, agent)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const failed = await this.finishQa(project.id, qaId, {
          answer: `（提问失败：${message}）`,
          status: 'failed',
          usage,
        })
        return { sessionId, entry: failed }
      } finally {
        stop()
      }
      const entry = await this.finishQa(project.id, qaId, {
        answer: text.length > 0 ? text : '（这次提问没有拿到回答：会话结束时没有 assistant 文本）',
        status: 'done',
        usage,
      })
      return { sessionId, entry }
    })()

    const tracked = run
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.busy.delete(project.id)
      })
    this.busy.set(project.id, tracked)
    return run
  }

  /**
   * 建会话并投递提示词。
   *
   * **首选「子代理会话」**：直接用 `ctx.agents.create` 建一个 `origin: 'subagent'`
   * 的 agent，preset 通过 `agentPresets.mount()` 在它的 setup 作用域里装上，
   * 模型走 `agentOptions`（用户在设置里选的，或宿主默认）。
   *
   * 这条路满足三件在 `sessionController` 那条路上做不到的事：
   *   1. 会话被标成子代理 —— DSH 侧边栏的会话列表按 `origin === 'subagent'`
   *      过滤，分析不再往用户的对话列表里塞一条条「新会话」；
   *   2. 每次运行**可以带自己的模型**，而不会顺手改掉宿主里那个全局默认模型
   *      （`sessionController.selectModel` 会把选择存成默认，这是它的契约）；
   *   3. preset 的组装在 setup 里完成，工具白名单与 persona 与原来完全一致。
   *
   * 宿主没有 `agents.create` / `agentPresets`（或建会话抛错）时，退回
   * `sessionController.create` + `prompt`，再退 `agents.createSession`：
   * 功能不因宿主版本而消失，只是会话回到「普通会话 + 宿主默认模型」。
   */
  private async openSession(
    workspaceDir: string,
    prompt: string,
    mode: 'draw' | 'ask',
  ): Promise<string | null> {
    const { ctx, config } = this.deps
    const allow = mode === 'ask' ? readonlyToolNames() : allowedToolNames()
    const presetId = mode === 'ask' ? config.askPresetId : config.presetId
    const model = await resolveModel(ctx, config)

    const subagent = await this.openSubagentSession(workspaceDir, presetId, model, allow, mode)
    if (subagent !== null) {
      deliver(this.deps, subagent.agent, prompt)
      return subagent.sessionId
    }

    const controller = serviceOf<SessionControllerLike>(ctx, 'sessionController')
    if (controller !== undefined) {
      const created = await controller.create({ cwd: workspaceDir, agentPreset: presetId })
      // 会话刚建好、还没开 turn：这时候收口工具面最干净
      this.tighten(created.sessionId, allow, mode)
      // 老路也能吃到设置里的模型：直接改这条会话下一步的路由，
      // 不走 `selectModel`（那个会把选择写成宿主的全局默认）。
      applyModel(agentOf(ctx, created.sessionId), model)
      if (typeof controller.prompt === 'function') {
        await controller.prompt(
          {
            requestId: newRequestId(),
            sessionId: created.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: prompt }],
          },
          new AbortController().signal,
        )
      }
      return created.sessionId
    }

    const agents = serviceOf<{
      createSession(request: {
        cwd: string
        agentPreset?: string
        reusable: (sessionId: string) => boolean
      }): Promise<{ agent: AgentLike }>
    }>(ctx, 'agents')
    if (agents === undefined) {
      throw new RunnerUnavailable(
        '宿主没有 sessionController 也没有 agents 服务，无法起 agent 会话',
      )
    }
    const created = await agents.createSession({
      cwd: workspaceDir,
      agentPreset: presetId,
      reusable: () => false,
    })
    const agent = created.agent
    this.tighten(agent.id ?? null, allow, mode)
    applyModel(agent, model)
    deliver(this.deps, agent, prompt)
    const sessionId = (agent as unknown as { id?: string }).id ?? null
    if (sessionId === null) throw new RunnerUnavailable('用 agents.createSession 起的会话没有 id')
    return sessionId
  }

  /**
   * 建一个子代理会话（`origin: 'subagent'`）。
   *
   * 返回 null 表示「这条路走不了」（宿主缺服务 / 没有可用模型 / 建会话失败），
   * 调用方退回普通会话。失败只记一条 warn：子代理是**增强**，不是功能前提。
   *
   * `model === null` 时必须放弃这条路：`agents.create` 不会去读
   * `agentDefaultModel`，建出来的会话第一步就抛
   * `has no provider/model`，而且异常被 agent-loop 吞进 `turn/end`，
   * 外面只能看到「没有产物」。普通会话那条路由 `sessionController` 注入
   * 默认模型，所以退回它至少能跑。
   */
  private async openSubagentSession(
    workspaceDir: string,
    presetId: string,
    model: ModelRef | null,
    allow: readonly string[],
    mode: 'draw' | 'ask',
  ): Promise<{ sessionId: string; agent: AgentLike } | null> {
    const { ctx } = this.deps
    const agents = serviceOf<AgentsLike>(ctx, 'agents')
    const presets = serviceOf<AgentPresetsLike>(ctx, 'agentPresets')
    if (agents?.create === undefined || presets === undefined) return null
    if (model === null) {
      this.warn('没有可用模型（插件设置与 DSH 默认都读不到）：退回普通会话')
      return null
    }

    try {
      const preset = await presets.resolve(presetId)
      const sessionId = `session-${randomUUID()}`
      const handle = await agents.create({
        sessionId,
        meta: {
          cwd: workspaceDir,
          agentPreset: preset.id,
          // 会话在 DSH 里算「子代理」：不占用户的对话列表
          origin: 'subagent',
          // 递归预算：本插件的分析不会再往下派子代理，固定 1 层
          delegationDepth: 1,
        },
        agentOptions: { ...model },
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, preset.id)
        },
      })
      const agent = handle.agent
      // 在 setup 之后、第一条 prompt 之前收口工具面：只影响这一条会话
      const warn = this.warn.bind(this)
      if (agent.ctx !== undefined) {
        if (mode === 'ask') tightenReadOnlyAgent(agent.ctx, warn)
        else tightenAgent(agent.ctx, allow, warn)
      } else {
        warn('子代理会话没有 agent 作用域：工具白名单未生效')
      }
      return { sessionId, agent }
    } catch (err) {
      this.warn(`建子代理会话失败，退回普通会话：${describeError(err)}`)
      return null
    }
  }

  /** 统一的 warn（日志器不可用不影响运行）。 */
  private warn(message: string): void {
    try {
      this.deps.ctx.logger.warn(`[dsh-archify-projects] ${message}`)
    } catch {
      // 日志器不可用不影响运行
    }
  }

  /** 对该会话的 agent 作用域装工具白名单与守卫。 */
  private tighten(sessionId: string | null, allow: readonly string[], mode: 'draw' | 'ask'): void {
    const { ctx } = this.deps
    const warn = (message: string): void => this.warn(message)
    if (sessionId === null) {
      warn('会话没有 id：跳过工具收口')
      return
    }
    const agent = agentOf(ctx, sessionId)
    if (agent?.ctx === undefined) {
      warn('拿不到 agent 作用域：工具白名单未生效（守卫同样未生效）')
      return
    }
    if (mode === 'ask') {
      tightenReadOnlyAgent(agent.ctx, warn)
      return
    }
    tightenAgent(agent.ctx, allow, warn)
  }

  /** 问答会话期间盯 todo，写到 qa 条目上，页面才能看到进度。 */
  private watchQaTodos(projectId: string, qaId: string, agent: AgentLike): () => void {
    const { ctx, store } = this.deps
    let stopped = false
    let last = ''
    const tick = async (): Promise<void> => {
      if (stopped) return
      const todos = todosOf(ctx, agent)
      if (todos === null) return
      const signature = todos.map((todo) => `${todo.status}:${todo.content}`).join('|')
      if (signature === last) return
      last = signature
      await store
        .patch(projectId, (current) => ({
          ...current,
          qa: current.qa.map((entry) => (entry.id === qaId ? { ...entry, todos } : entry)),
        }))
        .catch(() => undefined)
    }
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  /** 收尾一条提问：写回答、状态与用量，并把用量并进项目累计。 */
  private async finishQa(
    projectId: string,
    qaId: string,
    outcome: { answer: string; status: 'done' | 'failed'; usage: TokenUsage | null },
  ): Promise<QaEntry> {
    const { store } = this.deps
    const now = new Date().toISOString()
    let saved: QaEntry | undefined
    await store.patch(projectId, (current) => ({
      ...current,
      updatedAt: now,
      usageTotal: current.usageTotal + usageTotalOf(outcome.usage),
      qa: current.qa.map((entry) => {
        if (entry.id !== qaId) return entry
        saved = {
          ...entry,
          at: now,
          answer: outcome.answer,
          status: outcome.status,
          // 关会话之后不会再有「正在进行」：问答也一样收敛（done→完成，failed→退回）。
          todos: settleTodos(entry.todos, outcome.status === 'done' ? 'succeeded' : 'failed'),
          usage: outcome.usage,
        }
        return saved
      }),
    }))
    return (
      saved ?? {
        id: qaId,
        diagramId: '',
        question: '',
        answer: outcome.answer,
        at: now,
        applied: false,
        status: outcome.status,
        todos: [],
        usage: outcome.usage,
      }
    )
  }

  /**
   * 运行期间盯 todo：每 3 秒读一次 `todos` projection 写进台账。
   *
   * 页面靠这份快照显示「正在：<当前步骤>」；读不到（宿主没挂 projection 或 agent
   * 还没写 todo）就什么都不做，不制造假进度。
   *
   * 轮询之外还要一个 `flush()`：agent 判 idle 时最后一份 todo 往往比上一次轮询新，
   * 收尾前补读一次才不会把「最后一步」记成半截状态。
   */
  private watchTodos(
    projectId: string,
    runId: string,
    agent: AgentLike,
  ): { stop: () => void; flush: () => Promise<void> } {
    const { ctx, store } = this.deps
    let stopped = false
    let last = ''
    const tick = async (): Promise<void> => {
      const todos = todosOf(ctx, agent)
      if (todos === null) return
      const signature = todos.map((todo) => `${todo.status}:${todo.content}`).join('|')
      if (signature === last) return
      last = signature
      await store
        .patch(projectId, (current) => patchRunTodos(current, runId, todos))
        .catch(() => undefined)
    }
    void tick()
    const timer = setInterval(() => {
      if (stopped) return
      void tick()
    }, 3000)
    return {
      stop: () => {
        stopped = true
        clearInterval(timer)
      },
      // 收尾补读一次（不受 stopped 影响：先 flush 再 stop）。
      flush: async () => {
        await tick()
      },
    }
  }

  /** 后台等待结束并回收产物/概念。 */
  private follow(projectId: string, runId: string, diagramIds: readonly string[]): Promise<void> {
    const run = async (): Promise<void> => {
      const { ctx, store, config } = this.deps
      const project = await store.get(projectId)
      if (project === undefined) return
      const sessionId = project.lastRun?.sessionId ?? null
      if (sessionId === null) {
        await this.fail(projectId, runId, '会话没有 id，无法跟踪运行')
        return
      }
      const agent = agentOf(ctx, sessionId)
      const watch =
        agent === undefined
          ? { stop: () => {}, flush: async (): Promise<void> => {} }
          : this.watchTodos(projectId, runId, agent)
      try {
        if (agent === undefined) throw new RunnerUnavailable('会话已不在运行中，无法等待结果')
        await withTimeout(agent.whenIdle(), config.runTimeoutMs)
        // 补读最后一份 todo，`finishRun` 才好把它收敛成终态。
        await watch.flush()
        const text = readFinalText(agent)
        const markers = parseArtifactMarkers(text)
        const found = await this.collectArtifacts(projectId, markers, diagramIds)
        const concepts = await readConcepts(config, projectId)
        await this.succeed(projectId, runId, found, diagramIds, concepts, usageOf(ctx, agent))
      } catch (err) {
        await this.fail(
          projectId,
          runId,
          err instanceof Error ? err.message : String(err),
          usageOf(ctx, agent),
        )
      } finally {
        watch.stop()
      }
    }
    return run()
  }

  /** 回收产物：标记优先，找不到就扫 `.archify/` 最新目录。 */
  private async collectArtifacts(
    projectId: string,
    markers: Map<string, string>,
    diagramIds: readonly string[],
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    for (const id of diagramIds) {
      const marked = markers.get(id.toLowerCase()) ?? markers.get(legacyMarkerId(id).toLowerCase())
      if (marked !== undefined && (await isFile(marked))) {
        found.set(id, path.resolve(marked))
      }
    }
    if (found.size === diagramIds.length) return found

    const fallback = await discoverArtifacts(this.deps.config, projectId, diagramIds)
    for (const id of diagramIds) {
      if (found.has(id)) continue
      const candidate = fallback.get(id)
      if (candidate !== undefined) found.set(id, candidate)
    }
    return found
  }

  private async succeed(
    projectId: string,
    runId: string,
    found: Map<string, string>,
    diagramIds: readonly string[],
    concepts: readonly Concept[],
    usage: TokenUsage | null,
  ): Promise<void> {
    const { store, config } = this.deps
    const now = new Date().toISOString()
    const root = workspaceRoot(config)
    await store.patch(projectId, (current) => {
      let next: Project = { ...current, concepts: mergeConcepts(current.concepts, concepts) }
      for (const id of diagramIds) {
        const diagram = findDiagram(next, id)
        if (diagram === undefined) continue
        const html = found.get(id)
        const updated =
          html === undefined
            ? failedDiagram(diagram, '没有找到这次运行的产物文件')
            : readyDiagram(diagram, html, root, next, now)
        next = { ...next, ...replaceDiagram(next, diagram, updated) }
      }
      const lastRun = withUsage(
        finishRun(
          next,
          runId,
          now,
          found.size === diagramIds.length
            ? { status: 'succeeded', error: null }
            : { status: 'failed', error: '部分图谱没有产出' },
        ),
        usage,
      )
      return {
        ...next,
        updatedAt: now,
        usageTotal: next.usageTotal + usageTotalOf(usage),
        lastRun,
        runs: pushRun(next.runs, lastRun, config.keepRuns),
      }
    })
  }

  private async fail(
    projectId: string,
    runId: string,
    message: string,
    usage: TokenUsage | null = null,
  ): Promise<void> {
    const { store, config } = this.deps
    const now = new Date().toISOString()
    // 失败路径也要先看盘：agent 常常已经把自检通过的 HTML 落进 `.archify/`，
    // 报错只是「等不到最终回复」（会话被宿主机重启掐断、超时、连接断）。
    const salvaged = await discoverArtifacts(
      config,
      projectId,
      (await store.get(projectId))?.custom.map((d) => d.id) ?? [],
    ).catch(() => new Map<string, string>())
    const concepts = await readConcepts(config, projectId).catch(() => [])
    const root = workspaceRoot(config)
    await store.patch(projectId, (current) => {
      let next: Project = { ...current, concepts: mergeConcepts(current.concepts, concepts) }
      for (const diagram of allDiagrams(current)) {
        if (diagram.status !== 'running' && diagram.status !== 'queued') continue
        const html = salvaged.get(diagram.id) ?? salvaged.get(legacyMarkerId(diagram.id))
        next = {
          ...next,
          ...replaceDiagram(
            next,
            diagram,
            html === undefined
              ? failedDiagram(diagram, message)
              : readyDiagram(diagram, html, root, next, now),
          ),
        }
      }
      const lastRun = withUsage(
        finishRun(next, runId, now, { status: 'failed', error: message }),
        usage,
      )
      return {
        ...next,
        updatedAt: now,
        usageTotal: next.usageTotal + usageTotalOf(usage),
        lastRun,
        runs: pushRun(next.runs, lastRun, config.keepRuns),
      }
    })
  }
}

/** 正在跑时又点了一次。 */
export class RunnerBusy extends Error {
  readonly projectId: string

  constructor(projectId: string) {
    super('这个项目已有任务在运行，等它结束再试')
    this.name = 'RunnerBusy'
    this.projectId = projectId
  }
}

/** 宿主缺少必要的 agent 服务。 */
export class RunnerUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerUnavailable'
  }
}

/** 把一条运行写进历史（同 id 覆盖，否则追加），并裁剪到上限。 */
export function pushRun(
  runs: readonly RunRecord[],
  record: RunRecord,
  keep: number,
): readonly RunRecord[] {
  const withoutSame = runs.filter((run) => run.id !== record.id)
  const next = [...withoutSame, record]
  return next.length <= keep ? next : next.slice(next.length - keep)
}

/** 结束一条运行：补齐 status / finishedAt / error，其余字段沿用启动时的记录。 */
function finishRun(
  project: Project,
  runId: string,
  now: string,
  outcome: { status: 'succeeded' | 'failed'; error: string | null },
): RunRecord {
  const base = project.runs.find((run) => run.id === runId) ??
    project.lastRun ?? {
      id: runId,
      kind: 'create' as const,
      sessionId: null,
      startedAt: now,
      finishedAt: null,
      error: null,
      note: null,
      diagramIds: [],
      todos: [],
      usage: null,
    }
  return {
    ...base,
    status: outcome.status,
    finishedAt: now,
    error: outcome.error,
    // 运行一结束就收敛 todo：别让最后一步以 in_progress 留在台账里冒充「正在做」。
    todos: settleTodos(base.todos, outcome.status),
  }
}

function stampOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

function toPromptDiagram(diagram: DiagramState): PromptDiagram {
  return {
    id: diagram.id,
    kind: diagram.kind,
    title: diagram.title,
    prompt: diagram.prompt,
    persistence: diagram.persistence,
    conceptIds: diagram.conceptIds,
    renderer: diagram.renderer,
    pathScope: diagram.pathScope,
  }
}

function previousBranches(
  diagrams: readonly DiagramState[],
): Readonly<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (const diagram of diagrams) out[diagram.id] = diagram.branch
  return out
}

/** 旧版本标记（structure/domain）与默认图 id 是同一个，这里只是留个可读入口。 */
function legacyMarkerId(id: string): string {
  return id
}

function agentOf(ctx: HostContext, sessionId: string | null): AgentLike | undefined {
  if (sessionId === null) return undefined
  return serviceOf<{ get(id: string): AgentLike | undefined }>(ctx, 'agents')?.get(sessionId)
}

/** 把图替换回项目，同时保持 record/数组两条路径。 */
function replaceDiagram(
  project: Project,
  current: DiagramState,
  next: DiagramState,
): Partial<Project> {
  if ((DIAGRAM_KINDS as readonly string[]).includes(current.kind)) {
    return { diagrams: { ...project.diagrams, [current.kind as DiagramKind]: next } }
  }
  return { custom: project.custom.map((d) => (d.id === current.id ? next : d)) }
}

function markStatuses(
  project: Project,
  ids: readonly string[],
  status: DiagramState['status'],
): Partial<Project> {
  let next: Project = project
  for (const id of ids) {
    const diagram = findDiagram(next, id)
    if (diagram === undefined) continue
    next = { ...next, ...replaceDiagram(next, diagram, { ...diagram, status, error: null }) }
  }
  return { diagrams: next.diagrams, custom: next.custom }
}

/** 产物就绪：保留图的元信息，只换产物字段。 */
export function readyDiagram(
  diagram: DiagramState,
  htmlPath: string,
  root: string,
  project: Project,
  now: string,
): DiagramState {
  const specPath = path.join(path.dirname(htmlPath), 'candidate.json')
  return {
    ...diagram,
    status: 'ready',
    htmlPath: relativeTo(root, htmlPath),
    specPath: relativeTo(root, specPath),
    generatedAt: now,
    branch: project.git.branch,
    tree: project.git.tree,
    error: null,
  }
}

function failedDiagram(diagram: DiagramState, message: string): DiagramState {
  return {
    ...diagram,
    status: 'failed',
    htmlPath: null,
    specPath: null,
    generatedAt: null,
    branch: null,
    tree: null,
    error: message,
  }
}

/** 相对路径统一用 posix 分隔符，URL 拼接才稳。 */
function relativeTo(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile()
  } catch {
    return false
  }
}

/** 从 agent 会话里取最后一条 assistant 文本。 */
function readFinalText(agent: AgentLike): string {
  const session = agent.session as { deriveMessages?: () => unknown[] } | undefined
  if (session === undefined || typeof session.deriveMessages !== 'function') return ''
  let messages: unknown[]
  try {
    messages = session.deriveMessages()
  } catch {
    return ''
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown } | undefined
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const text = message.content
      .map((block) => {
        const b = block as { type?: unknown; text?: unknown }
        return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
      })
      .join('\n')
      .trim()
    if (text.length > 0) return text
  }
  return ''
}

/** 读 agent 写下的概念表（工作目录根的 concepts.json）。 */
export async function readConcepts(
  config: ResolvedConfig,
  projectId: string,
): Promise<readonly Concept[]> {
  const file = path.join(projectDir(config, projectId), 'concepts.json')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : ((parsed as { concepts?: unknown }).concepts ?? [])
  if (!Array.isArray(list)) return []
  const now = new Date().toISOString()
  const out: Concept[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : null
    const name = typeof raw.name === 'string' ? raw.name : null
    if (id === null || name === null) continue
    out.push({
      id,
      name,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      evidence: Array.isArray(raw.evidence)
        ? raw.evidence.filter((v): v is string => typeof v === 'string')
        : [],
      tags: Array.isArray(raw.tags)
        ? raw.tags.filter((v): v is string => typeof v === 'string')
        : [],
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    })
  }
  return out
}

/** 合并概念：同 id 覆盖，其余保留；按出现顺序去重。 */
export function mergeConcepts(
  existing: readonly Concept[],
  incoming: readonly Concept[],
): readonly Concept[] {
  if (incoming.length === 0) return existing
  const byId = new Map<string, Concept>()
  for (const concept of existing) byId.set(concept.id, concept)
  for (const concept of incoming) byId.set(concept.id, concept)
  return [...byId.values()]
}

/** 读一次 todos projection；没有服务或没写过 todo 时返回 null。 */
export function todosOf(ctx: HostContext, agent: AgentLike): readonly TodoItem[] | null {
  const session = agent.session
  if (session === undefined || session === null) return null
  const projections = serviceOf<SessionProjectionsLike>(ctx, 'sessionProjections')
  if (projections === undefined) return null
  let values: Readonly<Record<string, unknown>> | undefined
  try {
    values = projections.snapshot(session, ['todos']).values
  } catch {
    return null
  }
  const raw = values?.todos
  if (!Array.isArray(raw)) return null
  const out: TodoItem[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const value = item as { content?: unknown; status?: unknown }
    if (typeof value.content !== 'string' || value.content.length === 0) continue
    const status =
      value.status === 'in_progress' || value.status === 'completed' ? value.status : 'pending'
    out.push({ content: value.content, status })
  }
  return out
}

/** 读一次 tokenUsage projection；没有就返回 null。 */
export function usageOf(ctx: HostContext, agent: AgentLike | undefined): TokenUsage | null {
  if (agent === undefined) return null
  const session = agent.session
  if (session === undefined || session === null) return null
  const projections = serviceOf<SessionProjectionsLike>(ctx, 'sessionProjections')
  if (projections === undefined) return null
  let values: Readonly<Record<string, unknown>> | undefined
  try {
    values = projections.snapshot(session, ['tokenUsage']).values
  } catch {
    return null
  }
  const raw = values?.tokenUsage
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const num = (key: string): number => {
    const n = Number(source[key])
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const usage: TokenUsage = {
    uncachedInput: num('uncachedInputTokens'),
    output: num('outputTokens'),
    cacheRead: num('cacheReadTokens'),
    cacheWrite: num('cacheWriteTokens'),
  }
  // 全 0 = 这次调用没真正发生（比如首轮就报错），别记成一条「用量 0」
  return usageTotalOf(usage) === 0 ? null : usage
}

/** 把 todo 写进某条运行记录（lastRun 与 runs[] 同步改）。 */
export function patchRunTodos(
  project: Project,
  runId: string,
  todos: readonly TodoItem[],
): Project {
  const stamp = (run: RunRecord): RunRecord => (run.id === runId ? { ...run, todos } : run)
  return {
    ...project,
    lastRun: project.lastRun === null ? null : stamp(project.lastRun),
    runs: project.runs.map(stamp),
  }
}

/** 给运行记录补上用量。 */
function withUsage(run: RunRecord, usage: TokenUsage | null): RunRecord {
  return { ...run, usage }
}

/** 读这张图的 candidate.json（截断），给问答会话当上下文。 */
async function readCandidate(
  config: ResolvedConfig,
  project: Project,
  diagram: DiagramState,
): Promise<string | null> {
  void project
  if (diagram.specPath === null) return null
  const file = path.join(workspaceRoot(config), diagram.specPath)
  try {
    const text = await readFile(file, 'utf8')
    return text.length > 6000 ? `${text.slice(0, 6000)}\n…（已截断）` : text
  } catch {
    return null
  }
}

/**
 * 开库对账。宿主每次启动跑一次，做两件事：
 *
 * 1. **认领磁盘上的产物**：记录说不 ready、`.archify/` 下却已经有自检通过的 html
 *    （agent 跑到一半宿主被重启 / 页面被关的典型现场），把它认回来当 ready。
 * 2. **收尸悬挂的运行**：上一次运行的 `running` 会原样留在台账里（进程被 kill 时
 *    没有机会写 finishedAt）。不收拾就会永远「生成中」，按钮全禁用，用户只能手改 JSON。
 */
export async function reconcileArtifacts(
  store: ProjectStore,
  config: ResolvedConfig,
): Promise<string[]> {
  const adopted: string[] = []
  const root = workspaceRoot(config)
  let projects: readonly Project[] = []
  try {
    projects = await store.list()
  } catch {
    return adopted
  }
  for (const project of projects) {
    const diagrams = allDiagrams(project)
    const strayRuns = project.runs.filter((run) => run.status === 'running')
    const missing = diagrams.filter((diagram) => diagram.status !== 'ready')
    if (missing.length === 0 && strayRuns.length === 0) continue

    const found = await discoverArtifacts(
      config,
      project.id,
      diagrams.map((d) => d.id),
    ).catch(() => new Map<string, string>())
    const strayDiagrams = diagrams.filter(
      (diagram) => diagram.status === 'queued' || diagram.status === 'running',
    )
    if (found.size === 0 && strayRuns.length === 0 && strayDiagrams.length === 0) continue

    const now = new Date().toISOString()
    await store.patch(project.id, (current) => {
      let next: Project = current
      for (const diagram of allDiagrams(current)) {
        const html = found.get(diagram.id)
        if (html !== undefined) {
          next = {
            ...next,
            ...replaceDiagram(next, diagram, readyDiagram(diagram, html, root, next, now)),
          }
          continue
        }
        if (diagram.status !== 'queued' && diagram.status !== 'running') continue
        next = {
          ...next,
          ...replaceDiagram(
            next,
            diagram,
            failedDiagram(diagram, '上一次运行随宿主退出而中断，点「重新生成」重跑'),
          ),
        }
      }

      const runs = current.runs.map((run) =>
        run.status === 'running'
          ? { ...run, status: 'failed' as const, finishedAt: now, error: '宿主重启，本次运行中断' }
          : run,
      )
      const lastRun =
        current.lastRun !== null && current.lastRun.status === 'running'
          ? {
              ...current.lastRun,
              status: 'failed' as const,
              finishedAt: now,
              error: '宿主重启，本次运行中断',
            }
          : current.lastRun

      return { ...next, updatedAt: now, runs, lastRun }
    })

    if (found.size > 0) adopted.push(`${project.name}: 认领 ${found.size} 张图`)
    if (strayRuns.length > 0) adopted.push(`${project.name}: 收尸 ${strayRuns.length} 条悬挂运行`)
  }
  return adopted
}

/**
 * 目录兜底：扫 `<项目目录>/.archify/` 下的子目录，按目录名里的图 id / 旧 kind 关键词归类。
 *
 * 只在标记缺失时用。目录名必须以图 id 开头（prompt 里约定的），否则按旧版
 * `structure-` / `domain-` 前缀兜底。
 */
export async function discoverArtifacts(
  config: ResolvedConfig,
  projectId: string,
  diagramIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const archifyRoot = path.join(projectDir(config, projectId), '.archify')
  let dirs: string[]
  try {
    dirs = await readdir(archifyRoot, { withFileTypes: true }).then((entries) =>
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse(),
    )
  } catch {
    return result
  }

  for (const dir of dirs) {
    const id = diagramIdOfDirName(dir, diagramIds)
    if (id === null || result.has(id)) continue
    const html = await firstHtmlIn(path.join(archifyRoot, dir))
    if (html !== null) result.set(id, html)
  }
  return result
}

function diagramIdOfDirName(dir: string, diagramIds: readonly string[]): string | null {
  const lower = dir.toLowerCase()
  for (const id of diagramIds) {
    if (lower.startsWith(`${id.toLowerCase()}-`)) return id
  }
  if (lower.startsWith('domain')) return 'domain'
  if (lower.startsWith('structure') || lower.startsWith('architecture')) return 'structure'
  return null
}

async function firstHtmlIn(dir: string): Promise<string | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const html = entries.find((e) => e.isFile() && e.name.endsWith('.html'))
    return html === undefined ? null : path.join(dir, html.name)
  } catch {
    return null
  }
}

/** 宿主能不能自己建「子代理会话」（设置页据此显示会话形态）。 */
export function canCreateSubagentSessions(ctx: HostContext): boolean {
  const agents = serviceOf<AgentsLike>(ctx, 'agents')
  const presets = serviceOf<AgentPresetsLike>(ctx, 'agentPresets')
  if (agents?.create === undefined || presets === undefined) return false
  return typeof presets.mount === 'function' && typeof presets.resolve === 'function'
}

/** 读设置里选的模型；读不到（文件缺失/损坏）就是「没选」。 */
async function selectedModel(config: ResolvedConfig): Promise<ModelRef | null> {
  try {
    const settings = await readSettings(config)
    return settings.model
  } catch {
    return null
  }
}

/**
 * 这次分析用哪个模型。**顺序即优先级**：
 *
 *   1. 插件设置里显式选的（用户在设置弹窗挑过）；
 *   2. DSH 里配的默认模型（`ctx.agentDefaultModel.currentSelection()`）——
 *      这是「跟随宿主默认」的真正实现：子代理会话不经过 `sessionController`
 *      的注入，必须自己补上，否则会话第一轮就因为没有 provider/model 被判死；
 *   3. 宿主模型目录的 `default` 字段（老宿主没有 agentDefaultModel 时的退路）；
 *   4. 都没有 → `null`，调用方退回 `sessionController`（它自己会注入默认模型）。
 */
async function resolveModel(ctx: HostContext, config: ResolvedConfig): Promise<ModelRef | null> {
  const chosen = await selectedModel(config)
  if (chosen !== null) return chosen

  const defaults = serviceOf<AgentDefaultModelLike>(ctx, 'agentDefaultModel')
  if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
    try {
      const ref = readModelRef(defaults.currentSelection())
      if (ref !== null) return ref
    } catch {
      // 宿主版本没有这个面：继续往下退
    }
  }

  try {
    const catalog = await readModelCatalog(ctx)
    if (catalog.fallback !== null) return catalog.fallback
  } catch {
    // 目录列不出来不影响：退到第 4 步
  }
  return null
}

/**
 * 把模型应用到一条**已经建好**的会话上。
 *
 * 走 `agent.model.select()`：它只改这条会话下一步的路由，不会像
 * `sessionController.selectModel()` 那样把选择存成宿主的全局默认。
 */
function applyModel(agent: AgentLike | undefined, model: ModelRef | null): void {
  if (model === null || agent === undefined) return
  const selection = agent.model as AgentModelLike | undefined
  if (selection === undefined) return
  try {
    selection.select({ ...model })
  } catch {
    // 宿主版本没有这个面：会话就用它自己的默认模型，不影响出图
  }
}

/** 投一条用户消息（`followup` 会把消息排成独立的一轮并唤醒驱动）。 */
function deliver(deps: RunnerDeps, agent: AgentLike, prompt: string): void {
  try {
    agent.followup({
      id: newRequestId(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })
  } catch (err) {
    deps.ctx.logger?.warn?.(`[dsh-archify-projects] 投递提示词失败：${describeError(err)}`)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 超时包装。 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`等待 agent 结束超时（${ms} ms）`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/** 供测试使用：把树状态签名摆出来，别在测试里手抄格式。 */
export function treeOf(tree: TreeState | null): string {
  return tree === null ? 'none' : `${tree.staged}:${tree.unstaged}:${tree.untracked}`
}
