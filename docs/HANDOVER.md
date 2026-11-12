# 交接文档 · dsh-archify-projects

> 面向接手的 agent。读完这一份就能改代码、跑验证、装/卸插件、看懂当初为什么这么写。
> 面向使用者的上手说明在 [README](../README.md)，设计取舍在 [DESIGN.md](./DESIGN.md)。

最后更新：2026-11-11（v0.2.1：装机后两个展示问题的修复，见 §14）

---

## 0. 一句话

DSH 的左栏插件「架构建模」：把一个代码库登记进台账，用**受限 agent**（skill 只有 archify）
生成**项目结构图**和**领域图**两张可交互 HTML，支持按 Git 分支/commit 更新，页面内嵌 iframe 直接看。

宿主侧 Node 代码 + 浏览器侧单 bundle，不是静态插件：台账落盘、Git 探测、agent 编排、产物回收、
路由与鉴权全在进程里跑。

---

## 1. 现在什么状态

| 方面   | 状态                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 功能   | 新增/删除项目、Git 探测（分支/commit/上游/脏）、首次生成、更新（切分支+快进+重跑）、重新生成单图、运行记录、深/浅色、非 Git 目录、iframe 内嵌预览、新窗口打开 |
| 测试   | 213 个用例 / 15 个文件，`vitest` 全绿（约 1 s；`NODE_ENV` 不能是 production，见 §13.5）                                                                       |
| 静态门 | `tsc`（两份 tsconfig）、`eslint`、`prettier --check`、`dependency-cruiser`、`artifact:check`（51.5 KB / 220 KB 预算）全绿                                     |
| 真机   | 在 `127.0.0.1:3080` 的真实宿主里跑通过「Git 项目」与「非 Git 目录」两条路径，深浅色都验过；截图见 [`docs/verify/`](./verify)                                  |
| 产物   | `~/.dsh/dsh-archify-projects/` 下 1 个项目（`dsh-word-learn`），两张图 ready                                                                                  |
| 版本库 | 本地 `git init` 完成，**还没有远端仓库**（见 §9）                                                                                                             |

**没有半成品功能**。已知未做的都在 §8，属于可选增强，不是缺陷。

> **截图配方**（`docs/verify/shot-*.png`，README 与市场都用它们）：按 **1440×900** 渲染，
> 再 Lanczos 缩到 **1280×800**——现存四张图的侧栏右边界在 x=247、侧栏行距 34px，直接
> 1280×800 截会大 1.12 倍，四张放一起看得出不是一套。改了任何影响成图画面的渲染（例如
> `hideArtifactHeader()` 去掉成品页头），**覆盖它的每一张都要重截**，别只重截手上那张。
> 市场详情页的截图画廊读仓库根 `screenshots.json`（见 [`docs/market/README.md`](./market/README.md)），
> 不从条目 YAML 来，也不从 README 抽。

---

## 2. 五分钟跑起来

```bash
cd ~/Projects/dsh-archify-projects    # Windows 检出在 D:/projects/blog/dsh-plugins/dsh-archify-projects
pnpm install
pnpm verify        # build → artifact:check → typecheck/lint/format/deps → test
```

> **在 Linux 上开发／验证，优先用容器**：`~/Projects/dsh-docker` 的 `dsh-dev`
> （`127.0.0.1:3080`）已经把本仓库挂成 profile 的 bundle，改源码不用碰宿主 `~/.dsh`。
> 绑定关系、日常循环、模型凭据、冒烟步骤都写在 [CONTAINER.md](./CONTAINER.md)。
> 下面这段是「装进本机 DSH」的通用流程，容器已经替你做过。

装进 DSH（已在 `~/.dsh/profiles/web` 里做好，`link:` 形式）：

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "dsh-archify-projects": "link:/home/xirizhi/Projects/dsh-archify-projects" },
"dsh": { "profile": { "bundles": [ /* ... 其它 ... */, "dsh-archify-projects" ] } }
```

**改了哪一层，决定要不要重启**：

| 改动位置                                                      | 生效方式                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/client/**`、`dist/`、`locale/`                           | 热更（`dsh-client-hmr` 轮询重建产物，约 0.5 s 后 remount），刷新页面即可 |
| `src/host/**`、`cordis.patch.yml`、`package.json` 的 `dsh` 段 | **必须重启 dsh**（ESM 模块缓存按进程存活）                               |
| `skills/archify/**`                                           | 下次新建 agent 会话时生效，不用重启                                      |

重启方式：双击桌面 **`DSH启动.bat`**（它是「停旧 + 起新」的一体入口，内部走 `~/dsh-tools/dsh-web.ps1`）。
`~/.dsh/logs/latest-web-url.txt` 会存带 `?token=` 的登录链接——**每次重启 token 都会变**，旧标签页会提示
`dsh web authentication required`，重开这个 URL 即可。

> ⚠️ 用 WMI/计划任务自动拉起 dsh 试过两次，都只成功到「停掉旧进程」，「起新的」这一步不落地
> （桌面 bat 依赖交互式窗口）。自动重启脚本见 `~/Documents/deepseek-harness/default-workspace/restart-helper.ps1`，
> 它能把带 token 的 URL 抓进 `latest-web-url.txt`，但**起服务仍建议人工点 bat 确认**。

---

## 3. 架构：一次「更新」发生了什么

