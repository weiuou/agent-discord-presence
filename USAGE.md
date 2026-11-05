# 使用指南 · weiuou fork

[返回 README](README.md)

本文对应 [weiuou/agent-discord-presence](https://github.com/weiuou/agent-discord-presence) 的源码版本。原项目为 [LitoMore/agent-discord-presence](https://github.com/LitoMore/agent-discord-presence)；包名、CLI 命令和配置目录继续沿用，以便复用已有接入。

- [安装与升级](#install)
- [服务管理](#service)
- [Dim Rust α](#dim-rust-alpha)
- [旧版 DimAgent CLI / Desktop](#dimagent-typescript)
- [其他 Agent](#other-agents)
- [独立配置与预设](#configuration)
- [摘要、模型和数据流](#summaries)
- [图标与显示](#display)
- [会话选择与清理](#sessions)
- [排查问题](#troubleshooting)
- [开发与验证](#verification)

<a id="install"></a>
## 安装与升级

需要 Git、Node.js 22+、npm，以及已登录的 Discord 桌面客户端。

```sh
git clone https://github.com/weiuou/agent-discord-presence.git
cd agent-discord-presence
npm ci
npm run build
npm install --global .
```

本文通过本 fork 的源码安装。`npm install --global agent-discord-presence` 对应 npm 注册表中的同名发布包，不能据此判断是否包含此 fork 的 Dim 适配。包内的名称、版本号和上游作者元数据也不应单独用来区分源码来源。

以下命令使用短别名 `adp`。不全局安装时，在源码目录把它替换为 `node dist/cli.js`。生成配置中的绝对路径会绑定当前 Node 和源码位置，移动目录或更换 Node 后需要重新生成。

更新源码并重新构建、安装后，重启 ADP，使运行中的服务加载新代码：

```sh
npm ci
npm run build
npm install --global .
adp stop
adp start -b
```

已安装的客户端插件也应按客户端要求重载或重启。更新前先处理自己的本地修改。

<a id="service"></a>
## 服务管理

```sh
adp start -b       # 后台运行，返回 PID 和日志路径
adp status        # 查看 Discord 连接、会话与有效配置
adp stop          # 清除活动并停止服务
```

前台运行使用 `adp start`，以 Ctrl+C 停止。`adp start --dry-run` 输出活动 JSON，适合预览；默认不调用摘要模型。后台启动继承当前终端的环境变量，终端关闭后服务继续运行，但不会配置开机自启或崩溃自动恢复。

`status` 中 `discord: "connected"` 表示 IPC 已连接，`activityAcknowledged: true` 表示 Discord 已确认当前活动。活动为 `null` 时，先检查是否已有 Agent 会话。图像最终是否渲染仍需查看 Discord 客户端。

项目自带 Application ID `1549160807705870418`，定义在 `src/constants.ts`。也可通过 `--client-id` 或 `DISCORD_CLIENT_ID` 指定自己的 Discord application。ADP 不需要 bot token。预上传的 Discord asset key 必须属于当前 application。

| 参数或环境变量 | 用途 |
| --- | --- |
| `--client-id` / `DISCORD_CLIENT_ID` | Discord Application ID |
| `--socket` / `AGENT_PRESENCE_SOCKET` | 本地服务地址；客户端与服务需一致 |
| `DISCORD_IPC_PATH` | 覆盖 Discord IPC 路径发现 |
| `--stale-minutes N` | 命令 hook 的静默超时，1–1440 分钟，默认 30 |
| `--dry-run` | 输出活动 JSON |
| `ADP_CONFIG` | 使用指定配置文件 |

Windows 使用命名管道，Unix 使用本地 socket。远程 Agent、容器和 SSH 会话需要另外安排可达的本地 IPC 转发；ADP 不会自动跨机器连接桌面 Discord。

<a id="dim-rust-alpha"></a>
## Dim Rust α

本节用于开源 [arcships/dim](https://github.com/arcships/dim) 的 Rust harness。npm alpha 包为 `dimcode-alpha`，命令为 `dima`；源码构建的二进制通常名为 `dimcode`。

### 安装原生插件

先完成上面的 fork 安装并启动 ADP，再执行：

```sh
npm install --global dimcode-alpha@alpha
dima --version
dima runtime config node --source system
dima runtime install node
dima plugin install "/absolute/path/to/agent-discord-presence/plugins/dim"
dima runtime list
dima plugin list
```

把路径换成此 fork 的真实位置。运行环境安装是异步的，等待 Node runtime 为 `ready`、`agent-discord-presence` 为 `running` 后再启动任务。Dim 管理自己的运行环境依赖；系统 Node 需要满足其版本要求，已验证组合为 Node 24.13.0。

插件源目录需保留。全局安装后的目录也可使用：`<npm root --global>/agent-discord-presence/plugins/dim`。嵌入式宿主可导入 `agent-discord-presence/dim`。

```sh
dima
```

首次使用需要登录或配置模型。例如 Dim 账号登录可使用 `dima login dimcode-api-oauth`，也可在交互界面选择登录方式。安装插件和正常运行应使用同一 Dim home；alpha 默认使用 `~/.dimcode-alpha`，与旧版 CLI 的数据目录分开。账号与会话不会因安装 ADP 自动迁移。

<a id="dim-windows"></a>
### Windows alpha.19 的 Node 路径兼容

在 Windows、Dim Rust `0.1.0-alpha.19`、Node 24.13.0 的组合上，官方启动链路可能把 verbatim 路径传给 Node，导致 `EISDIR ... lstat 'C:'`，或 Node runtime 在连接前退出。

在启动 Dim 的 PowerShell 终端设置以下选项后重试：

```powershell
dima daemon stop
$env:NODE_OPTIONS = "$env:NODE_OPTIONS --preserve-symlinks --preserve-symlinks-main".Trim()
dima runtime config node --source system
dima runtime install node
dima runtime list
dima plugin list
```

环境变量只对当前终端及其子进程生效。从其他终端重新启动 Dim daemon 时，也需提供这两个选项。对本机 Dim 启动器所做的补丁不会随 ADP 源码安装自动应用，升级 Dim 也可能覆盖它。修复后的 Dim 版本可重新检查是否仍需此兼容设置。

### 状态与摘要

原生插件订阅 Session 事件，并为每个 Session / branch 独立上报状态：

| 事件 | ADP 状态 |
| --- | --- |
| `turn/start` | Working |
| 有未结束的 `approval/request` | Waiting；所有授权请求结束后恢复 |
| 回合完成、取消或中断 | Idle |
| 回合失败 | Error |
| 分支结束、Session 关闭或插件卸载 | 关闭对应 reporter |

会话 key 为 `dimagent:rust:…`，后半部分由 Session / branch 标识计算；复制 `adp status` 中的完整 key 来固定会话或设置手动摘要。插件每 20 秒发送心跳，ADP 重启后可自动恢复该会话。

两代 Dim 共用 `--agent dimagent` 配置和 `DimAgent` 默认显示标签。该适配通过独立插件复用现有协议、服务和显示配置。

默认 `service: session` 时，完成摘要通过 Dim 的 `auxiliaryModel.complete` 调用当前模型与 provider，直接复用 Dim 的凭据。调用只含 presence 提示词和最多 4,000 个 Unicode 字符的最终助手文本，没有工具或原会话历史，也不启动旧版 CLI、读取 session export。文本增量和可选的完整内容快照都可处理。

只有对应请求以 `end_turn` 完成、回合成功且最终消息不含工具调用时才生成摘要；推理、工具参数、工具结果及失败/取消的输出不作为摘要正文。生成队列有界、串行执行，超时 60 秒；会话变化时丢弃过期结果，失败保留已有标题。此适配目前生成完成摘要，旧版适配的早期目标标题与工具阶段模板见下一节。

Rust 插件的摘要任务不计入 ADP daemon 的 `generation`、`dimagentCapture` 或 `dimagentLive` 计数。选择 `openai-compatible` 时，相关端点、模型设置和 API key 环境变量需要对 **Dim 进程** 可见。

<a id="dimagent-typescript"></a>
## 旧版 DimAgent CLI / Desktop

本节用于旧版 TypeScript `dim` / `dimagent` CLI，以及共用其 hooks 的 Desktop。接入契约检查版本为 CLI 0.5.21；Desktop 0.9.56 的 bundled CLI 0.5.20 也通过了隔离验证。

选择插件或手动 hooks 中的一种安装方式，避免重复上报。

### 插件安装

```sh
dim plugin install "/absolute/path/to/agent-discord-presence/plugins/dimagent/agent-discord-presence"
```

如本机命令名为 `dimagent`，用该命令替换 `dim`。插件的 hook 命令依赖 PATH 中的 `agent-discord-presence`，安装后重启客户端。

### 手动 hooks 与 Desktop

```sh
adp config dimagent
```

把输出的 `hooks` 条目合并到对应 home 的 `hooks.json`，保留原有条目并使用 UTF-8。此命令只打印配置，不会自动安装。中国版常见目录为 `~/.dimcode/v2/hooks.json`，国际版为 `~/.dim/v2/hooks.json`；`DIMCODE_HOME` 可覆盖。项目文件分别为 `.dimcode/hooks.json`、`.dimglobal/hooks.json`。

生成器支持 Windows 与 POSIX 的绝对路径。Desktop 也可采用这种方式，以便避开 GUI 进程的 PATH 差异；修改后开启新会话，已有会话必要时重启 Desktop。

摘要服务需要能找到匹配的旧版原生 CLI 和包含会话、模型凭据的 home。Windows 会尝试发现标准 Desktop 安装中的 `resources/runtime/cli/dim.exe`，也可显式设置：

```powershell
$env:ADP_DIMAGENT_COMMAND = "$env:LOCALAPPDATA/Programs/DimAgent/resources/runtime/cli/dim.exe"
$env:DIMCODE_HOME = "$env:USERPROFILE/.dimcode/v2"
adp start -b
```

把这些变量提供给 ADP daemon，并在变更后重启服务。`ADP_DIMAGENT_COMMAND` 应指向原生可执行文件；npm `.cmd` shim 不适合此处的直接进程调用。`dim hooks list --json` 在 0.5.21 中不枚举插件 hooks，可通过执行任务后查看 `adp status` 验证接入。

### 目标标题、阶段与完成摘要

`UserPromptSubmit` 先显示“正在分析任务”，后台再从最多 2,000 个字符的用户目标生成标题。常见 token、凭据赋值、URL 和路径会先过滤；这不是完整的语义脱敏保证。工具名称选择“阅读项目文件”“修改项目文件”“运行命令”等固定阶段，阶段变化通常每 5 秒合并更新，授权等待立即更新。

该任务的模型路由由 `dim session list --all --json` 读取。完成时，hook 携带 `Stop.run_id`，daemon 再通过有界 `dim session export SESSION_ID` 选择该次运行的最终助手文本。导出最多 8 MiB / 10,000 条消息，捕获期限 15 秒，缺失时最多读取三次；模型最终只收到最多 4,000 个字符的助手文本。读取过程中可能临时接触其他会话预览或当前会话历史，相关内容不写入 ADP 状态和日志。

默认摘要使用无工具的旧版 `dim exec` 辅助调用，禁用 hooks、使用只读策略及递归保护。辅助会话可能保留在 DimAgent 自己的历史和日志中。新任务、手动摘要或配置变更会使旧的捕获/生成失效。

```sh
adp config set liveSummaries false --agent dimagent  # 关闭早期目标标题和阶段模板
adp config set enabled false --agent dimagent        # 关闭模型摘要，保留状态
adp config set idleMinutes 5 --agent dimagent        # 缩短空闲 hook 会话保留时间
```

旧版 hook 契约没有 `SessionEnd`、`Interrupt`、`StopFailure` 或 `PostToolUseFailure`。退出、取消和错误无法可靠单独映射，静默会话依赖超时清理。授权拒绝后没有新事件时，Waiting 也可能保持到下一事件或超时；其他 Stop hook 请求继续执行时，可能短暂显示 Idle。

<a id="other-agents"></a>
## 其他 Agent

先启动 ADP，再接入客户端。现有配置需要合并，避免覆盖其他 hooks 或插件。

### Codex

POSIX 环境可运行：

```sh
adp config codex
```

将输出合并到 `~/.codex/hooks.json` 或项目 `.codex/hooks.json`，在客户端检查 hooks 的启用/信任状态，然后开启新会话。

Windows 下此绝对路径生成器会报平台限制。可使用 `plugins/codex/agent-discord-presence/hooks/hooks.json` 中的 PATH 命令条目进行合并；`agent-discord-presence` 必须在客户端 PATH 中。仓库也附带 `plugins/codex/agent-discord-presence` 插件包装，marketplace 注册由客户端安装流程完成。

### Claude Code

POSIX 环境运行 `adp config claude-code`，合并到 `~/.claude/settings.json` 或项目 `.claude/settings.json` 后重启客户端。Windows 可使用 `plugins/claude-code/agent-discord-presence/hooks/hooks.json` 中的 PATH 命令条目。

也可直接加载此 fork 的插件目录：

```sh
claude --plugin-dir "/absolute/path/to/agent-discord-presence/plugins/claude-code/agent-discord-presence"
```

### OpenCode

```sh
adp config opencode
```

把输出的导出语句保存到 `~/.config/opencode/plugins/agent-presence.ts` 或项目 `.opencode/plugins/agent-presence.ts`，创建需要的目录并重启 OpenCode。插件处理会话状态、空闲、错误和授权事件。

### Pi

```sh
adp config pi
```

把输出保存到 `~/.pi/agent/extensions/agent-presence.ts`，再重载扩展或重启 Pi。临时加载也可使用 `pi -e /absolute/path/to/agent-discord-presence/dist/adapters/pi.js`。

客户端需提供 `agent_settled`、`ui_prompt_start` 和 `ui_prompt_end` 事件。只有 `agent_end` 的旧版 Pi 无法准确区分重试、压缩和排队续跑。

### DeepSeek Harness

从已构建的 fork 源码安装本地 bundle：

```sh
dsh plugin --profile web add /absolute/path/to/agent-discord-presence
```

将 `web` 替换为自己的 profile，然后用该 profile 重启 Harness。移除使用 `dsh plugin --profile web remove agent-discord-presence`。

插件跟踪真实 idle、授权、错误和卸载。默认通过 Harness 的 `ctx.llm.stream` 复用当前 provider 与模型，只传入 presence 提示词和有界助手回复；选择 `openai-compatible` 后由 ADP daemon 调用外部服务。原生摘要在插件内串行执行，并有取消和过期结果检查。

<a id="configuration"></a>
## 独立配置与预设

配置默认保存在 `~/.config/agent-discord-presence/config.json`，支持 `XDG_CONFIG_HOME` 和 `ADP_CONFIG` 覆盖。

```sh
adp config show
adp config show --agent dimagent
adp config set customPrompt '用简洁中文描述任务。' --agent dimagent
adp config set maxLength 72 --agent dimagent
adp config unset customPrompt --agent dimagent
```

`--agent` 可选值为 `codex`、`claude-code`、`opencode`、`pi`、`deepseek-harness` 和 `dimagent`。不带该选项时修改共享设置；两代 Dim 共用 `dimagent`。

配置优先级从低到高为：内置默认值及 Agent 图标、全局预设、Agent 预设、显式全局设置、显式 Agent 设置。对象递归合并，数组和 `null` 替换继承值。`unset --agent` 移除该层覆盖并恢复继承。

| 字段 | 默认值与用途 |
| --- | --- |
| `enabled` | `true`；控制模型摘要，状态接入继续工作 |
| `customPrompt` | 空字符串；指定摘要语言、语气和侧重点 |
| `maxLength` | `72`；生成标题与副标题各自的字符上限，允许 20–120 |
| `service` | `session`；使用当前 Agent 的原生服务，或设为 `openai-compatible` |
| `model` / `provider` | 空字符串；跟随会话，非空时覆盖 |
| `liveSummaries` | `true`；旧版 DimAgent 的目标标题与阶段显示开关 |
| `idleMinutes` | `0`；空闲命令 hook 的额外超时，正整数 1–1440 分钟 |
| `presence` | 图标、文字、计时器等显示覆盖 |

模型或提示词变更影响后续任务；已有生成结果会做相应的新鲜度检查。配置和显示可热更新，修改代码后需要重启服务。无效配置保留上次有效设置，错误通过 `settingsError` 报告。

<a id="presets"></a>
### 预设

```sh
adp preset list
adp preset show dimagent minimal
adp preset apply dimagent minimal --agent dimagent
adp config unset presets --agent dimagent
```

预设定义在 `presets.json`。内置名称包括 `default`、`minimal`、`playful`、`codex`、`claude-code`、`opencode`、`pi`、`deepseek-harness`、`dimagent`。组合按顺序覆盖，显式用户设置仍有更高优先级。`apply` 保存所选预设名称；`default` 不会清空其他显式配置。

Agent 的基础图标自动作为默认值使用。Codex、Claude Code、OpenCode、Pi 和 DeepSeek 图标来自固定版本的 [Lobe Icons](https://github.com/lobehub/lobe-icons)，DimAgent 默认图标来自其官方 favicon。彩虹 α 图标需要按下文显式启用。

<a id="summaries"></a>
## 摘要、模型和数据流

默认摘要为短标题 `topic` 和补充说明 `subtitle`，每项上限 72 个 Unicode 字符；副标题可以为空。默认提示词使用英文，中文对话不会自动切换摘要语言，可通过 `customPrompt` 设置。状态标签如 Working、Waiting for input 仍为英文。

```sh
adp prompt
adp prompt minimal
adp config set customPrompt '用中文，简短描述实际工作，不夸大完成情况。'
```

| Agent | 原生生成输入与调用方式 |
| --- | --- |
| Dim Rust α | 最终模型请求的助手文本；Dim 辅助模型服务 |
| 旧版 DimAgent | 过滤后的用户目标或精确运行的最终回复；旧版 `dim exec` |
| Codex | `Stop.last_assistant_message`；临时、只读的 `codex exec` |
| Claude Code | Stop 助手回复；`claude -p --safe-mode`，无工具 |
| OpenCode | 空闲时的助手文本；拒绝工具权限的 `opencode run` |
| Pi | `agent_settled` 时的助手文本；无工具和扩展的 `pi --print` |
| DeepSeek Harness | 真正 idle 时的助手文本；进程内 LLM service |

原生 CLI 需已安装、已登录并支持所用参数，特别是 Claude Code 的 `--safe-mode`。会话模型标识不足时不会随意选择其他模型。原生调用跟随模型 ID，不保证继承会话的推理强度等全部参数。

### 外部 OpenAI-compatible 服务

```sh
adp config set service openai-compatible --agent dimagent
adp config set baseUrl 'https://your-provider.example/v1' --agent dimagent
adp config set model 'your-model-id' --agent dimagent
adp config set apiKeyEnv PRESENCE_API_KEY --agent dimagent
```

端点需接受 `/chat/completions` 和 JSON object 响应格式。远程端点需要 HTTPS；本地无认证服务可使用 localhost HTTP 并将 `apiKeyEnv` 设为空字符串。配置只保存环境变量名称，不保存 key。

对 Codex、Claude Code、OpenCode、Pi、旧版 DimAgent 及 Harness 外部摘要，key 需在 **ADP daemon** 的环境中。Dim Rust 的外部摘要在其原生插件中执行，key 需在 **Dim daemon** 的环境中。变更环境变量后重启对应进程。

恢复跟随会话时，将 `service` 设为 `session`，并把 `model`、`provider` 设为空字符串；如果原本没有更高层覆盖，也可 `unset` 对应字段。

### 数据与持久化

完成摘要最多使用 4,000 个字符的助手正文，排除推理和工具内容。旧版 DimAgent 的早期目标标题另使用最多 2,000 个字符的过滤后用户请求。其元数据和 export 读取范围比最终传给模型的文本更大，详见旧版接入部分。

源正文不写入 ADP 会话状态或 status 输出，排队中的正文在处理后丢弃。选定的模型服务会收到摘要输入；原生 CLI 可能保留自己的历史和日志，特别是旧版 DimAgent 辅助会话与 OpenCode summary 会话。摘要也会消耗模型用量。提示词和常见字段过滤不能保证所有私密信息都被语义脱敏。

生成的摘要只保存在 ADP 内存中；重启服务后由后续回复重新产生。模型失败时保留原有标题和生命周期显示。CLI worker 的计数与诊断可见于 `adp status`；Harness 和 Dim Rust 的原生辅助任务由各自插件管理。

<a id="display"></a>
## 图标与显示

默认卡片标题为摘要 `topic`，详情为生命周期状态，第三行为 `subtitle`，计时器显示观察到的会话起点。缺少摘要时使用 `Coding with AGENT` 等默认文字。

```sh
adp config set presence.name '{agent}: {topic}' --agent dimagent
adp config set presence.details '{phase} · {subtitle}' --agent dimagent
adp config set presence.state '与 Dim 一起写代码' --agent dimagent
```

可用模板为 `{topic}`、`{subtitle}`、`{agent}`、`{phase}`、`{state}`，只展开文本与按钮标签，URL 和 asset key 保持原值。

<a id="dim-alpha-icon"></a>
### Dim α 彩虹图标

这是可选的个人显示配置；安装适配器不会自动覆盖原始图标。图像在 Dim 绿色标志右下角加入彩虹 α，悬浮说明为 `Dim α`。该标记由本 fork 制作，用于区分 Rust alpha。

```sh
adp config set presence.assets.large_image 'https://raw.githubusercontent.com/weiuou/agent-discord-presence/c3a8ec3e5dc3c1532ad0da47d82195fff2193305/dim-rust-alpha-rainbow.png' --agent dimagent
adp config set presence.assets.large_text 'Dim α' --agent dimagent
```

<img src="https://raw.githubusercontent.com/weiuou/agent-discord-presence/c3a8ec3e5dc3c1532ad0da47d82195fff2193305/dim-rust-alpha-rainbow.png" width="96" alt="Dim α 彩虹图标">

该 PNG 位于本 fork 的独立资源分支 `codex/dim-alpha-icon`，上述 URL 固定到文件所在提交。也可使用自己的公开 HTTPS 图床或当前 Discord application 的 asset key。Discord 无法读取本机文件路径或 data URL。两代 Dim 共用该配置，若同时运行，也会使用相同图标覆盖。

### 其他显示字段

| 字段 | 用途 |
| --- | --- |
| `presence.assets.large_image` / `small_image` | 公开 HTTPS 图像或当前 application 的 asset key |
| `presence.assets.large_text` / `small_text` | 图标悬浮说明 |
| `presence.assets.large_url` / `small_url` | 图标链接 |
| `presence.name` / `details` / `state` | 标题、详情、第三行文本 |
| `presence.details_url` / `state_url` | 详情或状态链接 |
| `presence.type` | `0` Playing、`2` Listening、`3` Watching、`5` Competing |
| `presence.status_display_type` | 紧凑标签使用 `0` name、`1` state 或 `2` details |
| `presence.timestamps` | Unix 秒级 start/end；start 也支持 `"session"` |
| `presence.buttons` | 最多两个 `{label, url}` 按钮 |
| `presence.party` | party id 和 `[current, maximum]` 大小 |

链接使用 HTTPS。文本上限 128 个 Unicode 字符，按钮标签上限 32；展开后过长的模板会截断。将 `details`、`state`、`timestamps` 或 `assets` 设为 `null` 可隐藏相应部分；`buttons: []` 移除按钮。

```sh
adp config set presence.state null --agent dimagent
adp config set presence.assets null --agent dimagent
adp config unset presence.assets --agent dimagent
adp config unset presence --agent dimagent
```

`unset` 恢复继承值，修改显示不调用模型。有效设置通常约一秒内重新读取，再按 Discord 发送间隔更新，通常最多再等待五秒。

### 手动摘要

从 `status` 复制完整 key，再指定已经准备好公开的文本：

```sh
adp status
adp summary 'dimagent:SESSION_KEY' '适配 Dim 原生插件' '检查状态与摘要'
adp clear-summary 'dimagent:SESSION_KEY'
```

示例中的 `SESSION_KEY` 必须替换为真实 key 的后半部分，Rust 版包含 `rust:…`。标题必填、副标题可选，手动字段最长 120 个字符。手动摘要不延长会话存活期，也不改变会话选择优先级。

模型集成可使用包根导出的 `summaryTarget` / `publishSummary`；在生成前捕获目标，再提交校验过的 `{topic, subtitle}`。提示词构造器导出为 `agent-discord-presence/prompts`。

<a id="sessions"></a>
## 会话选择与清理

```sh
adp status
adp pin 'dimagent:SESSION_KEY'
adp unpin
```

未固定时，Working / Waiting 优先于 Error，再优先于 Idle；同一优先级选择最近发生状态变化的会话。心跳不会抢占选择顺序。计时包含观察到的空闲时间，不代表模型计费时间。

OpenCode、Pi、Harness 和 Dim Rust 属于进程内扩展，每 20 秒发送带 host PID 的心跳。进程退出或超过 90 秒没有心跳时清理；Session / 插件的正常关闭也会释放 reporter。ADP 重启后可在下一次心跳恢复状态。

Codex、Claude Code 和旧版 DimAgent 的命令 hooks 没有可信的常驻 host PID，依赖生命周期事件和静默超时，默认 30 分钟。长时间无事件的模型调用可能需要增大 `--stale-minutes`。

`idleMinutes` 只缩短**命令 hook 会话**的空闲保留时间，且不会超过总静默超时。Dim Rust 使用心跳租约，因此即使共享 `dimagent` 配置，也不使用这个空闲 hook 超时。摘要更新不会延长租约，窗口焦点不参与选择。

<a id="troubleshooting"></a>
## 排查问题

| 现象 | 检查项 |
| --- | --- |
| `adp` 仍是旧版本 | 检查 PATH；Windows 用 `Get-Command adp`，POSIX 用 `command -v adp`，再从此 fork 重新构建安装 |
| 无法连接服务 | 先启动 ADP，并确认客户端与服务使用相同 socket / 配置环境 |
| Discord 未连接 | 检查桌面客户端是否登录、IPC 是否可达、Application ID 是否有效 |
| Discord 已连接但无卡片 | 检查 `sessions`；执行真实 Agent 任务验证适配，不要只检查连接 |
| Dim 插件 pending | 检查 `dima runtime list` 和 `dima plugin list`，等待安装或处理 runtime 错误 |
| Windows Node runtime 退出 | 参照 alpha.19 的路径兼容步骤，并重启 Dim daemon |
| 状态正常但无摘要 | 检查 `enabled`、service、模型路由、登录状态和执行摘要进程的环境变量 |
| 图标缺失 | 确认 URL 可匿名返回 PNG，或 asset key 属于当前 application；再等待客户端刷新 |
| 旧版 DimAgent 导出失败 | 检查 `ADP_DIMAGENT_COMMAND` 与 `DIMCODE_HOME` 是否对应任务所在客户端 |
| 活动一直 Waiting / Idle | 检查该客户端 hook 契约的事件限制、是否收到新事件、是否已过期 |

错误配置可通过 `adp config show --agent NAME` 检查；配置文件损坏时 daemon 会在 `settingsError` 中报告。原生插件为避免干扰宿主会吞掉辅助调用异常，status 的 CLI 计数不覆盖所有插件内任务。

<a id="verification"></a>
## 开发与验证

```sh
npm run check
npm test
npm pack --dry-run
```

测试覆盖会话仲裁、过期事件、心跳租约、配置继承、IPC、hooks、适配器生命周期、摘要失效，以及模拟 Discord 的确认、重连和清理。2026-11-05 的当前修订在 Windows / Node 24.13.0 上运行了 62 项测试。测试数量会随修订变化。

隔离验证使用本地模型 fixture 与模拟 Discord，不需要真实模型 key：

```sh
node scripts/smoke-dim.mjs /absolute/path/to/Rust/dimcode
node scripts/smoke-dimagent.mjs /absolute/path/to/legacy/dim
node scripts/smoke-dimagent.mjs /absolute/path/to/legacy/dim --external
```

另有 `scripts/smoke-generation.mjs` 和 `scripts/smoke-discord.mjs`。前者使用已登录的模型客户端，可能产生模型用量；后者会短暂改变真实 Discord 活动，再清除。

| 范围 | 已有验证证据 |
| --- | --- |
| Dim Rust `0.1.0-alpha.19` / Windows x64 | 官方二进制跑通 runtime、插件加载、Working / Idle 与原生完成摘要；隔离模型及 Discord fixture |
| Dim Rust 的真实桌面显示 | 本机已连接真实 Dim 会话；Discord 实际显示摘要卡片和自定义彩虹 α 图标 |
| DimAgent 0.5.21 / Node 24.13.0 | 插件、hooks、目标标题、完成摘要和手动摘要通过隔离 CLI 验证 |
| Desktop 0.9.56 的 bundled CLI 0.5.20 | bundled CLI 的隔离流程通过，Desktop 加载代码已检查；不据此宣称完整 GUI 授权流程通过 |
| DeepSeek Harness | 对照 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` 的契约，模拟宿主与实际 ADP 服务验证；尚无完整客户端实测 |
| Codex | 当前环境有原生摘要实测记录及 IPC / hooks 测试 |
| Claude Code、OpenCode、Pi | 有适配契约与集成测试；当前 fork 记录中缺少各客户端完整实机验证 |

Dim Rust 接口参考为 `arcships/dim` 的 `43f2c84b516cead46b75a739843c48294aea6d50` 修订。客户端升级后应重新检查契约。上述实测记录是特定环境的证据，不能代表所有平台和账号组合。

新增适配器应通过 `emit` / `Reporter` 接入共享服务，避免在适配器里另外建立 Discord 连接。

```text
src/adapters/       各客户端适配器，含独立的 dim.ts
src/client.ts       IPC 客户端与心跳 reporter
src/daemon.ts       共享本地服务
src/store.ts        会话仲裁、固定和清理
src/discord.ts      Discord IPC
plugins/            可安装的客户端插件包装
prompts/            摘要提示词
presets.json        内置配置预设
test/               自动化验证
scripts/            实机与隔离 smoke 检查
```

## 来源与许可

基础实现来自 [LitoMore/agent-discord-presence](https://github.com/LitoMore/agent-discord-presence)，感谢原作者及贡献者。摘要表达方式也参考了原文档注明的 [Cola Discord Presence](https://github.com/LitoMore/cola-plugin-discord-presence)。本 fork 保留原版权声明和 [MIT License](LICENSE)，由 [weiuou](https://github.com/weiuou) 继续维护。
