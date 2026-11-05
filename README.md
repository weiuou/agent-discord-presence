# Agent Discord Presence · weiuou fork

把编程 Agent 的任务摘要、工作状态和会话时间显示在 Discord 中。多个 Agent 共用一个本地 ADP 服务，可以分别设置摘要模型、语言、图标和展示样式。

本仓库由 [weiuou](https://github.com/weiuou) 维护，基于 [LitoMore/agent-discord-presence](https://github.com/LitoMore/agent-discord-presence) 继续开发。这里的安装说明、适配范围和验证记录对应 **[weiuou/agent-discord-presence](https://github.com/weiuou/agent-discord-presence)** 的源码版本。

> 包名 `agent-discord-presence`、命令 `adp` 和配置目录沿用原项目。使用下面的源码安装步骤获取此 fork；直接安装 npm 上的同名包，得到的功能取决于该包的发布版本。

## 可以做什么

- 在 Discord 中显示正在工作、等待授权、空闲或错误状态，以及会话经过时间。
- 根据完成的助手回复生成简短标题和副标题，支持中文、自定义提示词和模型覆盖。
- 同时接入多个 Agent，自动选择当前活动会话，也可以手动固定会话。
- 为不同 Agent 分别配置摘要服务、图标、文字、计时器和链接。
- 接入旧版 DimAgent CLI / Desktop，以及开源 Dim Rust harness 的原生插件。
- 为旧版 DimAgent 显示任务开始时的目标标题与工具阶段；Rust 版支持原生完成摘要、分支隔离和并行授权等待。
- 通过现有显示配置启用可选的 **Dim α 彩虹图标**。

## 支持的 Agent

| Agent | 接入方式 | 安装说明 |
| --- | --- | --- |
| Dim Rust α（`dima`） | Dim 原生插件，使用 Session 事件和辅助模型服务 | [Rust 版接入](USAGE.md#dim-rust-alpha) |
| DimAgent TypeScript CLI / Desktop | 命令 hooks，配合匹配的 CLI 与数据目录 | [旧版接入](USAGE.md#dimagent-typescript) |
| Codex | hooks / 插件包装 | [Codex](USAGE.md#codex) |
| Claude Code | hooks / 插件包装 | [Claude Code](USAGE.md#claude-code) |
| OpenCode | 插件 | [OpenCode](USAGE.md#opencode) |
| Pi | 扩展 | [Pi](USAGE.md#pi) |
| DeepSeek Harness | Harness bundle / Cordis 插件 | [DeepSeek Harness](USAGE.md#deepseek-harness) |

具体客户端版本、已验证范围和限制见 [USAGE.md](USAGE.md#verification)。有适配代码不等于所有客户端版本都经过实机验证。

## 从这个 fork 安装

准备 Git、Node.js 22+ 和已经登录的 Discord 桌面客户端。Dim Rust 的插件运行环境还需满足 Dim 自身的 Node.js 要求。

```sh
git clone https://github.com/weiuou/agent-discord-presence.git
cd agent-discord-presence
npm ci
npm run build
npm install --global .
adp start -b
adp status
```

已有源码目录时，在该目录构建并安装即可。全局安装会占用 `adp` / `agent-discord-presence` 命令；如果之前安装过其他版本，请确认命令解析到当前 fork。

`adp status` 中 `discord: "connected"` 表示已连接 Discord。接好对应 Agent 的 hooks 或插件后，运行一个任务即可看到活动卡片。没有活动会话时，卡片为空属于正常情况。默认带有 Discord Application ID，无需 bot token。

使用开源 Dim Rust α 时，继续执行：

```sh
npm install --global dimcode-alpha@alpha
dima runtime config node --source system
dima runtime install node
dima plugin install "/absolute/path/to/agent-discord-presence/plugins/dim"
dima runtime list
dima plugin list
```

将路径换成此 fork 的真实目录。等待 Node runtime 为 `ready`、ADP 插件为 `running` 后启动 `dima`；首次使用需在 Dim 中登录或配置模型。Windows alpha.19 的路径兼容处理见 [接入指南](USAGE.md#dim-windows)。

停止 ADP：

```sh
adp stop
```

后台运行不会自动配置开机启动；重启电脑后需要再次启动 ADP。更多配置见 [完整使用指南](USAGE.md)。

## 常用设置

以下配置作用于两代 Dim 共用的 `dimagent` 配置项：

```sh
adp config set customPrompt '用简洁中文描述任务，区分正在进行和已完成。' --agent dimagent
adp config set enabled false --agent dimagent
adp config set enabled true --agent dimagent
adp config show --agent dimagent
```

关闭自动摘要后，生命周期状态仍然上报。图标和其他显示项可通过配置热更新，示例见 [Dim α 图标](USAGE.md#dim-alpha-icon) 和 [显示设置](USAGE.md#display)。

摘要会调用模型并产生相应使用量。助手正文、旧版 DimAgent 的目标文本，以及原生 CLI 的日志与历史行为，见 [摘要与数据流](USAGE.md#summaries)。

## 开发与验证

```sh
npm run check
npm test
npm pack --dry-run
```

新适配器应复用 ADP 的事件协议和本地服务。Dim Rust 适配位于独立插件层，复用 `dimagent` 标识；该适配未修改共享协议、会话存储或 Discord 连接逻辑。

问题反馈请提交到 [本 fork 的 Issues](https://github.com/weiuou/agent-discord-presence/issues)，并附客户端版本、安装方式和不含敏感信息的诊断。

## 来源与许可

原项目：[LitoMore/agent-discord-presence](https://github.com/LitoMore/agent-discord-presence)，感谢 LitoMore 及上游贡献者提供基础实现。本 fork 保留原项目的版权声明，继续使用 [MIT License](LICENSE)。

Dim 名称与原始标志来自 DimAgent；彩虹 α 图标是在原始标志基础上制作的版本标记。其他内置 Agent 图标的来源见 [使用指南](USAGE.md#presets)。