```
页面按钮
  └─ POST /dsh-archify-projects/projects/:id/update          src/host/routes.ts
       ├─ git.ts        切回记录的分支 → fetch → FF 到最新 → 重新探测快照
       ├─ store.ts      台账里记一条 run(running)，两张图置 queued
       └─ runner.ts     起受限会话（v0.2：子代理会话，见 §13）
            ├─ agents.create({ meta.origin:'subagent', agentOptions:{provider,model},
            │                  setup: agentPresets.mount(preset) })  ← 旧路：sessionController.create
            ├─ policy.ts   agent.ctx 上装 tools.restrict(allow) + tools.guard(fn)
            ├─ prompt.ts   拼 prompt（代码库路径、分支/commit、上次产物、产物标记约定）
            ├─ 投 prompt → whenIdle（或 runTimeoutMs 超时）
            ├─ 收尾：读 assistant 文本里的产物标记 → 否则扫 <项目目录>/.archify/ 兜底
            └─ store.patch   两张图 ready/failed + 运行记录收尾
  └─ 页面每 2 s 轮询 GET /projects，看到 ready 就把 iframe src 换成产物 URL
```

产物一律写在**插件自己的工作区**，不污染代码库：

```
~/.dsh/dsh-archify-projects/
├── projects.json                     台账（唯一真相）
└── workspace/<projectId>/
    └── .archify/<kind>-<slug>-<stamp>/   candidate.json + 成品 *.html + finalize-summary.json
```

台账不变量（改代码时别破坏）：

1. `diagrams[kind].status ∈ {idle, queued, running, ready, failed}`；`ready` 必须有 `htmlPath`。
2. 任何时刻最多一条 `runs[]` 是 `running`；宿主启动时由 `reconcileArtifacts()` 收尸。
3. 产物路径一律**相对** `workspaceRoot`，路由按它拼 URL 并做越界校验（`..` 直接 403）。
4. 删除项目要连工作区目录一起删；台账是唯一索引，磁盘上没有台账之外的有效产物。

---

## 4. HTTP 契约（前缀 `/dsh-archify-projects`）

| 方法   | 路径                          | 用途                                                         |
| ------ | ----------------------------- | ------------------------------------------------------------ |
| GET    | `/health`                     | 存活 + `presetId` / 版本，排查「插件到底挂上没」             |
| GET    | `/projects`                   | 台账全量（页面轮询这个）                                     |
| POST   | `/projects`                   | 新增项目（`{ repoPath, name? }`，自动探测 Git 并起首次生成） |
| GET    | `/projects/:id`               | 单项目                                                       |
| PATCH  | `/projects/:id`               | 改名字等                                                     |
| DELETE | `/projects/:id`               | 删项目 + 工作区                                              |
| POST   | `/projects/:id/check`         | 重探 Git                                                     |
| POST   | `/projects/:id/update`        | 更新（切分支 + 快进 + 重跑两张图）                           |
| POST   | `/projects/:id/diagram/:kind` | 重新生成单张图（`structure` / `domain`）                     |
| GET    | `/projects/:id/runs`          | 运行记录                                                     |
| GET    | `/artifact/<相对路径>`        | 产物 HTML（iframe 与「新窗口打开」都走这里）                 |

错误统一 `{ code, message }`，`code ∈ {bad-request, forbidden, not-found, conflict, internal, path-invalid, …}`
（见 `src/shared/protocol.ts`）。**页面按 code 决定文案，不解析 message**，别在文案里做逻辑。

### 鉴权：curl 拿 403 是正常的

路由挂在宿主 webServer 上，前面有宿主的浏览器信任栅栏 `connection.requestRejection(req)`：

- 命令行 `curl` → **403**（untrusted authority）；
- 同源页面里的 `fetch` → 200。

所以「用 curl 验证接口」永远 403，不是 bug，也不是路由没注册。判断路由在不在看 `/health`：
403 说明**路由存在但被栅栏拦了**，404 才是真没挂上。

---

## 5. agent 只能用 archify，无关工具进不来（三层）

| 层       | 机制                                                                                                                                                       | 效果                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| preset   | `cordis.patch.yml` 里两个私有 preset：出图 `archify-projects`（fs / fs-search / shell / skill）、问答 `archify-projects-ask`（**fs / fs-search / skill**） | 工具面天生就这么大                               |
| skill 源 | preset 私有的 `dsh-skill-filesystem`：`includeDefaultRoots: false` + `bundledSkillDir` 指向 `skills/`                                                      | agent 的 skill 列表里只有 `archify`              |
| 运行期   | `policy.ts`：`tools.restrict({ allow })` + `tools.guard(fn)`                                                                                               | 即使在名单外被调用也被拒；`skill` 只认 `archify` |

两种会话，白名单不同：

| 会话        | 工具面                                              | 用途                                       |
| ----------- | --------------------------------------------------- | ------------------------------------------ |
| 出图（run） | `read, write, edit, glob, grep, skill` + 平台 shell | 读代码、写产物、跑 archify finalize        |
| 提问（ask） | **只有 `read, glob, grep, skill`**                  | 回答对图的细节提问；没有 shell、没有写工具 |

联网、子 agent、workflow、todo 这些工具**压根不可见**，调用即 `UNKNOWN_TOOL`。
两类会话的 `skill` 都只认 `archify`。

`tools.restrict` 必须装在 `agent.ctx` 上（根 ctx 直接抛 `requires a scoped context`），
所以它写在 `runner.ts` 建会话之后、第一条 prompt 之前，只影响本插件起的会话。

