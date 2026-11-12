# dsh-archify-projects

给 DSH 加一个「代码库图谱工作台」：登记本地仓库 → 自动识别 Git 分支与提交点 →
由受限的 DSH agent 调 [archify](https://github.com/tt-a1i/archify) 产出**项目结构图**与**领域图** →
以后每次打开都能切回记录的分支、更新到最新提交再重画。

左侧顶栏一个入口，右侧整页工作台，深浅色主题都跟随 DSH。

> 接手开发先看 [`docs/HANDOVER.md`](docs/HANDOVER.md)（架构、真机坑、质量门、待办）；
> 设计取舍在 [`docs/DESIGN.md`](docs/DESIGN.md)。

---

## 它解决什么

一件事反复做：读一个新仓库并画出结构/领域图，每次都从零开始、每次结论可能互相矛盾。
这个插件把它变成**可重复的操作**：

| 你在界面上做的                 | 插件背后做的                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 填一个本地仓库路径，点「添加」 | `git rev-parse` 探测：是不是仓库、当前分支、HEAD commit、有没有未提交改动；然后建会话、投提示词、收产物 |
| 打开某个项目                   | 显示记录的分支/commit/上游状态，两张图的产物、生成时间、基于哪个 commit，以及运行历史                   |
| 点「更新」                     | 先把仓库切回**当初记录的分支**并 `merge --ff-only` 到最新，再让 agent 基于新代码重画                    |
| 点某张图的「重画」             | 只重画那一张，另一张不动                                                                                |
| 点「打开会话」                 | 跳到那次运行的 DSH 会话，能看到 agent 读哪些文件、怎么得出结论                                          |
| 仓库不是 Git 库                | 不折腾分支，直接基于当前目录内容建模                                                                    |

---

## 效果

> 截图来自真实运行——被测仓库就是这个插件自己，数据都是跑出来的，不是设计稿。

**总览**：每个仓库一张卡片，直接看出分支、工作区改动、概念数、哪些图已经就绪、有没有人在跑。

![总览：仓库卡片、概念数、图状态](https://raw.githubusercontent.com/guicaiyue/dsh-archify-projects/main/docs/verify/shot-atlas.png)

**工作台**：图名 tab 在图片上方（只有文字，不占高度），左边是图，右边是检查器——
prompt、概念范围、分支、进度、token 用量、运行记录都在这一栏。

![工作台：图名 tab、成品图、右侧检查器](https://raw.githubusercontent.com/guicaiyue/dsh-archify-projects/main/docs/verify/shot-workbench.png)

**提问**：对着某张图问细节，agent 在**只读会话**里读代码回答，回答可以直接「补进图里」
或变成一张子图。

![提问：只读会话基于图和代码回答](https://raw.githubusercontent.com/guicaiyue/dsh-archify-projects/main/docs/verify/shot-qa.png)

**新建图**：图型 tag 直接对应 archify 的 5 种渲染器，点一下告诉你「适合看什么 / 会展示
代码库的哪些信息 / 能让你掌握什么」；不选也行，由 agent 判断。

![新建图：图型 tag 与说明](https://raw.githubusercontent.com/guicaiyue/dsh-archify-projects/main/docs/verify/shot-dialog.png)

---

## 安装

装的是**已发布的包**，一条命令，装在哪个 profile 就写哪个名字（默认 `web`）：

```bash
dsh plugin --profile web add dsh-archify-projects
```

然后重启 dsh（宿主侧代码，必须重启）。重启后左栏出现「架构建模」。

也在 npm 上（`dsh-archify-projects@0.1.1`）。

**备用路径**：GitHub Release 上的预构建 tarball（和 npm 包内容一致）：

```bash
dsh plugin --profile web add https://github.com/guicaiyue/dsh-archify-projects/releases/download/v0.1.1/dsh-archify-projects-0.1.1.tgz
```

> ⚠️ **不要用 `add github:guicaiyue/dsh-archify-projects` 从源码装**：
> `lib/`、`dist/` 是构建产物、不进版本库，pnpm 默认又不跑构建脚本，装完插件起不来。
> 要么用 npm 包 / Release tarball，要么先把仓库 clone 下来自己 `pnpm install && pnpm build`
> 再用 `add link:<绝对路径>`（这是本机开发用的路径）。

**本机开发**（改了代码要立刻生效）：

```bash
cd ~/.dsh/profiles/web
pnpm add link:/absolute/path/to/dsh-archify-projects   # 或在 package.json 里写 link:
# dsh.profile.bundles 里同时要有 "dsh-archify-projects"
```

依赖：**没有外部 npm 依赖**。archify skill 本体（`skills/archify/`，约 7.3 MB，来自
`@tt-a1i/archify-dsh@1.0.0` 的 tarball）已经内嵌在包里，preset 的 `bundledSkillDir`
指向它，所以装/卸别的 archify 插件都不影响这里。

> 早期版本是指向 profile 里的 `@tt-a1i/archify-dsh/skills`，那个包一旦被卸载，
> 建会话就抛 `Cannot find module '@tt-a1i/archify-dsh/package.json'`，图一张都出不来。
> 现在这条依赖已经断掉。

## 使用

1. 左栏点「架构建模」（`Archify`）图标。
2. 「新增项目」——填代码库绝对路径，名字可留空（默认取目录名）。
3. 首次添加会自动跑一次 `create`：结构图 + 领域图各一张，通常几分钟。
4. 之后随时「更新」：切回记录的分支 → 快进到最新 → 重画两张图。
5. 图是可以直接看的 HTML（archify 产物：可搜索、可缩放、可导出），不是截图。
6. 右上角**齿轮**是设置：只有一个「分析模型」下拉，选项就是你在 DSH 里已经配好、
   当前真能路由的模型；不选＝跟随宿主默认。改完对下一次运行生效。

## 语言

图的标题、节点、连线、卡片文字是 agent 写进 `candidate.json` 的，渲染器只本地化
图例/工具栏那一圈 chrome，所以「出图用什么语言」只能靠提示词要求。配置项
`outputLanguage` 就是干这个的：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（按 id 覆盖即可，不用改插件自己的 patch）
- id: dsh-archify-projects
  name: dsh-archify-projects
  config:
    outputLanguage: en
```

- 取值：`en` / `zh-CN`（以及 `English`、`中文`、`zh_TW` 这类别名）；写别的语言名也认
  （正文按名字要求，图例落英文）。
- **不写这一项**＝历史行为：agent 跟随提示词本身的语言，即中文。
- 生效范围：之后的**每一次出图**（新建、更新、重画）和**问答会话**。已经生成好的图不会
  自己变 —— 要么「重画」，要么直接改 `candidate.json` 后 `archify finalize` 重渲染。
- 渲染器只认识 `en` / `zh-CN` 两套界面语言，所以 `meta.locale` 只会是这两个值之一；
  正文语言不受这个限制。

---

## 设计要点

完整设计见 [docs/DESIGN.md](docs/DESIGN.md)。这里只列会影响使用的几条。

### 只读代码库，只切分支不动你的改动

- 只跑只读 git 命令（`rev-parse` / `log` / `status` / `remote` / `rev-list`）。
- 更新时只会 `fetch` + `checkout <记录的分支>` + `merge --ff-only`。
- 工作区有未提交改动就**整段跳过**同步（`reason: 'dirty'`），在界面上说明「按当前内容分析」，
  绝不 `reset --hard` / `clean` / `stash` / 强推。
- 产物一律写到插件自己的工作区（`<dataDir>/workspace/<projectId>/.archify/…`），不碰代码库。

### agent 只能用 archify，无关工具进不来

三层同时生效：

| 层         | 机制                                                                                                  | 挡住什么                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| skill 目录 | preset 私有的 `dsh-skill-filesystem`（`includeDefaultRoots: false` + `bundledSkillDir` 指向 archify） | agent 的 skill 列表里只有 `archify`                                    |
| 工具面     | `tools.restrict({ allow: [read, write, edit, glob, grep, skill, pwsh\|bash] })`                       | 联网、子 agent、工作流、todo 等工具压根不可见（调用即 `UNKNOWN_TOOL`） |
| 执行层     | `tools.guard` —— `skill` 的 `name` 必须是 `archify`，其它工具必须在白名单里                           | 即使前两层被绕过，运行期也会被拒                                       |

`restrict` 只能装在 scoped ctx（`agent.ctx`）上，写在 preset 行里会直接抛 ——
所以白名单与守卫在 `src/host/policy.ts` 里，运行开始时对当次会话安装。

### 分析跑在子代理会话里，不占你的会话列表

每次出图 / 提问都用一个 **`origin: 'subagent'` 的会话**（`ctx.agents.create` +
`agentPresets.mount`），所以：

- DSH 左侧会话列表按 origin 过滤子代理会话 —— 分析不会往你的对话列表里塞新条目；
- 会话的模型走 `agentOptions`：设置里没选就用 **DSH 里配的默认模型**
  （`agentDefaultModel`），**只影响这一次运行**，不会改掉 DSH 里你的默认模型；
- 宿主版本没有这条路（缺 `agents.create` / `agentPresets`）时安静退回普通会话，
  工具白名单、preset、产物回收都不变。

### 深浅色

页面只用 DSH 的主题令牌（`--dsw-alias-*` / `--dsw-specific-*` / `--dsw-radius-*` /
`--dsw-shadow-*` / `--dsw-focus-ring-*`），没有一处硬编码颜色，也没有任何
`prefers-color-scheme` 分支 —— 深色由 `body[data-ds-dark-theme]` 自动翻转。

---

## 开发

```bash
pnpm install
pnpm build          # 双产物：src/client → dist/client.js（tsdown）；src/host → lib/host/**（tsc）
pnpm verify         # build + artifact:check + typecheck + lint + format + deps + 全部测试（含覆盖率门槛）
pnpm dev            # 只重建客户端产物；保存即热更新进已打开的页面
```

顺序：改完 → `pnpm lint:fix` → `pnpm format` → `pnpm verify`。不绿不算完。

**改动怎么生效**

| 改哪里             | 生效方式                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/**`    | `pnpm build`（或常驻 `pnpm dev`）→ `dsh-client-hmr` 轮询到 mtime 变化 → 自动换掉模块，**不用刷新、不用重启**（React 内部状态会丢，页面回到默认视图） |
| `src/host/**`      | `pnpm build` 后**重启 dsh**（Node 的 ESM 缓存活到进程结束）                                                                                          |
| `cordis.patch.yml` | 重启 dsh                                                                                                                                             |

### 质量门禁（`pnpm verify` 里的每一项）

| 命令                    | 拦的是什么真实缺陷                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `tsc --noEmit` ×2       | 宿主与客户端的类型错（两份 tsconfig：客户端 `bundler`，宿主 `NodeNext`）                                         |
| `eslint .`              | 未处理的 Promise、把 Promise 传错地方、`await` 非 Promise、客户端误用 `process`/`Buffer`                         |
| `prettier --check .`    | 排版漂移                                                                                                         |
| `depcruise`             | 宿主 ↔ 客户端互相 import、循环依赖、客户端引 `node:` 内建                                                        |
| `artifact:check`        | 产物形状：单壳 + `id` 等于包名 + 只用 11 个 baseline 外置 + 无顶层 ESM + 体积预算 + **沙箱里真跑一遍 `factory`** |
| `vitest run --coverage` | 174 个用例；覆盖门槛 lines 70 / branches 60 / functions 70，`git.ts`、`store.ts`、`prompt.ts` 单独收紧           |

### 发版（Release 由 CI 自动发布）

推 `v*` 标签即发布，**不需要手工打包/上传**：

```bash
npm version patch --no-git-tag-version     # 或手工改 package.json 的 version
git commit -am "chore: release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

`.github/workflows/release.yml` 会：`pnpm verify`（不绿不发）→ `pnpm pack` →
建 Release（自动 release notes）→ 挂 `dsh-archify-projects-<version>.tgz`、
稳定别名 `dsh-archify-projects.tgz`、`SHA256SUMS.txt`。
标签与 `package.json` 版本不一致时任务直接失败。

想连 npm 一起发：仓库 Secrets 加 `NPM_TOKEN`，workflow 会多跑 `npm publish --access public`；
没配就跳过。首次发 npm 的完整步骤（含镜像源这个坑）见 [`docs/PUBLISH.md`](docs/PUBLISH.md）。
`.github/workflows/verify.yml` 负责 main / PR 上的常规质量门。

### 测试分层

```
tests/unit/        纯逻辑：format / types / prompt / git / store / http / policy / runner / workspace
tests/contract/    locale 双语键一致 + 包级 meta
tests/integration/ 真台账 + 真临时目录 + 桩 ctx，跑完整一次运行编排
tests/component/   jsdom + RTL：空态、有项目、生成中、失败、非 Git、接口错误
```

覆盖率只量宿主侧源码。客户端渲染不计入 —— jsdom 覆盖不到布局、悬停、滚动分支，
硬卡它的行数只会逼出一堆假测试；客户端由 `artifact:check` 与真机验证兜着。

### 目录

```
src/shared/   两侧共用：类型、协议常量、格式化、提示词与产物标记解析
src/host/     apply、路由分发、台账、git、运行编排、会话策略、工作区
src/client/   入口、页面、组件、样式、locale 字典、fetch 封装
cordis.patch.yml   挂载 + 受限 preset
locale/            包级 meta（zh.json / en.json）
scripts/           artifact 门禁
```

两侧**只共享契约**（HTTP 形状、locale 键、URL 常量），实现各写一份：
浏览器里没有 `node:*`，Node 里没有 `window`，这条由 dependency-cruiser 守着。

---

## 数据落在哪

| 位置                                                         | 内容                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `~/.dsh/archify-projects/projects.json`（可用 `dataDir` 改） | 台账：项目、Git 快照、两张图的状态、运行历史（保留最近 20 条）                          |
| 同目录 `settings.json`                                       | 插件设置：分析用哪个模型（`{ provider, model }`，null = 跟随宿主默认）                  |
| `~/.dsh/archify-projects/workspace/<projectId>/`             | 每个项目的工作目录；`.archify/<kind>-<slug>-<stamp>/` 里是 `candidate.json` 与成品 HTML |
| `<插件目录>/skills/archify/`                                 | 内嵌的 archify skill（不进 git：见 `.gitignore`；npm 包用 `files` 带上）                |

台账损坏时会改名备份成 `projects.json.corrupt-<时间戳>` 再从空台账起步，
不会静默覆盖；写入走临时文件 + rename，并发请求串行化。

## 已知边界

- 同一项目同一时刻只允许一次运行；正在跑时「更新」按钮禁用，再点会被后端拒。
- agent 忘了打产物标记时，插件按 `.archify/` 目录兜底；兜底失败则该图记 `failed` 并显示原因。
- 第三方 bundle 若注册了**全局层**的 skill provider，仍可能出现在 agent 的 skill 列表里
  （DSH 没有提供目录过滤钩子），但它**调用不了** —— 守卫要求 `name === 'archify'`。
- 宿主侧没有热重载，这是第三方插件的真实落差，不是本插件能绕的。
