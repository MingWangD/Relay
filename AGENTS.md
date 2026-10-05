# Relay：Agent 开发说明

这是给接手本仓库的 Agent 的工作入口。产品使用说明见 [README.md](README.md)，测试操作见 [docs/TESTING.md](docs/TESTING.md)，当前验收事实见 [docs/VALIDATION.md](docs/VALIDATION.md)，交接状态见 [HANDOFF.md](HANDOFF.md)。用户需求优先于本文件。

## 产品边界

- Relay 是 macOS 桌面、本机、每个项目空间单项目的对话式多 Agent 控制台，产品目标为可独立启动的 Mac App。用户选择项目、Agent 类型／数量、成员模型／思考强度和团队权限，然后输入需求；团队自行协商、分工、评审和汇总。
- 发布目标固定为 macOS 13+、Apple Silicon `arm64`。桌面壳使用 Swift AppKit + WKWebView；不增加 iOS、iPadOS、Android、Windows 或 Linux 目标，也不引入跨平台 UI 分支。
- AppKit 管理窗口、菜单、生命周期和子进程；WKWebView 只渲染本机 Relay origin；内置 Node 运行时承载当前服务、Agent 生命周期、PTY、终端、快照、项目空间和权限逻辑。用户不需要另行安装 Node。
- Sparkle 2 负责签名的自动更新、appcast 和版本说明。没有 Developer ID 或 Sparkle EdDSA 发布密钥时只能生成 unsigned 开发构建，不能声称可公证发布或启用生产更新。
- 每个 Relay 聊天拥有独立成员身份及设置，共享项目串行队列。每名成员的原生 ID 和启动目录固定，全阶段及后续需求明确接续；不能使用最近会话、fork 或恢复失败后新建。新增成员不重建已有会话。
- 主界面保持简洁。子任务、消息、真实 CLI 终端放在每项需求下默认折叠的“查看协作过程”中；不要重新引入角色分配、人工计划批准或任务表单。
- 任务状态以持久化结构化事件为准。终端文本和动画不能单独证明投递、执行或验收成功。
- 用户可选择团队“完全访问”或“原生审批”；新团队默认完全访问，缺少字段的旧团队保留原生审批。只设置 Relay 子进程，不修改全局账号、代理和权限。完全访问包含项目外文件，worktree 和回写检查不限制 Agent 直接操作其他目录；分析靠文件审计验收，不声称强制只读。
- 原生审批按 CLI 流程处理；登录、风险声明、系统授权、组织策略及用户问题等残留提示保留入口。Agent 消息不能代替用户改变权限；执行、排队或恢复期间禁止改团队设置。

- 阅读完全手动；更新不能关闭成员交流、抢焦点或自动定位。最终结论位于协作区下方，安全渲染 Markdown，保留原文。
- 归档／删除要求无执行、排队、检查或待恢复事项；删除需确认，仅删除 Relay 记录，不删除项目或原生全局历史。
- Anti 使用完整模型 ID，不单独传 effort。Claude 工具 Hook 与当前身份校验分开处理连接重试和完成。保留 外部项目，不修改外部项目或全局配置。

## 代码地图

| 位置                                                   | 职责                                                 |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `src/client/main.ts`、`style.css`                      | 全窗桌面对话、聊天历史、手动阅读、成员配置和折叠终端 |
| `src/client/reading.ts`、`src/server/conversations.ts` | 安全结论排版、稳定节点与聊天身份边界                 |
| `src/server/collaboration.ts`                          | 需求队列、团队协调、计划、调度、评审、验证与最终答复 |
| `src/server/snapshot.ts`、`git.ts`                     | 当前磁盘快照、独立工作区、成果整合与安全回写         |
| `src/server/service.ts`、`runtime.ts`                  | 服务操作、真实 CLI 生命周期、权限和恢复              |
| `src/server/http.ts`、`mcp.ts`                         | 用户 HTTP/WebSocket 与 Agent MCP 接口                |
| `src/server/models.ts`、`terminal-screen.ts`           | 模型目录、当前终端画面与原生提醒                     |
| `src/shared/presentation.ts`                           | 可读审批摘要与状态文案                               |
| `src/server/store.ts`、`src/shared/types.ts`           | SQLite 持久化、旧数据默认值和共享类型                |
| `test/`、`test/browser/`                               | 服务／Git 保护与浏览器交互测试                       |
| `macos/RelayApp/`                                     | Swift AppKit 壳、WKWebView、Node 子进程和 Sparkle 配置 |
| `scripts/package-macos.mjs`、`scripts/appcast.mjs`、`scripts/release-check.mjs` | arm64 `.app`、DMG、appcast 和发布前检查 |