**archify skill 是 vendored 的**（`skills/archify/`，约 7.3 MB，来自
`@tt-a1i/archify-dsh@1.0.0` 的 tarball）。曾经指向 profile 里的那个包，结果用户一卸载原插件，
建会话就 `Cannot find module '@tt-a1i/archify-dsh/package.json'`，图一张都出不来。
现在靠 `createRequire(baseUrl).resolve('dsh-archify-projects/package.json')` 定位自己，自足。
（因此 `package.json` 的 `exports` 里必须有 `"./package.json": "./package.json"`，别删。）

---

## 6. 前端

- 单 bundle：`tsdown` 把 `src/client/**` 打成 `dist/client.js`（外部化 react），预算 220 KB。
- 主题：**只用宿主 token**（`--dsw-alias-*`），深浅色自动跟随，禁止硬编码颜色。
- 结构：`page.tsx`（状态与轮询）/ `components.tsx`（展示）/ `styles.ts`（一把 CSS）/ `locale.ts`（中英文案）/ `api.ts`（fetch 封装）。
- iframe：`sandbox="allow-scripts allow-same-origin"`，高度 `clamp(420px, 58vh, 760px)`。

三个真机才暴露的坑，改前端前先读：

1. **卡片和 iframe 都要 `flex:none`**。父链是 `dap-page(flex) → dap-body(grid) → dap-col(flex, overflow:auto) → dap-card(flex column)`；
   只锁 iframe，卡片本身仍会被压成 ~90 px，再用 `overflow:hidden` 把图裁成一条工具栏。
2. **时钟按本地时区格式化**（`clockText()`）。早期 `startedAt.slice(11,19)` 切的是 UTC，东八区显示成 05:51。
3. **`isRunning()` 有 25 分钟兜底**（`isRunAlive` / `hasStaleRun`）。宿主被 kill 时 `running` 会留在台账里，
   没有兜底页面就永久「生成中」且按钮全禁用。
4. **宿主没有全局 `box-sizing: border-box`**（`dsh-web-frontend` 里逐条写，没有 `*` 重置）。
   自己写 `width:100% + padding` 的卡片会**比栅格列宽出 30px**：卡片本身压到隔壁、
   里面那行「横线」跟着越界。`.dap-card` / `.dap-thumb` 都显式写了 `box-sizing: border-box`，别删；
   图条用 `repeat(auto-fit, minmax(165px, 1fr))` 而不是 `1fr 1fr`（后者会被子项 min-content 撑开）。

---

## 7. 质量门与怎么加测试

```bash
pnpm typecheck      # tsc --noEmit + tsc -p tsconfig.host.json
pnpm lint           # eslint（skills/ 已排除）
pnpm format:check   # prettier（skills/、lib、dist、coverage 已排除）
pnpm deps:check     # dependency-cruiser：禁环、禁 client→host 反向依赖
pnpm test           # vitest + coverage
pnpm artifact:check # dist/client.js 体积与外部化
pnpm verify         # 以上全部 + build
```

当前基线：**174 passed / 12 files**，`coverage` 目录不进版本库。

测试布局（改哪儿补哪儿）：

| 目录                               | 覆盖                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| `tests/unit/shared.test.ts`        | 纯函数：格式化、`isRunning`/`isStale`、prompt 拼接、产物标记解析 |
| `tests/unit/runner.test.ts`        | 产物发现、运行历史、超时、**开库收尸**（`reconcileArtifacts`）   |
| `tests/unit/routes.test.ts`        | 路由表：正常路径 + 400/403/404 + 越界路径                        |
| `tests/unit/git.test.ts`           | Git 探测：非仓库、分离头、无上游、脏工作区                       |
| `tests/unit/store.test.ts`         | 台账读写、串行化、损坏文件兜底                                   |
| `tests/unit/policy.test.ts`        | 白名单与守卫（非 archify skill 必须被拒）                        |
| `tests/unit/components.test.ts`    | 客户端纯函数（`clockText`）                                      |
| `tests/contract/locale.test.ts`    | 中英文案 key 对齐（漏 key 会真机显示英文）                       |
| `tests/integration/runner.test.ts` | 桩 ctx 走通一次 run（含 preset 限制调用断言）                    |

一条硬规矩：**修 bug 先写会红的用例**。上面三个真机坑里，坑 2、坑 3 都已经钉进单测。

---

## 8. 已知问题与可选增强（都非阻塞）

1. **并发**：一次点击只能跑一个项目；`update` 正在跑时再点会被拒（返回 `conflict`）。多项目排队没有做。
2. **运行收尸的边界**：`reconcileArtifacts` 只在**宿主启动**时跑。如果进程活着但 agent 卡死（没超时也没结束），
   前端只能靠 25 分钟兜底解锁，台账里的 `running` 仍要等下次启动才被清。
3. **`archify` 产物目录名靠猜**：`discoverArtifacts` 按目录名前缀（`structure-` / `architecture-` / `domain-`）
   归类，没有就按「新目录优先」补位。archify 换命名就要改 `kindOfDirName()`。
4. **没有远端仓库**：`git init` 已做，`origin` 未建（见 §9）。
5. **没有 i18n 之外的 l10n**：目前只有 zh-CN / en 两份文案。
6. **`skills/archify` 升级**：覆盖目录即可（`npm pack @tt-a1i/archify-dsh` 解包），无需改代码；
   依赖它的只有 `archify-skill.ts` 的路径探测与 prompt 里约定的产物标记。

---

## 9. 版本库

