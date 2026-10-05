# Relay macOS App · 对话式 Agent 协作

**[下载 Relay 0.1.3 开发预览版](https://github.com/MingWangD/Relay/releases/tag/v0.1.3)** · [DMG](https://github.com/MingWangD/Relay/releases/download/v0.1.3/Relay-0.1.3-macos-arm64.dmg) · [App ZIP](https://github.com/MingWangD/Relay/releases/download/v0.1.3/Relay-0.1.3-macos-arm64.zip) · [SHA-256](https://github.com/MingWangD/Relay/releases/download/v0.1.3/SHA256SUMS.txt)

Apple Silicon（arm64），安装包最低要求 macOS 13.5。本轮实际原生验收环境为 macOS 26.4；macOS 13.5 实机和干净机器兼容尚未验收。

这是 ad-hoc 签名、未经 Apple 公证的开发预览版，自动更新关闭。首次打开可能被系统拦截；确认下载来源及校验值后，按 [Apple 官方说明](https://support.apple.com/en-us/102445) 在“系统设置 → 隐私与安全性”允许此 App。不要关闭系统全局安全保护。

安装：下载 DMG，打开后把 Relay 拖到 Applications，再从应用程序启动。也可解压 ZIP 后移动 Relay.app。App 内置 Node；Git 与所用的 Codex、Antigravity、Claude Code CLI 需自行安装并完成登录／服务配置。选择项目不会启动模型；发出需求后才调用 CLI，可能产生厂商模型费用。

源码及原创图标采用 [MIT](LICENSE)；分发组件许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。发布流程见 [RELEASING](docs/RELEASING.md)。

Relay 是面向 macOS 的本机、多 Agent 协作桌面 App。选择已有 Git 项目、CLI 类型、数量、成员模型／思考强度和团队权限，输入需求即可开始。团队自动规划、协商、分工、执行、验证、交叉评审和汇总；不要求用户命名 Agent、指定角色、填写子任务或批准内部计划。原生壳目标为 macOS 13+、Apple Silicon `arm64`；当前内置官方 Node 24 的开发安装包要求 macOS 13.5+，不支持 Windows、Linux、iOS、iPadOS 或 Android。

桌面版采用 Swift AppKit 原生壳和 Apple 官方 WKWebView：AppKit 管理窗口、菜单、快捷键、生命周期和 Node 子进程，WKWebView 承载现有 TypeScript + Vite 前端，内置 Node arm64 运行时和 Relay 服务。Codex 风格只参考公开的 CLI／App Server 架构边界，不复制 Codex 私有桌面实现、品牌资产或代码。Relay 继续保留 Codex、Antigravity、Claude、多 Agent 协作、项目空间、真实 PTY 终端、快照、审批和安全回写能力。

## Relay macOS 界面

- 左侧聊天与项目导航，顶部显示项目、Git 分支、工作区、成员数和本地连接状态。
- 中央是需求卡片、Agent 活动、成员交流、任务进展和最终结论时间线。
- 底部 composer 支持多行输入、当前项目／成员上下文、发送、停止、补充和排队。
- 需求内的协作过程默认折叠；真实终端支持双栏、四栏分页、放大、独立阅读和手动滚动，不用终端文本替代结构化任务状态。
- `⌘K` 打开命令面板，`⌘N` 新建聊天，`⌘⇧P` 选择项目，`⌘U` 检查更新；阅读历史不会自动跳到底部，Escape 关闭菜单或弹窗。

界面默认深色，支持浅色主题、键盘焦点和 reduced-motion。使用 macOS 系统字体与 SF Mono／Menlo，低圆角、细边框和克制阴影；终端保持高对比深色表面以避免 ANSI 颜色失真。

## 架构参考

Relay 参考公开的 [openai/codex](https://github.com/openai/codex) CLI、Rust 核心、SDK 和 App Server 边界，以及 OpenAI 对富客户端 App Server 的[架构说明](https://openai.com/index/unlocking-the-codex-harness/)。macOS 壳使用 Apple 的 [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview)；自动更新遵循 [Sparkle 2 文档](https://sparkle-project.org/documentation/) 的 appcast、Developer ID 和 EdDSA 签名流程。Relay 不复制 Codex 未公开的桌面实现、私有代码或品牌资产。

左侧提供未归档聊天历史：同页新建、切换、归档与删除；已归档对话在右上角菜单的独立管理界面查看、取消归档或删除；主区显示项目、Agent、更多、对话和输入框。需求下方的“查看协作过程”按需展开任务、成员交流和真实终端。聊天占满窗口、独立滚动；待处理请求固定在输入框上方，运行时显示暂停／继续、停止。新团队默认完全访问，仍保留无法跳过的原生确认入口。

## 本地启动

当前开发 App 为 **0.1.3／build 4**：内置 Node，双击 `dist-macos/Relay.app` 启动。原生标题栏支持拖动、缩放和全屏，`⌃⌘F` 进入／退出全屏；关闭最后一个窗口会退出并停止本地服务。项目选择器的系统栏目跟随本机语言，安装包已包含原创多节点图标。

Finder 启动时，Claude 模型目录和实际会话从当前用户登录 shell 补齐模型、服务地址、认证和配置目录；不会写入全局配置。系统保留的旧启动环境不会盖过当前 shell。直接启动 App 时显式环境优先；可用 `RELAY_CLAUDE_ENV_EXPLICIT=1` 显式保留启动环境，成员选择的模型最终优先。刷新模型目录会刷新 shell 缓存，读取超时保留回退入口。敏感值仅存在子进程内存。

环境：macOS、Node.js 24+、Git；至少一个已安装且已登录的 CLI。开发模式需要本机 Node，安装构建依赖后可运行前端和服务；发布的 `.app` 自带 Node，不要求用户另行安装。原生适配器实测边界见 [验收记录](docs/VALIDATION.md)。

```bash
cd <workspace>
npm ci
npm run doctor
npm run build
npm start
```

打开终端输出的 `http://127.0.0.1:4317/#token=…` 完整链接。不要删除链接中的 token。凭据保存在当前浏览器 sessionStorage，服务仅监听本机。关闭浏览器不会停止后台任务。

开发模式：`npm run dev`。前端热更新；修改后端需重启。macOS 原生壳和打包流程：

```bash
npm run macos:check   # 检查主机与必需资源，不生成安装包
npm run macos:build   # 构建 arm64 Relay.app（开发构建默认关闭自动更新）
npm run macos:package # 构建 arm64 Relay.app、DMG，并输出 SHA-256
npm run macos:test    # Swift 导入文件保护检查，无需 XCTest
npm run macos:smoke   # 检查安装包服务、真实 PTY、Hook 和退出；不调用模型
npm run macos:release-check # 检查正式签名、公证和 Sparkle 凭据
```

开发 App 位于 `dist-macos/Relay.app`，DMG 位于 `dist-macos/Relay-arm64.dmg`。打包使用校验 SHA-256 的官方 Node 24.21.0 arm64 运行时，独立安装生产依赖（含运行服务所需的 tsx），保留 Agent Hook、PTY helper 和 Sparkle 框架；不复制宿主机 node_modules 或 Homebrew 动态库。数据目录为 `~/Library/Application Support/Relay`；ready 文件单独写入私有临时位置，权限 0600，不放进 App Resources。首次启动不会覆盖或复制仓库 `.local`；需要时从原生菜单“文件 → 导入现有 Relay 数据”明确导入，导入前会生成备份，失败保留原目录。App 退出会停止自己的 Node 和 PTY 子进程，不会复用其他服务的固定端口。

Sparkle 2 通过 HTTPS appcast 提供版本检查、变更说明、稍后／跳过／更新选择。正式发布需要 Developer ID Application 签名、公证和 Sparkle EdDSA 私钥；当前脚本生成 ad-hoc 签名开发构建，不能作为 Developer ID 发布；占位更新源不会启动 Sparkle，界面检查更新会显示原生开发版提示。`RELAY_RELEASE=1` 会拒绝开发打包，正式签名、公证和更新发布流程仍待实现／验收。

可选环境变量：`PORT` 默认 4317；`RELAY_DATA_DIR` 指定绝对数据路径，默认仓库内 `.local`。每个项目空间只管理一个项目；默认空间在 `.local`，新增项目空间在 `.local/projects/<目录摘要>/`，由同一主服务管理独立数据库与本机端口。CLI 需要 Node 的启动环境继承 PATH。

桌面启动协议还支持 `--port`、`--data-dir`、`--ready-file` 和 `RELAY_READY_FILE`。ready 文件只用于 AppKit 与 Node 握手，包含协议版本、子进程 PID、本地 URL、实际端口和控制台 token；壳仅在内存保存握手凭据，不写日志。开发 App 可用 `RELAY_APP_DATA_DIR` 指定隔离数据目录；打包可用 `RELAY_NODE_RUNTIME` 指向自备 Node，脚本会检查 arm64、版本、系统下限和包外动态库。WKWebView 仅接受当前服务及由主服务认证的项目空间 origin，其他本地服务和 file URL 均不进入 App。

## 使用

1. 点击项目右侧“＋”，选择“在此电脑上选择文件夹”，在 macOS 原生选择器中选择项目文件夹。无需填写路径；取消保持原状态。项目必须已有 Git 提交，选择项目内子目录时使用 Git 根目录。
2. 点击“Agent”，选择工具类型和数量，总数 1–8。名称自动生成，Codex／Claude 每个成员独立选择模型与思考强度；Anti 选择包含强度的完整模型 ID，默认沿用 CLI 默认。团队仅空闲时可调整；执行、排队或恢复期间禁改。保存不调用模型，变化的空闲进程会停止，下次需求在原生会话 ID 内应用新设置；接续失败等待处理，不静默创建新对话。
3. 输入需求并发送，例如“审查本项目并说明功能”或“给登录接口补上输入验证”。Enter 发送，Shift + Enter 换行。
4. 运行期间输入内容默认补充当前需求。若要排队独立需求，在“更多”选择“下一条作为新需求排队”。同一项目一次执行一个用户需求。
5. 必要询问出现在对话中；在输入框回答。原生审批模式下，支持的 Codex 结构化请求提供可读批准／拒绝弹窗；未知请求、Antigravity／Claude 的原生提示提供固定提醒和终端入口。弹窗不显示协议 JSON、会话 ID 或内部 schema。提示识别只用于提醒，不判断任务成功。
6. 最终结论放在协作／终端区域下方，终端折叠时也可阅读；标题、列表、代码和安全链接正常排版，原文留存用于导出。有代码成果时提供“查看改动”；“更多”可导出报告、查看历史、切换主题和修改高级设置。

选择其他项目会在当前浏览器页进入独立项目空间，保留原项目聊天和后台任务；新项目复制当前团队设置，但成员身份和原生会话不混用。再次选择同一文件夹回到已有空间，重启后重新选择也保留历史。选择文件夹本身不启动 Agent 或调用模型。不自动初始化 Git。各项目独立排队和并发；停止主服务会停止其管理的全部项目空间。

默认并发最多 4，单轮执行上限 30 分钟。协调和评审同样占用并发席位。计划协商最多 3 轮，内部修复最多 3 次；超限显示阻塞。暂停停止新派发；停止会中断原生会话与正在运行的独立检查。服务重启后，未完成执行进入恢复等待，不盲目重跑；已结束需求的原生进程确认退出且无未知结果时自动清除残留恢复标记，可以归档。

## 聊天与原生历史

左栏宽 260px，可折叠。新聊天复制当前团队配置，为成员建立新身份；切换只改变阅读视图，不停止任务或调用模型。各聊天配置、草稿、展开状态与阅读位置独立，所有聊天共享项目串行队列与并发上限。待处理提醒显示在左栏和输入框上方。左侧只显示未归档历史。“更多 → 已归档对话”打开独立管理弹窗，支持搜索、归档时间排序、打开历史、取消归档，以及确认后单条或全部删除。归档可恢复；归档和删除需先结束执行、排队、检查及待恢复事项。删除再次确认，只删除 Relay 记录，不删除项目代码、工作区成果或 CLI 全局历史。

同一 Relay 聊天，每名成员固定一个原生会话 ID 和启动目录，召集、规划、沟通、任务、评审、汇总及后续需求全部接续。两名 Codex 各有一个原生会话。只有新聊天或首次新增成员创建原生会话；进程重启可轮换凭据与执行环境，但不更换原生 ID。恢复失败或 ID 不一致等待处理，禁止最近会话、fork 或隐式新建。

代码任务与非作者评审仍使用不同 Git 工作区；通过本阶段绝对路径、目录授权和指令访问，保留快照、文件审计、测试和安全回写。评审隔离成果文件与作者身份，使用评审者自己的持续会话；不宣称全新对话上下文。

Relay 记录保存在默认 `.local/relay.sqlite`。原生历史由 CLI 保存：

- Codex：默认 `~/.codex/sessions/`；使用自定义 CODEX_HOME 时以该目录为准。
- Antigravity CLI：`~/.gemini/antigravity-cli/conversations/<原生 ID>.db`，与 Antigravity 桌面端历史分开。
- Claude Code：默认 `~/.claude/projects/<编码后的固定启动目录>/<原生 ID>.jsonl`；自定义 CLAUDE_CONFIG_DIR 时以该目录为准。

旧 Relay 记录迁到“现有对话”，只绑定已经回报过的原生 ID 和目录。旧阶段创建的厂商历史继续保留，不伪造历史合并。

聊天完全手动滚动；消息、状态、任务投递和 Enter 更新不定位。点击“查看最新”才移动聊天视图。普通终端本地滚动；全屏终端通过受认证、只允许滚轮的通道访问原生历史。键盘和粘贴仍需人工接管。Claude 连接重试显示提醒，后续有效工具活动清除，不因此重复派单、自动重启或判定完成。

## 团队权限与模型

- **完全访问**：新团队默认。Agent 无需逐次批准即可读写当前用户可访问的文件、执行命令和联网，包括项目外文件。不能绕过 macOS 系统权限或组织策略。独立工作区与回写检查仍保留，但无法限制 Agent 直接操作其他目录。
- **原生审批**：使用原生 CLI 权限与沙箱流程。旧团队缺少权限字段时保留此模式；下次保存可主动切换。
- 选择只用于下一次 Relay 会话启动，当前会话不会自动提升权限。Codex 使用 thread 的 never/danger-full-access；Anti 使用 skip-permissions 且不强加 sandbox；Claude 使用 bypassPermissions/skip-permissions 并关闭本次可选工具沙箱。组织禁用和拒绝规则仍有效。
- Claude 首次完全访问可能显示原生风险声明，需打开终端并人工接管；登录、系统授权及用户问题也保留处理入口。Relay 不猜测按键替你确认。
- Codex 目录来自 model/list；Anti 来自 agy models；Claude 提供原生别名与已配置模型。界面只通过列表选择，列出 CLI 返回的全部选项，不提供自定义模型 ID 输入。目录失败显示原因和刷新入口，保留上次列表、默认或已保存模型；已保存但未在目录中的模型明确标注。未知模型能力交给 CLI 判断。
- 明确选择传入 Codex thread/turn、Claude --model/--effort；Anti 仅 --model 完整 ID，覆盖相应子进程设置；原生会话接续保持选择。终端区分所选设置与原生回报，别名可能解析成不同 ID，未回报不宣称生效。
- Anti 状态依据当前权限提醒、合法 MCP 活动与 Hook 分开记录；活动只证明执行协作工具。超过 30 秒无 Hook 或活动显示诊断提示，保留终端，不自动重启。有活动但缺少原生 ID 时明确提示接续尚未确认。

## 文件与成果

- 每项需求开始时使用独立 Git 索引创建当前磁盘文件的私有快照，包含未提交修改与未忽略的新文件。原项目 HEAD、分支和暂存区保持原样。
- `.env*`、常见凭据文件、依赖目录、Relay 数据与生成的 Hook 配置不进入快照。Git 子模块不支持。此排除表不能替代项目自己的 `.gitignore` 和凭据管理。
- 各内部任务使用独立 worktree；评审使用独立成果副本；下游从已整合的真实代码版本创建工作区。
- 分析任务只提交报告和文件依据；执行前后审计原项目与工作区文件、HEAD 和分支，提交及最终验收时发现修改即失败。审计排除 Git 元数据、依赖缓存、Relay 数据目录和 Relay Hook 文件，无法观察项目外写入或执行中被恢复的修改。完全访问下没有强制只读隔离；不制造 Git 提交，不将无测试说成通过。
- 代码任务提交成果时，由平台在隔离分支保存版本，无需 Agent 额外获取 Git 写权限；平台自动识别 npm 的 test/typecheck/build、Go 测试和 pytest.ini 入口，独立执行并保留命令、退出码、代码版本和日志。有 npm 锁文件且需要依赖时先运行 `npm ci --ignore-scripts`。其他工具链由团队处理；没有已识别入口时明确标记未执行自动测试。
- 平台检查运行可信本地项目脚本；独立进程与 Git 工作区隔离不构成恶意代码安全沙箱。
- 多成员成果由非作者评审；单成员由平台独立检查，明确标记没有交叉评审。代码在候选集成工作区再次验证后才推进集成版本。
- 验证与整合通过后，仅本次新增差异自动写回原目录；不自动暂存、提交或推送原项目。已有改动属于需求输入，不被撤销。
- 回写检查原分支、HEAD、涉及文件和路径碰撞。检测人工修改时保留成果、显示差异并等待处理。恢复后仍不允许强制覆盖人工修改。
- 回写前保存原文件备份与日志；失败撤回本次已写入文件。检测撤回期间人工修改时保留备份并停止，避免覆盖用户内容。进程中断后恢复回写会先检查日志和文件再处理。

## 真实 CLI 与通信

- **Codex**：真实 PTY TUI 连接本地受认证 App Server；thread/start、turn/start、turn/steer 提供结构化控制，显示面板对应实际 thread。
- **Antigravity**：真实 `agy` PTY、本地 token-free MCP 插件、PreInvocation/Stop 生命周期 Hook。空闲消息确认旧进程退出后，使用相同 conversation ID 接续；并非同进程无感注入。
- **Claude Code**：真实 PTY、单次 MCP/settings、SessionStart/UserPromptSubmit/Stop 与工具前后 Hook，使用明确 ID resume；继承本机账号、服务与代理。隔离代码协作、后续分析及原生历史滚动已通过，实际重试与验收边界见验收记录。

不依赖任意窗口焦点、模拟粘贴或屏幕文字判断完成。终端输出用于显示，任务状态以持久化结构化事件为准。折叠协作过程不会销毁终端；8 席位按 4 个终端分页。动画设置在高级设置；滚动始终手动，减少动态效果时自动关闭动画，不影响投递。

协作 MCP：`get_project_state`、`publish_plan`、`transfer_coordinator`、`ask_user`、`complete_request`、`send_message`、`ack_message`、`report_progress`、`submit_result`、`review_result`。整体计划采用版本校验、依赖环校验和原子更新；取消未完成项传 cancelKeys。请求身份与执行身份由服务器绑定；重复请求不重复执行。Agent 消息不能代替用户提升权限。

Antigravity 本地插件由 `agy plugin install` 安装，仅保存桥接代码路径，不写访问凭据；凭据随平台启动的会话继承。移动仓库后需重新安装插件。权限参数随团队选择，仅作用于 Relay 子进程，不修改全局账号、模型、代理或权限设置。CLI 自身的信任记录、风险声明仍按原生流程处理。

旧 SQLite 数据保留并补齐默认对话字段，旧任务不自动执行；人工计划接口仍兼容，新界面不提供这些表单。项目通过“＋”选择本机文件夹切换，旧 PTY 跨服务重新附着与公网协作尚不支持。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
# 以下调用真实模型，在新建隔离 Git 仓库执行，不修改用户项目：
npx tsx scripts/request-smoke.ts --inference
npx tsx scripts/request-smoke.ts --inference --task
# 可选：指定成员模型和强度；测试默认完全访问，--native 使用原生审批
npx tsx scripts/request-smoke.ts --inference --task --model-codex=gpt-6.1-sol --effort-codex=low --model-antigravity=gemini-3.8-flash-medium
# Claude 联测：--team=codex,claude；默认单次测试上限 10 分钟
```

真实联测脚本只在隔离测试会话确认具体目录信任、协作工具与受限文件读取、检查命令；审批一次，仅针对隔离夹具处理原生确认，不将测试中的处理逻辑接入产品。证据与原生输出存于 `.local/request-*`，可能含账户信息，不提交到仓库。

## 目录与文档

根目录保留使用入口、开发约束和交接状态；专项说明集中在 `docs/`。文档只描述当前实现，验收中的失败事实仍保留。

| 位置                                        | 用途                                                       |
| ------------------------------------------- | ---------------------------------------------------------- |
| `README.md`                                 | 安装、启动、操作和权限说明                                 |
| `AGENTS.md`                                 | 开发入口、代码地图和修改约束                               |
| `HANDOFF.md`                                | 当前交接状态、已验证结果和下一步                           |
| `docs/REQUIREMENTS.md`                      | 当前功能与验收口径                                         |
| `docs/DESIGN.md`                            | macOS 桌面布局与交互规范                                   |
| `docs/TESTING.md`                           | 自动化、隔离真实联测和手工验收步骤                         |
| `docs/VALIDATION.md`                        | 最新检查结果、真实证据和未验收边界                         |
| `src/client/`、`src/server/`、`src/shared/` | 页面、服务和共享类型                                       |
| `test/`                                     | 服务、文件保护和浏览器测试                                 |
| `scripts/`                                  | PTY 准备、原生 Hook、单 CLI 与需求级联测                   |
| `macos/RelayApp/`                           | Swift AppKit/WKWebView 壳、Info.plist、权限和 Sparkle 配置 |
| `.local/`                                   | 本机状态、工作区及私有联测证据；不提交                     |
| `dist/`、`node_modules/`、`test-results/`   | 构建、依赖和测试生成内容；不提交                           |

外部项目 曾作为外部手工测试对象，不是 Relay 的依赖；当前验收使用新建隔离仓库。选择其他 Git 项目也可使用 Relay。项目绑定属于本机持久化状态，不能从文档推断当前绑定或进程状态。

[交接状态](HANDOFF.md) · [功能与验收口径](docs/REQUIREMENTS.md) · [设计规范](docs/DESIGN.md) · [测试操作](docs/TESTING.md) · [验收记录](docs/VALIDATION.md)
