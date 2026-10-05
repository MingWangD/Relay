# Relay：Agent 开发指南

本文件供修改 Relay 仓库的 coding agent 使用。先了解目标和约束，再定位模块；无需读取全部文档。用户明确要求优先于本文件，子目录存在 AGENTS.md 时同时遵循对应范围的说明。

## 开始工作

1. 查看 `git status --short`，保留已有修改、未跟踪文件及用户数据。不得用 reset、clean 或全仓库格式化清除已有工作。
2. 阅读 [README](README.md) 和 [文档索引](docs/README.md)。实现行为见 [REQUIREMENTS](docs/REQUIREMENTS.md)，当前验收事实见 [VALIDATION](docs/VALIDATION.md)。
3. 恢复工作前查看 [HANDOFF](HANDOFF.md)，重新检查进程、数据目录锁、项目工作区和成员身份。文档中的历史 PID、端口或状态不能直接用于操作。
4. 只修改本次需求涉及的模块；保持业务 HTTP 接口、SQLite 数据兼容及旧团队默认行为。

## 常用命令

在仓库根目录运行：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run macos:test
```

- Node.js 24+；Apple Silicon macOS。浏览器测试需要本机 Chrome；Swift 构建需要 Command Line Tools。
- 开发：`npm run dev`，后端修改需重启服务。
- 生产前端与本机服务：先 `npm run build`，再 `npm start`。
- 原生壳：`npm run macos:check`、`npm run macos:build`。
- 安装包：`npm run macos:package`、`npm run macos:smoke`。
- 单个 TypeScript 测试：`npx tsx --test test/<文件名>.test.ts`。
- `npm test` 和浏览器回归不调用真实模型。`native-smoke.ts`、`request-smoke.ts --inference` 会调用真实模型，可能产生费用；仅在需求已授权真实模型验收时执行。

按改动选择检查：服务／状态修改运行相关服务回归；客户端修改先构建再运行浏览器回归；Swift／导入修改运行 `macos:test`，生命周期或打包修改加原生构建与 smoke。文档修改检查链接、命令、版本、隐私及事实一致性，无需重跑模型。详细步骤见 [TESTING](docs/TESTING.md)。

## 代码地图

| 位置                                                          | 职责                                                |
| ------------------------------------------------------------- | --------------------------------------------------- |
| `src/client/main.ts`、`style.css`                             | 桌面对话、导航、成员配置、折叠终端                  |
| `src/client/reading.ts`、`src/server/conversations.ts`        | 安全 Markdown、稳定阅读节点、聊天身份               |
| `src/server/collaboration.ts`                                 | 需求队列、计划、分工、检查、评审、汇总              |
| `src/server/snapshot.ts`、`git.ts`                            | 当前磁盘快照、独立工作区、整合与回写                |
| `src/server/service.ts`、`runtime.ts`、`auth.ts`              | 服务操作、真实 CLI、会话凭据与接续                  |
| `src/server/http.ts`、`mcp.ts`                                | 用户 HTTP／WebSocket 与 Agent MCP 接口              |
| `src/server/models.ts`、`claude-environment.ts`               | 模型目录与桌面 Claude 环境解析                      |
| `src/server/local-picker.ts`、`local-projects.ts`             | 本机选目录、独立项目空间及服务生命周期              |
| `src/server/store.ts`、`src/shared/types.ts`                  | SQLite 持久化、迁移默认值与共享类型                 |
| `src/server/terminal-screen.ts`、`src/shared/presentation.ts` | 当前终端画面、审批与状态文案                        |
| `macos/RelayApp/`                                             | AppKit／WKWebView、菜单、导入、Node 子进程、Sparkle |
| `test/`、`test/browser/`                                      | 服务、Git 文件保护、浏览器夹具回归                  |
| `scripts/`                                                    | CLI 联测、公开导出、打包、许可及发布流程            |

架构和进程边界见 [ARCHITECTURE](docs/ARCHITECTURE.md)，界面规范见 [DESIGN](docs/DESIGN.md)。

## 必须保持的行为

### 平台与生命周期

- 产品仅为 macOS 桌面、本机、单用户；每个项目空间绑定一个 Git 项目。当前安装包边界 macOS 13.5+、arm64；Swift 壳目标 13+ 不能代表整个安装包支持 13.0。
- AppKit 管理窗口、菜单、生命周期与内置 Node；WKWebView 只渲染被允许的本机 Relay origin。外部链接交系统浏览器，拒绝未知本地端口与 file URL。
- App 通过随机端口和私有 ready 文件连接内置服务，不复用固定开发端口；退出须停止主／子项目服务、PTY 并清理 ready／锁。
- `npm start` 默认 `.local` 与端口 4317；App 默认 `~/Library/Application Support/Relay`。同一数据目录只启动一个服务；隔离验收使用独立数据目录和新建 Git 项目。
- 项目选择只允许用户认证。原生桥校验主框架和已授权 origin；返回值不缓存控制台凭据。切换项目不调用模型，不覆盖原项目或跨项目复制原生 ID。

### 会话、任务与权限

- 每个聊天独立成员身份与设置，共享项目串行队列。成员原生 ID 和启动目录固定；召集、任务、消息、评审及后续需求明确接续。
- 不使用最近会话、fork、恢复失败后隐式新建或新增成员时重建已有会话。凭据可轮换，原生 ID 不变；任务状态以持久化结构化事件为准。
- 新团队默认完全访问，缺失权限字段的旧团队保留原生审批。只修改 Relay 子进程，不改全局账号、模型、代理和权限。
- 完全访问包含项目外文件；worktree 与回写检查不构成强制沙箱。分析依赖文件审计，不能宣称强制只读。
- 执行、排队、检查或待恢复时禁止改团队。Agent 消息不能代替用户提升权限；登录、风险声明、系统授权和组织限制保留人工入口。
- Anti 使用完整模型 ID，不单独传 effort。Claude Hook 的连接重试、身份校验与完成状态分开处理；重试不意味着重新派单或任务完成。

### 文件与回写

- 快照包含需求开始时的未提交、未忽略文件；原项目 HEAD、分支、暂存区和已有改动必须保留。
- 外部项目测试前重新记录磁盘／HEAD／分支／暂存区基线；只在新建隔离 Git 项目做默认真实联测。
- 代码成果经独立检查、非作者评审（单成员如实说明无交叉评审）和候选整合后才回写。遇人工修改、路径碰撞或冲突暂停，不能强制覆盖。
- 分析只交报告和文件依据，不能虚构代码提交或测试。未识别测试入口时明确“未执行自动测试”。
- 改调度、身份接续、快照、导入或回写时，优先覆盖持久状态和真实文件保护；失败证据保留。

### 界面与记录

- 主界面保持对话式；任务、成员交流与真实终端在需求下默认折叠，不引入手工角色、人工计划批准或任务表单。
- 阅读完全手动；状态更新不能抢焦点、关闭交流区或自动滚动。最终结论在协作区下方，安全渲染 Markdown 并保留原文。
- 归档／删除要求无执行、排队、检查或待恢复。删除需用户确认，只删除 Relay 记录，不删除项目或 CLI 全局历史。
- 数据导入由用户明确触发，先备份；不自动复制开发数据，不自动恢复旧任务。

## 文档与发布

- 根目录放产品、贡献、安全、Agent 和交接入口；专项说明放 `docs/`，GitHub 表单放 `.github/`。更新现有事实，不积累重复旧版文档。
- 不提交 `.local/`、用户数据库、CLI 凭据、ready token、私有日志、原始截图或本机绝对路径。私有交接不能直接进入公开仓库；使用 `export-public.mjs` 白名单与审计。
- 版本和 build number 单调递增。公开标签与资产不可覆盖；文档可单独更新 main。当前 0.1.3 是 ad-hoc、未公证、关闭自动更新的预览版。
- 正式发布须分别核对 arm64、实际最低系统版本、Developer ID、公证、DMG 校验和签名 appcast；无发布凭据不得启用生产更新或声称完成正式发布。EdDSA 私钥仅存发布机／CI Secret，App Resources 不含凭据、`.env` 或 SQLite 日志。
- 交付说明改动、实际检查、结果和未验收边界。夹具、真实 CLI、原生手工和干净机器证据分开记录；未运行的检查不得写“通过”。

贡献流程见 [CONTRIBUTING](CONTRIBUTING.md)，预览发布见 [RELEASING](docs/RELEASING.md)。不要将个人机器的 skill 路径或工具偏好写入公共 Agent 指南。