公开仓库已就绪：<https://github.com/guicaiyue/dsh-archify-projects>（`main`，168 个文件）。

```bash
cd D:/projects/blog/dsh-plugins/dsh-archify-projects
git remote -v            # origin git@github.com:guicaiyue/dsh-archify-projects.git
git push                 # 已 set-upstream，直接推
```

提交习惯：一个功能/一次修复一个 commit，中文 subject（`feat:` / `fix:` / `docs:`），
正文写清「为什么这么改」，别写「update file」。

> 建仓库这一步 agent 做不了：本机只有 SSH key（能推不能建），没有 `gh` CLI、没有 PAT、
> `git credential` 里也没有存货。远端仓库必须先由账号持有人在 GitHub 上建好。
> `.gitignore` 忽略 `node_modules/ lib/ dist/ coverage/`；`skills/archify/` 是**刻意提交**的，
> 不跟着仓库走克隆下来就跑不起来。

---

## 10. 文件索引（改东西先看这里）

| 文件                        | 行数   | 职责 / 什么时候动它                                                                                           |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `src/host/index.ts`         | 114    | 插件入口：注册路由（`ctx.inject(['webServer'], …)`）、启动对账、装卡片。**改挂载方式看这里**                  |
| `src/host/routes.ts`        | 457    | 路由分发与每个 handler。加接口从这里加，路径表在 `shared/protocol.ts`                                         |
| `src/host/runner.ts`        | 633    | agent 编排、产物回收（`discoverArtifacts`）、超时、开库对账（`reconcileArtifacts`）。**最复杂的一个文件**     |
| `src/host/store.ts`         | 232    | 台账读写、串行化、损坏兜底                                                                                    |
| `src/host/git.ts`           | 210    | Git 探测、切分支/快进。非 Git 目录走空快照                                                                    |
| `src/host/policy.ts`        | 135    | 工具白名单 + 守卫。放宽/收紧 agent 能力只改这里                                                               |
| `src/host/config.ts`        | 158    | 配置项与默认值（`dataDir` / `presetId` / `archifySkillDir` / `outputLanguage` / `runTimeoutMs` / `keepRuns`） |
| `src/host/context.ts`       | 211    | 宿主服务的**防御式**包装。`ctx.get()` 与 `ctx.<svc>` 都可能抛，必须 try/catch                                 |
| `src/host/http.ts`          | 195    | 响应封装 + 浏览器信任栅栏                                                                                     |
| `src/host/workspace.ts`     | 85     | 工作区目录与 agent 工作目录                                                                                   |
| `src/host/archify-skill.ts` | 123    | 定位 archify skill（vendored 优先，其次配置项）                                                               |
| `src/shared/*.ts`           | 1223   | 纯逻辑：类型与不变量、prompt、协议/路由常量、格式化。**无副作用，随便测**                                     |
| `src/client/*`              | 1570   | 页面、组件、样式、文案、fetch                                                                                 |
| `cordis.patch.yml`          | 57     | 挂插件 + 声明受限 preset。**改 preset 要重启**                                                                |
| `docs/DESIGN.md`            | 498    | 设计取舍、数据模型、里程碑与验证记录                                                                          |
| `docs/CONTAINER.md`         | —      | dsh-dev 容器里的绑定关系、日常循环、模型凭据与冒烟步骤                                                        |
| `skills/archify/`           | 7.3 MB | vendored 的 archify skill（第三方，勿手改）                                                                   |

---

## 11. 接手第一步建议

1. `pnpm install && pnpm verify` —— 先确认基线是绿的。
2. 打开 `http://127.0.0.1:3080/`（token 见 `~/.dsh/logs/latest-web-url.txt`），点左栏「架构建模」，
   对 `dsh-word-learn` 点一次「重新生成」——用一张图确认「路由 → 会话 → 产物 → iframe」整条链在你手里是通的。
3. 读 `docs/DESIGN.md` 的 §3（数据模型）/ §5.4（runner）/ §7（前端）。
4. 想改行为，先在 `tests/unit/` 里写一条会红的用例再动手。

---

## 12. v0.3 变更：从「两张图」到「图册」

> 本节描述当前（2026-11-08）的模型；§1–§11 里仍按 v0.1 写的口径以本节为准。

### 12.1 版本口径

- **分支级，不是 commit 级**：`DiagramState` 记录 `branch` + `tree`（暂存/未暂存/未跟踪计数），
  `isStale` 只看「分支变了 / 工作区变了」，不看新 commit。
- `git status --porcelain` 由 `parseTree()` 解析成三个计数（`src/host/git.ts`）；
  **暂存区内容也算代码证据**，提示词里明确写「以工作区当前内容为准」。

### 12.2 数据模型（`src/shared/types.ts`，`LEDGER_VERSION = 2`）

```ts
Project {
  git: GitSnapshot            // + tree: { staged, unstaged, untracked }
  diagrams: { structure, domain }   // 默认两张，id 固定为 structure / domain
  custom: DiagramState[]      // 任意自定义图，id = dgm_xxx
  concepts: Concept[]         // 项目级概念表（id/name/summary/evidence/tags）
  qa: QaEntry[]               // 对图的提问记录（diagramId/question/answer/applied）
  runs / lastRun              // + diagramIds
}
DiagramState {
  id, kind: structure|domain|custom, title, prompt,
  persistence: permanent|temporary, parentId, setId, conceptIds,
  status, htmlPath, specPath, generatedAt, branch, tree, error
}
```

