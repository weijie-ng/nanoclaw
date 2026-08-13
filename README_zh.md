<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  一个将智能体安全运行在独立容器中的 AI 助手。轻量、易于理解，并可根据您的需求完全定制。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">文档</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="README_ko.md">한국어</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## 关于本 fork

这是 [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) 的一个 fork，持续跟踪上游 `main`，并在其之上增加了：

- **话题智能体（topic agents）** — 智能体可以在自己所在的聊天旁边新开一个话题，并把一个*新的*智能体放进去，只需一次 `spawn_topic_agent` 调用：话题、智能体组、接线，以及让同一批人能与它对话的访问权限，全部由宿主机一步创建完成。它是为 Telegram 论坛型超级群组写的，但唯一依赖的平台能力是 `adapter.createThread`。详见 [docs/topic-spawn.md](docs/topic-spawn.md)。
- **实时进度** — 当一轮对话运行数秒仍未结束时，宿主机会发出一条一次性消息，显示智能体当前的推理行、最近的工具调用和已用时间，并在这一轮进行期间不断编辑它，等真正的回复送达时将其删除。它永远不在关键路径上：任何失败路径都只会退化为「没有进度消息」，而不会导致投递失败。详见 [实时进度](docs/architecture.md#live-progress)。
- **预装 Telegram** — 适配器已包含在本代码树中，无需再运行 `/add-telegram`；并在其之上增加了论坛话题路由、回复机器人即触发，以及输入状态（typing）修复。

本 README 的其余部分来自上游，仅把 clone 地址指向了本 fork。

## 我为什么创建 NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) 是一个令人印象深刻的项目，但我无法安心使用一个我不了解、却能访问我个人隐私的复杂软件。OpenClaw 有近 50 万行代码、53 个配置文件和 70+ 个依赖项。其安全性是应用级别的（白名单、配对码），而非真正的操作系统级隔离。所有东西都在一个共享内存的 Node 进程中运行。

NanoClaw 用一个您能轻松理解的代码库提供了同样的核心功能：一个进程，少数几个文件。智能体运行在具有文件系统隔离的独立 Linux 容器中，而不是仅靠权限检查。

## 快速开始

```bash
git clone https://github.com/weijie-ng/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh` 会把您从一台全新机器一直带到一个可以直接发消息的命名智能体。它会在缺失时安装 Node、pnpm 和 Docker，向 OneCLI 注册您的 Anthropic 凭据，构建智能体容器，并配对您的第一个渠道（iMessage、Telegram、Discord、WhatsApp 或本地 CLI）。如果某一步失败，会自动调用 Claude Code 进行诊断并从中断处继续。

<details>
<summary><strong>从 NanoClaw v1 迁移？</strong></summary>

在您的 v1 安装旁边全新检出一份 v2，然后在其中运行：

```bash
git clone https://github.com/weijie-ng/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash migrate-v2.sh
```

`migrate-v2.sh` 会找到您的 v1 安装（同级目录，或 `NANOCLAW_V1_PATH=/path/to/nanoclaw`），把状态迁移进 v2 检出目录，然后 `exec` 进入 Claude Code 完成需要判断的部分（写入 owner、共享记忆迁移、fork 定制的重放）。

请直接运行该脚本，不要在 Claude 会话里运行——确定性的那一半需要交互式提示和真实的 shell I/O 来完成 Node/pnpm 引导、Docker、OneCLI 以及容器构建。

**它会做什么：** 合并 `.env`，用 `registered_groups` 播种 v2 数据库，复制群组文件夹 + 会话数据 + 计划任务，安装您选择的渠道适配器，复制渠道认证状态（包括 WhatsApp 的 Baileys 密钥库——LID 映射现在由 Baileys v7 适配器逐条消息解析，不再迁移），并构建智能体容器。

**它不会做什么：** 切换系统服务。您可以在提示时选择 *"switch to v2"*，或者在测试之后手动切换——您的 v1 安装不会被改动。

有哪些变化见 [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md)，开发笔记见 [docs/migration-dev.md](docs/migration-dev.md)。

</details>

## 设计哲学

**小到可以理解。** 单一进程，少量源文件，无微服务。如果您想了解完整的 NanoClaw 代码库，直接让 Claude Code 给您讲一遍就行。

**通过隔离实现安全。** 智能体运行在 Linux 容器中，只能看到明确挂载的内容。Bash 访问是安全的，因为命令在容器内执行，而不是在您的宿主机上。

**为个人用户打造。** NanoClaw 不是一个单体框架，而是能精确匹配每个用户需求的软件。它被设计成量身定制的，而不是臃肿膨胀。您创建自己的 fork，让 Claude Code 按您的需求修改它。

**定制 = 修改代码。** 没有配置膨胀。想要不同的行为？改代码。代码库小到改动是安全的。

**AI 原生，混合式设计。** 安装与上手流程走的是经过优化的脚本路径，快速且确定。当某一步需要判断（安装失败、引导决策、定制化）时，控制权会无缝地交给 Claude Code。安装之后也不提供监控仪表盘或调试 UI：您在聊天中描述问题，Claude Code 来处理。

**技能优于功能。** 主干只发布注册表和基础设施，不包含具体的渠道适配器或替代智能体提供者。各个渠道（Discord、Slack、Telegram、WhatsApp……）放在长期存在的 `channels` 分支上；替代提供者（OpenCode、Ollama）放在 `providers` 分支上。您运行 `/add-telegram`、`/add-opencode` 等，技能会把您所需要的模块精确地复制到您的 fork 里。不会出现您没要求的功能。

**最强的 harness，最强的模型。** NanoClaw 通过 Anthropic 官方的 Claude Agent SDK 原生使用 Claude Code，所以您能用上最新的 Claude 模型以及 Claude Code 的完整工具集——包括修改和扩展自己的 NanoClaw fork 的能力。其他提供者是可插拔选项：`/add-codex` 对应 OpenAI 的 Codex（ChatGPT 订阅或 API key），`/add-opencode` 通过 OpenCode 接入 OpenRouter、Google、DeepSeek 等，`/add-ollama-provider` 用于本地开源权重模型。提供者可按智能体组单独配置。

## 功能支持

- **多渠道消息** — WhatsApp、Telegram、Discord、Slack、Microsoft Teams、iMessage、Matrix、Google Chat、Webex、Linear、GitHub、WeChat，以及通过 Resend 的邮件。按需通过 `/add-<channel>` 技能安装。可同时运行一个或多个。
- **灵活的隔离模式** — 可为每个渠道配一个独立智能体以获得完全隐私，也可让一个智能体在多个渠道上共享、统一记忆但会话独立，或者把多个渠道合并到一个共享会话里，让一场对话横跨多个入口。通过 `/manage-channels` 按渠道选择。详见 [docs/isolation-model.md](docs/isolation-model.md)。
- **每个智能体的独立工作区** — 每个智能体组都有自己的 `CLAUDE.md`、自己的记忆、自己的容器，以及您允许的挂载点。除非您明确接线，否则不会有东西越过边界。
- **计划任务** — 由智能体执行的周期性作业，可选配[脚本门控](docs/scheduled-tasks.md)，在没有实际工作时避免唤醒它。
- **网络访问** — 搜索和抓取网页内容。
- **容器隔离** — 智能体在 Docker 容器中沙箱化运行（macOS/Linux/WSL2）。
- **凭据安全** — 智能体不持有原始 API key。出站请求经由 [OneCLI 的 Agent Vault](https://github.com/onecli/onecli)，在请求时注入凭据，并按每个智能体执行策略和速率限制。
- **智能体模板** — 通过 `ncl groups create --template <ref>` 从可复用的模板包一键生成一个开箱即用的智能体（指令 + MCP 工具 + 技能，不含密钥）。模板从本地 `templates/` 目录加载；您可以手工添加，也可以从[公共模板库](https://github.com/nanocoai/nanoclaw-templates)复制。详见 [docs/templates.md](docs/templates.md)。

## 账号，以及什么会离开您的机器

NanoClaw 没有用户账号。它唯一会上报的是匿名的安装诊断信息，
`NANOCLAW_NO_DIAGNOSTICS=1` 可以关闭。您的智能体、消息、文件和密钥
永远不会离开您的机器。

只有一个需要您主动选择的例外：您可以[获取预构建的智能体镜像](docs/hardened-image.md)，
而不是在本地构建。获取我们提供的镜像需要一个免费账号，因此我们会看到您的邮箱地址
以及您请求镜像的时间——不包含任何关于您智能体的信息，镜像下发之后也不再有任何信息。
本地构建不需要账号，也不联系任何服务，并且是默认方式。

## 使用方法

用触发词（默认为 `@Andy`）与您的助手对话：

```
@Andy 每个工作日早上 9 点给我发一份销售渠道概览（可以访问我的 Obsidian vault 文件夹）
@Andy 每周五回顾过去一周的 git 历史，如果与 README 有出入就更新它
@Andy 每周一早上 8 点，从 Hacker News 和 TechCrunch 收集 AI 相关资讯，给我发一份简报
```

在您拥有或管理的渠道里，还可以管理群组和任务：
```
@Andy 列出所有群组里的计划任务
@Andy 暂停周一简报任务
@Andy 加入"家庭聊天"群组
```

## 定制

NanoClaw 不用配置文件。想改就直接告诉 Claude Code：

- "把触发词改成 @Bob"
- "以后回答请更简短、更直接"
- "我说早上好的时候加一个自定义问候"
- "每周保存一次会话摘要"

或者运行 `/customize` 进行引导式修改。

代码库足够小，Claude 可以安全地修改它。

## 贡献

**不要加功能，要加技能。**

如果您想添加新的渠道或智能体提供者，不要把它加到主干上。新的渠道适配器进入 `channels` 分支；新的智能体提供者进入 `providers` 分支。用户在自己的 fork 上运行 `/add-<name>` 技能，由技能把相关模块复制到标准路径、接好注册、固定依赖版本。

这样主干始终保持为纯粹的注册表和基础设施，每个 fork 也都保持精简——用户只获得他们要求的渠道和提供者，其它什么也不会混进来。

### RFS（技能征集）

目前没有正在征集的渠道或提供者技能——欢迎通过 issue 提出。

## 系统要求

- macOS 或 Linux（Windows 通过 WSL2）
- Node.js 20+ 和 pnpm 10+（安装脚本会在缺失时自动安装）
- [Docker Desktop](https://docker.com/products/docker-desktop)（macOS/Windows）或 Docker Engine（Linux）
- [Claude Code](https://claude.ai/download)，用于 `/customize`、`/debug`、安装过程中的错误恢复以及所有 `/add-<channel>` 技能

## 架构

```
消息应用 → 主机进程（路由器） → inbound.db → 容器（Bun、Claude Agent SDK） → outbound.db → 主机进程（投递） → 消息应用
```

单一 Node 主机编排每个会话的智能体容器。当一条消息到来时，主机按实体模型（用户 → 消息组 → 智能体组 → 会话）进行路由，写入该会话的 `inbound.db`，并唤醒容器。容器内部的 agent-runner 轮询 `inbound.db`，运行智能体，并把响应写入 `outbound.db`。主机轮询 `outbound.db`，通过渠道适配器投递回去。

每个会话两个 SQLite 文件，每个文件只有一个写入者——没有跨挂载的锁争用，没有 IPC，没有 stdin 管道。渠道和替代提供者在启动时自注册；主干提供注册表和 Chat SDK 桥接，而适配器本身在每个 fork 里通过技能安装。

完整架构说明见 [docs/architecture.md](docs/architecture.md)；三级隔离模型见 [docs/isolation-model.md](docs/isolation-model.md)。

关键文件：
- `src/index.ts` — 入口：数据库初始化、渠道适配器、投递轮询、sweep
- `src/router.ts` — 入站路由：消息组 → 智能体组 → 会话 → `inbound.db`
- `src/delivery.ts` — 轮询 `outbound.db`，通过适配器投递，处理系统动作
- `src/host-sweep.ts` — 60 秒 sweep：失效检测、到期消息唤醒、循环任务
- `src/session-manager.ts` — 解析会话，打开 `inbound.db` / `outbound.db`
- `src/container-runner.ts` — 为每个智能体组启动容器，OneCLI 凭据注入
- `src/db/` — 中心数据库（用户、角色、智能体组、消息组、接线、迁移）
- `src/channels/` — 渠道适配器基础设施（适配器通过 `/add-<channel>` 技能安装）
- `src/providers/` — 主机侧提供者配置（`claude` 内置，其他通过技能安装）
- `container/agent-runner/` — Bun 版 agent-runner：轮询循环、MCP 工具、提供者抽象
- `groups/<folder>/` — 每个智能体组的文件系统（`CLAUDE.md`、技能、容器配置）

## FAQ

**为什么用 Docker？**

Docker 提供跨平台支持（macOS、Linux、Windows via WSL2）和成熟的生态。

**我可以在 Linux 或 Windows 上运行吗？**

可以。Docker 是默认运行时，可在 macOS、Linux 以及 Windows（通过 WSL2）上工作。运行 `bash nanoclaw.sh` 就行。

**这个项目安全吗？**

智能体运行在容器里，而不是躲在应用级权限检查之后。它们只能访问明确挂载的目录。凭据不会进入容器——出站 API 请求通过 [OneCLI 的 Agent Vault](https://github.com/onecli/onecli) 在代理层注入认证，并支持速率限制和访问策略。您仍然应该审查自己要运行的代码，但代码库小到您真的能做到。完整的安全模型见 [安全文档](https://docs.nanoclaw.dev/concepts/security)。

**为什么没有配置文件？**

我们不想让配置泛滥。每位用户都应该定制 NanoClaw，让代码精确地做他们想要的事，而不是去配置一个通用系统。如果您更喜欢有配置文件，可以让 Claude 给您加。

**我可以使用第三方或开源模型吗？**

可以。推荐做法是 `/add-opencode`（通过 OpenCode 配置接入 OpenRouter、OpenAI、Google、DeepSeek 等）或 `/add-ollama-provider`（通过 Ollama 使用本地开源权重模型）。两者都可以按智能体组单独配置，所以同一套安装里不同的智能体可以运行在不同的后端上。

对于一次性实验，任何 Claude API 兼容的端点也可以通过 `.env` 使用：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**我该如何调试问题？**

问 Claude Code。"为什么计划任务没运行？""最近的日志里有什么？""为什么这条消息没有得到回复？"这就是 NanoClaw 底层的 AI 原生方式。

**为什么安装对我不成功？**

如果某一步失败，`nanoclaw.sh` 会把控制权交给 Claude Code 进行诊断并从中断处继续。如果还是没解决，运行 `claude`，然后 `/debug`。如果 Claude 发现一个可能影响其他用户的问题，请对相关的安装步骤或技能提 PR。

**如何卸载 NanoClaw？**

```bash
bash nanoclaw.sh --uninstall
```

每份安装都带有一个按检出目录生成的 id，因此卸载程序只会移除属于这一份副本的东西：后台服务、容器和镜像、应用数据和日志、您智能体的文件，以及这份副本在 OneCLI vault 里的智能体。共享的东西——OneCLI 应用和您的凭据、机器上其它的 NanoClaw 副本——都会保留。它会明确列出找到的内容，并逐个群组请求确认；在您同意之前不会删除任何东西。用 `--dry-run` 可以预览而不做任何改动，用 `--yes` 可以跳过确认。`.env` 会在移除前备份。最后再删掉检出目录本身即可。

**什么样的更改会被接受进代码库？**

进入基础配置的只会是：安全修复、bug 修复、明显的改进。仅此而已。

其他一切（新能力、操作系统兼容、硬件支持、增强）都应作为技能贡献：渠道和提供者代码进入 `channels`/`providers` 注册表分支，其余的作为自包含技能。详见 [docs/customizing.md](docs/customizing.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。

这样基础系统保持最小化，每位用户都可以定制自己的安装，而不必继承他们不想要的功能。

## 社区

有问题或想法？欢迎[加入 Discord](https://discord.gg/VDdww8qS42)。

## 更新日志

破坏性变更见 [CHANGELOG.md](CHANGELOG.md)，或查看文档站上的[完整发布历史](https://docs.nanoclaw.dev/changelog)。

## 许可证

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