## 开发与验证

在仓库根目录执行：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm start` 使用 `.local` 数据目录并默认监听 `127.0.0.1:4317`。同一数据目录只允许一个服务；已有服务运行时不要再启动第二个。服务同时支持 `--port`、`--data-dir`、`--ready-file`（以及对应环境变量），桌面壳通过随机本地端口和私有 ready 文件握手。ready 文件只写入内存 token 的短生命周期 JSON，服务退出时删除；token 不得写入日志、文档或崩溃报告。浏览器启动方式仍使用带 `#token=` 的完整链接。

打包 App 使用 `~/Library/Application Support/Relay`，开发模式仍使用仓库内 `.local`。App 启动时先启动自己的内置 Node 服务，退出时优雅停止服务和 PTY；不复用固定端口，也不自动导入开发数据。导入已有数据必须由用户明确触发并先备份。窗口、全屏和原生菜单由 AppKit 保存，外部链接由系统浏览器打开；未知页面不得导航进 WKWebView。

`scripts/request-smoke.ts --inference` 与 `--inference --task` 会调用真实模型，并在新建的隔离 Git 仓库联测；`scripts/native-smoke.ts` 同样调用真实模型，用于单 CLI 生命周期与接续检查。浏览器测试使用夹具，只证明 UI 行为。命令与验收步骤见 [docs/TESTING.md](docs/TESTING.md)。

## 修改约束

- 修改前查看 `git status`；保留已有未提交改动。测试任何外部项目前重新记录其磁盘、HEAD、分支和暂存区基线，不依赖文档中的历史快照；外部项目 不是默认测试前提。
- 快照包含需求开始时的未提交、未忽略文件；原项目暂存区、HEAD、分支不得被平台改写。代码成果通过独立验证、评审、整合后才回写；遇人工修改或冲突时暂停。
- 分析需求只交报告和依据，不能虚构代码提交或测试通过。代码任务若未识别自动测试入口，应明确“未执行自动测试”，再给出人工验证命令。
- 服务重启后检查旧进程与工作区，显式恢复；不能盲目重跑。改变调度、快照或回写逻辑时，优先补覆盖真实状态和文件保护的测试。
- 交付时说明实际改动、执行过的检查及结果、未验收边界。真实模型证据与夹具结果分开记录。
- 根目录只放入口文档；专项规范放在 `docs/`。更新当前事实，移除过时说明和断链，不另存旧版文档；私有原始证据保留在 `.local/`，失败不能改写为通过。
- macOS 发布还必须检查 arm64 架构、最低系统版本、Developer ID 签名、公证、DMG 校验和 Sparkle appcast。版本号与 build number 单调递增；EdDSA 私钥只允许存在发布机或 CI Secret。App Resources 不得包含 token、CLI 凭据、`.env` 或 SQLite 原始日志。

项目入口：项目右侧“＋”使用 `local-picker.ts` 打开 macOS 文件夹选择器，`local-projects.ts` 为不同 Git 根目录创建独立控制台、凭据和数据库。不得覆盖原项目或跨项目复制原生 ID；选择不启动模型。主服务拥有子项目空间生命周期，关闭时一并停止。文件夹接口只接受用户认证，不缓存含控制台凭据的返回值。