- `permanent`：prompt 存台账，`更新图册` 时自动用同一 prompt 重画；
- `temporary`：只跑这一次，`更新图册` 时不选它（产物仍可看）；
- `parentId` 构成父子图；`setId` 相同 = 一套图（大图 + 细节小图）；
- 概念是项目级，图只引用 `conceptIds` 子集。

迁移在 `store.normalize`：v1 的 `diagrams.structure/domain` 对象直接读成两张永久图，
其余字段（prompt/parent/set/concepts）补默认值；旧台账不需要手工改。

### 12.3 接口新增

| 方法         | 路径                                           | 用途                                                                          |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| POST         | `/projects/:id/diagrams`                       | 新建自定义图（`{title, prompt, persistence?, parentId?, conceptIds?, run?}`） |
| PATCH/DELETE | `/projects/:id/diagrams/:diagramId`            | 改标题/prompt/时效/概念；删图（连带子图与 qa）                                |
| POST         | `/projects/:id/diagrams/:diagramId/regenerate` | 重画单张（默认图与自定义图同一入口）                                          |
| POST         | `/projects/:id/diagrams/:diagramId/ask`        | 只读提问，回答落 `qa[]`                                                       |
| POST         | `/projects/:id/qa/:qaId/merge`                 | 把回答并进图（prompt 追加「用户追问补充」后重画）                             |
| POST         | `/projects/:id/qa/:qaId/child`                 | 以回答为 prompt 建子图                                                        |

`/projects/:id/diagram/:kind` 保留为兼容入口。

### 12.4 提示词与上下文（`src/shared/prompt.ts`）

- `buildRunPrompt`：环境事实（分支 + 工作区计数）→ 概念表契约（写 `concepts.json`）→
  每张图的建模口径/自定义 prompt → archify 调用方式（目录名以图 id 开头）→
  **产物语言**（`outputLanguage` 非空时；见 `src/shared/language.ts`）→
  `ARCHIFY_ARTIFACT <id> <path>` 回报标记。
- `buildAskPrompt`：只给「这张图的 prompt + candidate.json 截断 + 绑定的概念及证据文件 +
  代码库根目录」，要求先结论后依据、查不到就说没有、最后给「建议补进图里的节点/关系」；
  `outputLanguage` 非空时再加一段「回答语言」。
- 语言只能靠提示词约束：渲染器的 `meta.locale` 只本地化图例/工具栏，节点文字在
  `candidate.json` 里由 agent 写。
- 问答会话的工具面由 `policy.readonlyToolNames()` 收口为 `read/glob/grep/skill`。

### 12.5 页面

三栏工作台（`src/client/page.tsx`）：左「图册树」（默认套图 / 自定义 / 子图 / 概念索引）、
中「查看器」（iframe + 子图缩略条）、右「检查器」（图信息 / 提问）。
总览是项目卡片墙（分支、工作区计数、概念数、过期提示）。样式仍只用 DSH token，
单 bundle 81.6 KB（预算 220 KB）。

### 12.6 v0.5/v0.6 增量（2026-11-08）

**新建图弹窗的图型 tag**（`docs/DESIGN.md` §15）：

- `DiagramState` 增 `renderer: ArchifyType | null` 与 `pathScope: string[]`；
  `ArchifyType` = archify 的 5 个真实 type（architecture / workflow / sequence / dataflow / lifecycle）。
- 默认两张图 `renderer` 固定 `architecture`（老台账迁移时补这个默认值）；自定义图不选即 `null`，
  提示词写「由你按 prompt 自行选择」。
- `pathScope` 只接受仓库内相对路径：绝对路径、`..`、反斜杠一律丢弃（`sanitizeScope`）。
- 提示词：选了 renderer 写死「必须使用 \`<type>\`」；有 pathScope 写「只看这些目录」。

**进度（todo）**：

- 两个 preset 都挂 `dsh-tool-todo`（`allowParallelInProgress: false`）；
- ⚠️ **`todo_write` 必须写进 `policy.ts` 的白名单**：`tools.restrict({allow})` 按名字收口，
  漏掉它模型会直接说「I don't have a todo_write tool」，页面也就没有进度（踩过一次）；
- 提示词第 0 条硬约束：开工先 `todo_write` 拆 4–7 步，每步更新；
- runner 运行/提问期间每 3s 读 `todos` projection 写台账（`RunRecord.todos` / `QaEntry.todos`）。

**用量（token）**：

- runner 结束时读 `tokenUsage` projection（`uncachedInputTokens / outputTokens / cacheReadTokens /
cacheWriteTokens`）写 `RunRecord.usage`、`QaEntry.usage`，并累加 `Project.usageTotal`；
- 全 0 的用量记成 `null`（首轮就报错的调用不该留一条「0 tokens」）；
- 费用是**估算**：`config.pricing = {inputPerMTok, outputPerMTok, cacheReadPerMTok}`，
  不配就只显示 token；页面文案永远带 `≈`。

**布局**：工作台整屏三栏（`dap-scroll--wb` + 三栏各自 `overflow:auto`），
右栏再长也不撑高页面；提问输入框 sticky 在栏底。实测 `document.body.scrollHeight == clientHeight`，
检查器内部 `scrollHeight 7803 / clientHeight 552`。

**容器模型口径**：宿主默认模型切到 `zifei`（自费网关）后，容器的 `self` 路由
（`192.168.1.4:31783`）`/v1/responses` 返回 404；`dsh-docker` 的 profile patch 与 `.env`
已同步加 `zifei` + `ZIFEI_API_KEY`。换网关时记得两边一起改。

**v0.6 布局**（`docs/DESIGN.md` §16）：工作台从三栏变两栏，删掉左栏「图册树」与
「概念索引」；图的选择改成图片上方 **35px 的纯文字图名 tab**（v0.7 把 91px 的缩略图条又压掉了，
不再有额外 iframe），「新建图」是条尾的虚线按钮。
查看器宽度从 ≈566px 增到 784px（1440 窗口）。组件测试里断言了「没有 `.dap-rail__group`」，
别把左栏加回来。

**内嵌查看器隐藏成品页头**：archify 成品 HTML 顶部有一行
`<项目名> · <图名>` 大字 + `pulse-dot`，而插件自己的查看器标题栏和帧头已经写了图名、
分支与时间。`page.tsx` 的 `hideArtifactHeader()` 在 iframe `onLoad` 时往同源文档 head
注入一条 `.header{display:none!important}`，只影响嵌入视图；点「新窗口」仍是成品原样。
同源被沙箱挡住就静默跳过，不影响看图。

---

## 13. v0.2.0：分析跑在子代理会话里 + 设置（模型选择）

> 本节描述 2026-11-09 之后的形态。两个改动是同一条线索的两半：**要能给每次运行
> 单独指定模型，就不能再用「新建一个普通会话」那条路**。

### 13.1 为什么「用子代理执行」

原来 `runner.openSession` 走 `sessionController.create()` —— 那是「开一个新对话」的
接口，后果有两个：分析会话会出现在用户的左侧会话列表里；而要给会话换模型只能用
`sessionController.selectModel()`，它的契约是**顺手把选择存成宿主的全局默认**（会把
用户自己的默认模型改掉）。

改成自己建 agent（`ctx.agents.create`）：

```ts
const handle = await agents.create({
  sessionId: `session-${randomUUID()}`,
  meta: {
    cwd: workspaceDir, // 插件工作区，提示词约定产物落这里
    agentPreset: preset.id, // 与 cordis.patch.yml 里的受限 preset 同一个
    origin: 'subagent', // DSH 侧边栏 sessionVisible() 直接过滤掉
    delegationDepth: 1, // 本插件不再往下派子代理
  },
  agentOptions: { provider, model }, // ← 设置里选的模型，只影响这条会话
  setup: async (agentCtx) => {
    await presets.mount(agentCtx, preset.id)
  },
})
agent.followup({ id, role: 'user', content, source: { kind: 'user' } })
```

要点（改这段前务必知道）：

1. **`mount()` 必须在 `setup` 里调**：preset 的工具面 / persona / skill 目录都是
   在 agent 的 scoped ctx 里注册的，`setup` 是唯一能装上去的时机。
2. **`origin: 'subagent'` 的会话不能被通用会话接口驱动**：`sessionController.prompt`
   会以 `session/agent-busy`（"subagent Sessions require their durable parent address"）
   拒绝。所以提示词用 `agent.followup()`，不要混着用。
3. **不要给这种会话调 `selectModel`**：既被 (2) 拒，也会改全局默认。
4. 召回/收尾完全没变：`agents.get(sessionId)` 仍然拿得到 agent，`whenIdle`、`todos`、
   `tokenUsage` 三个 projection 都照旧。
5. 兜底顺序：`agents.create` 建失败 → 记一条 warn → 退回 `sessionController.create` +（如果 agent 暴露了 `agent.model.select`）直接改这条会话的路由。功能不会因为
   宿主版本变化而消失，只是会话回到「普通会话 + 宿主默认模型」。

### 13.2 设置：只有一个字段

| 位置                                            | 内容                                                      |
| ----------------------------------------------- | --------------------------------------------------------- |
| `src/host/settings.ts`                          | `settings.json` 读写（原子 rename）、形状校验、坏文件回落 |
| `src/host/models.ts`                            | `controller.modelCatalog()` 的防御式收纳（分组 → 扁平）   |
| `GET/PUT /dsh-archify-projects/settings`        | 页面拿/存设置；PUT 在目录非空时校验路由真的存在           |
| `src/client/components.tsx` 的 `SettingsDialog` | 齿轮弹窗：**只有一个模型下拉**，没有第二个可输入控件      |

`ModelRef = { provider, model, reasoningEffort? }`，字段名与 DSH 的 `ModelSelection`
一致，宿主侧可以原样塞进 `agentOptions`，不做翻译。

**模型不在插件里定义**：选项全部来自 `sessionController.modelCatalog()`
（`{ default, groups: [{ id, name, models: [{ id, name }] }], failures }`），
也就是用户在 DSH 里配好、当前真能路由到的那些。目录拿不到时页面只说
「跟随宿主默认」，不显示空下拉假装能选。

### 13.3 真机验证（2026-11-09，dsh-dev 容器 127.0.0.1:3080）

| 步骤                      | 结果                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /settings`（升级前） | `not-found 未知路由：GET /settings`（确认是新代码才有）                                                       |
| `GET /settings`（重启后） | 200，目录里是容器真配的两个路由：`self::…flash`、`zifei::…flash`，`fallback=zifei/deepseek-v4.1-flash`        |
| `PUT /settings`           | 200，`<dataDir>/settings.json` 落盘 `{ model: { provider, model } }`                                          |
| 提问一次（只读会话）      | 45 s 返回带文件行的回答；会话头 `"origin":"subagent","delegationDepth":1`，`config.provider=zifei`            |
| 重画一张图（出图会话）    | `ready` + 产物路径 + usage（160k in / 90k out）；会话头同样 `origin:subagent`，`agentPreset=archify-projects` |
| 会话日志里的工具名        | `read / write / edit / glob / grep / skill / bash / todo_write` —— 白名单原样生效，没有 `web_search`/`task`   |

结论：`mount()` 在真机的两个 preset 上都装对了（工具面、persona、archify skill 全在），
`agentOptions` 也真的生效；`/settings` 的探测在请求期（而不是插件 apply 期）才准，
所以 `RouteState.subagentSessions` 是**惰性函数**，别改回布尔快照 —— apply 时宿主
还没装好 `sessionController`，快照会永远显示「宿主不支持」。

### 13.4 原型同步（OpenDesign）

实现改完必须把**原型**也改掉，否则会出现「页面上有齿轮、原型里没有」的错位：

- `docs/design/workbench-v08.html` = v0.7 + 齿轮按钮 + 设置弹窗（CSS `.iconbtn`/`.select`，
  两个头部各插一个，弹窗开关照抄「新建图」的模式）；
- OpenDesign 项目 **`archify-workbench-v08`**（`index.html` 与上面那份相同）；
- 截图：`docs/design/v08-settings.png`（浅色）、`v08-settings-dark.png`（深色）、
  `v08-atlas.png`（齿轮在头部的位置）；
- 出图方式：`google-chrome-stable --headless=new --window-size=1440,900 --screenshot`，
  深色把 `<html data-theme="dark">` 打开后再截一次。

### 13.5 测试与两个坑

新增：`tests/unit/settings.test.ts`（9）、`tests/unit/models.test.ts`（6）、
`tests/unit/routes.test.ts` 的「设置（分析模型）」（7）、
`tests/integration/subagent.test.ts`（6，含「建会话失败要退回普通会话」）、
`tests/component/page.test.tsx` 的「设置入口」（3）。基线：**206 passed / 15 files**。

- **坑 1：`NODE_ENV=production` 会让组件测试全红**（`React.act is not a function`，
  9 个用例全挂在 `render()` 上）。React 19 的 `act` 只在 development 构建里导出，
  vitest 又是按 `NODE_ENV` 选包的。跑 verify 前确认 `NODE_ENV` 不是 `production`
  （`NODE_ENV=test pnpm verify`）。这不是本插件的 bug，但看起来一模一样。
- **坑 2：组件测试的 fetch 桩是按「METHOD url」精确匹配的**，未命中就回
  `not-found`。`StudioPage` 现在挂载时会 `GET /settings`，所以设置拉取**必须静默
  失败**（`try/catch` 里什么都不做），否则每条老用例都会多出一条错误提示。

---

## 14. v0.2.1 修复（2026-11-11，装机后暴露的两个问题）

用户在**本机 dsh（13080，装在 `~/.dsh/profiles/web`，npm 包 `0.2.0` 真装不是 link）**上
报了两条，都在真宿主里复现并修掉：

### 14.1 总览卡片的「横线太长」

- 现象：项目卡片里「项目结构图」那一行比卡片还宽，压过右边框、破坏留白节奏。
- 真因（CDP 实测 `getComputedStyle(.dap-card).boxSizing === 'content-box'`）：
  宿主没有全局 border-box，`width:100% + padding:14px + border` 让卡片比栅格列宽 30px；
  再叠上 `1fr 1fr` 的轨道被 min-content 撑开，`.dap-thumb--wide` 那行就顶出卡片。
- 改法（`src/client/styles.ts` + `page.tsx`）：
  `.dap-card` / `.dap-thumb` 显式 `box-sizing: border-box`；图条改
  `repeat(auto-fit, minmax(165px, 1fr))`，删掉 `.dap-thumb--wide`（不再单独拉长结构图那一行）；
  标题 `b` 加 `flex:1 1 auto; min-width:0`，长图名只截断不撑宽；底栏 `<span>` 也收 `min-width:0`。
- 验证：CDP 量 `rowWidths = [185.5, 185.5]`、`maxOverflowRight = 0`（2 列 407px 卡）；
  1500 宽 3 列模式同样 0 溢出。**改前端不用重启**，`dsh-client-hmr` 500 ms stat 轮询会自动重挂。

### 14.2 最后一个 todo 永远「进行中」

- 现象：运行 `succeeded` 了，台账里最后一条 todo 仍是 `in_progress`，页面一直转圈，
  看起来像跑了几天没结束。
- 真因：`todo_write` 的最后一次更新常常发生在 `whenIdle()` 之后/之间，3 秒轮询抓不到；
  `finishRun()` 又原样把快照存了进去。
- 改法：
  1. `shared/types.ts` 新增 `settleTodos(todos, status)`：`succeeded` → 残留 `in_progress` 记成
     `completed`；`failed` → 退回 `pending`；`running` → 原样。
  2. `runner.ts`：`watchTodos` 返回 `{stop, flush}`，`follow()` 在 `whenIdle()` 之后先
     `await watch.flush()` 再收尾；`finishRun()` 与 `finishQa()` 落盘前都过一遍 `settleTodos`。
  3. 客户端 `TodoList` 收 `status`，渲染前同样过 `settleTodos` —— **老台账不用改也能显示对**。
  4. 已把本机台账里 4 条历史 `in_progress` 收敛成 `completed`（备份 `projects.json.bak-20261111`）。
- 测试：`tests/unit/shared.test.ts` 4 条、`tests/integration/runner.test.ts` 2 条（成功收敛 /
  失败退回）、`tests/component/page.test.tsx` 2 条（卡片没有 `--wide`、结束后没有 `.dap-todo--now`）。
  基线升到 **213 passed / 15 files**。

> 验证路径（2026-11-11）：`dsh-dev` 容器里 `pnpm verify` 全绿 → `docker compose restart dsh`
> → CDP 量到 `boxSizing=border-box`、三张卡 `maxOverflow=0`、残留 `in_progress` 显示成 ✓；
> 再触发一次真实重画（agent 写入 6 步 todo），运行中 runbar 正常（`正在：加载 archify skill（0/6）`），
> 结束后台账里没有 `in_progress`。
>
> 宿主侧（`lib/**`）改动要**重启 dsh** 才生效；客户端改动同步到
> `~/.dsh/profiles/web/node_modules/dsh-archify-projects/dist/` 后走热更即可。
> 本机这份安装是 npm 包而不是 `link:`，所以直接改仓库**不会**自动生效，必须重新
> `pnpm build` 再把 `dist/` 与 `lib/` 抄进 profile 的 `node_modules`（或把依赖改回 `link:`）。

---

## 15. v0.2.2 修复（2026-11-11，子代理会话没有模型）

### 15.1 现象

本机宿主（npm 包 `0.2.0`）上新建项目 / 重画，运行「刚开始就结束」：台账写
`没有找到这次运行的产物文件`、`部分图谱没有产出`，产物目录是空的，连续四次全一样。

### 15.2 真因

`agents.create`（子代理会话那条路）**不会**去读宿主默认模型。DSH 里注入
`agentOptions` 的只有 `sessionController.createAgent()`（它用 `agentOptions()` getter
读 `agentDefaultModel.currentSelection()`）。v0.2.0 把分析改成子代理会话后，
`model === null` 时干脆不传 `agentOptions` —— 建出来的 agent 一个 provider/model
都没有，`dsh-agent-loop` 在 `preStep` 里 `this.model.current()` 拿到 `undefined` 就抛：

```
agent "session-…" has no provider/model:
set AgentOptions.provider and AgentOptions.model or record a model selection
```

`kick()` 把这个异常吞进 `turn/end: {reason: {kind: 'error'}}`，外面只剩「没有产物」。
11-09 那两张图能出，是因为当时还在 `sessionController` 那条老路上。

### 15.3 改法

1. `runner.ts` 新增 `resolveModel(ctx, config)`，三级取源：
   **插件设置 → `ctx.agentDefaultModel.currentSelection()` → `modelCatalog().default`**。
   第二级就是「DSH 里配的模型」，`HostContext` 里补了 `AgentDefaultModelLike`。
2. 仍然为 `null`（老宿主没有这两样）时**不建子代理会话**，退回 `sessionController`
   —— 那条路自带注入，功能不消失，代价是会话会出现在侧栏。
3. `agentOptions` 从「可能为空」变成必然非空；`index.ts` 的 `VERSION` 常量同步到
   `package.json`（0.2.1 发版时漏改，`/health` 一直报 0.2.0），并加
   `tests/unit/version.test.ts` 守着。

### 15.4 验证（dsh-dev 容器，2026-11-11）

删掉容器里的 `<dataDir>/settings.json`（逼出「跟随默认」这条路）→ 重画一张图：

| 检查点                  | 结果                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| 会话头                  | `origin: subagent`、`delegationDepth: 1`、`agentPreset: archify-projects`         |
| `request/header.config` | `{provider: "zifei", model: "deepseek-v4.1-flash", maxTokens: 64000}` —— 继承成功 |
| 首轮                    | 无 `no provider/model`；连续 26 步、42 次工具调用                                 |
| 兜底                    | 单元/集成用例覆盖「没有默认模型时退回普通会话」                                   |
| 质量门                  | **215 passed / 15 files**（`NODE_ENV=test pnpm verify`，容器内）                  |

> 同日观察到另一类失败：该会话第 27 步的长推理请求长时间无响应，最终撞上
> `等待 agent 结束超时（1200000 ms）`。与本节无关（模型路由已正常），属网关侧慢。

### 15.5 别再犯

- **任何 `agents.create` 都必须自己带 `provider/model`**：宿主不会替你补，
  缺了的表现是「运行秒结束 + 没有产物」，而不是一条好看的错误。
- 插件设置里的 `model` 是**覆盖**，不是默认值来源；默认值只有 `agentDefaultModel`。

### 15.6 发布（v0.2.2）

`git push origin main --tags`（tag `v0.2.2`）→ release workflow 45 s 跑完：verify →
pack → Release 资产（`dsh-archify-projects-0.2.2.tgz` + 稳定别名 + `SHA256SUMS.txt`）→
`npm publish`。核对结果：

- npm 上 `0.2.2` 在发布后约 **2 分钟**才出现在 packument 里（不是失败，别急着重发）；
- `releases/latest/download/dsh-archify-projects.tgz` → 200，1 989 382 B；
- 两处 tgz **内容**一致，但**字节**不一致：`pnpm pack` 会重写 `package.json`（去掉 `scripts`），
  而旧 workflow 的 `npm publish` 是现场重打包。已把 publish 步骤改成直接发
  `$RUNNER_TEMP/dsh-archify-projects-<version>.tgz`，从下一版起两处 sha256 应当相同。
