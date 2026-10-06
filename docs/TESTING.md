# Relay 测试操作

更新：2026-10-06。当前只适配 macOS 桌面。实际通过结果见 [VALIDATION.md](VALIDATION.md)，启动和权限说明见 [README](../README.md)。真实验收默认使用新建隔离 Git 项目；测试已有项目须重新记录基线。

## 自动化检查

在 Relay 根目录执行：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
```

浏览器测试使用 Playwright 和本机 Chrome，模型目录及 Runtime 为夹具；证明界面行为，不证明真实厂商模型执行。服务测试覆盖真实 Git 与 PTY，原生适配器参数检查使用 CLI 协议替身。

## 隔离真实模型联测

桌面回归：`claude-environment.test.ts` 覆盖 shell 输出、5 秒超时机制、缓存／刷新、配置目录、显式覆盖和 LaunchServices 旧值；`runtime-settings.test.ts` 使用真实 PTY 与 CLI 替身，核对实际模型及认证／端点变量传递。原生选择桥的取消和路径回传由浏览器夹具覆盖，服务端另验目录类型、认证和 Git 边界。

原生人工验收须检查：中文／英语系统侧栏、选择隔离 Git 项目的真实回传、标题栏拖动、缩放、侧栏收起／展开、全屏与 `⌃⌘F` 退出，以及关闭最后窗口后的 Node／ready／锁清理。英语可仅对隔离 App 测试进程传入 `-AppleLanguages '(en)' -AppleLocale en_US`，配合 `RELAY_APP_DATA_DIR`，不修改系统偏好。

以下命令会调用真实模型，可能产生费用。各自创建本机 .local 下的隔离 Git 仓库，不把当前绑定的用户项目当作测试目录。

```bash
# 分析需求
npx tsx scripts/request-smoke.ts --inference
# 代码、独立检查、非作者评审与回写
npx tsx scripts/request-smoke.ts --inference --task
# 明确选择当前账户可用的模型和强度
npx tsx scripts/request-smoke.ts --inference --task --model-codex=gpt-6.1-sol --effort-codex=low --model-antigravity=gemini-3.8-flash-medium
# 原生审批；默认模式为完全访问
npx tsx scripts/request-smoke.ts --inference --native
# 三类 CLI 参与；本轮隔离真实代码协作已通过
npx tsx scripts/request-smoke.ts --inference --task --team=codex,antigravity,claude --model-claude=deepseek-flash --effort-claude=high
```

模型 ID 和强度受 CLI、账户及服务能力限制；示例是本轮曾成功的选择，不保证未来可用。默认单次需求联测上限 10 分钟，可通过 --timeout=毫秒调整。恢复只支持 --resume-dir .local/request-时间戳，先检查保留成果、工作区和旧进程。

单 CLI 生命周期、原生 ID 与同会话接续检查：

```bash
npx tsx scripts/native-smoke.ts --provider=codex --model=gpt-6.1-sol --effort=high
npx tsx scripts/native-smoke.ts --provider=antigravity --model=gemini-3.8-flash-medium
npx tsx scripts/native-smoke.ts --provider=claude --native
```

native-smoke 本身会调用真实模型，不需要 --inference。--trust-fixture 仅用于明确处理该脚本创建的隔离目录信任与有限协作工具提示。产品没有这些自动按键逻辑；登录、风险声明、系统和组织限制需按原生入口人工处理。

原始终端和证据在 `.local/smoke-*`、`.local/request-*`，可能含账号信息，不能提交或直接贴入文档。记录成功与失败各自的证据位置，不能覆盖失败记录。

同一隔离聊天的后续需求与原生滚轮验收（将路径换为刚通过的测试目录；同一目录顺序执行，不能同时跑两个服务）：

```bash
npx tsx scripts/request-smoke.ts --inference --resume-dir .local/request-时间戳 --followup
npx tsx scripts/native-smoke.ts --provider=codex --reuse-dir .local/request-时间戳 --scroll-check --trust-fixture
npx tsx scripts/native-smoke.ts --provider=claude --reuse-dir .local/request-时间戳 --scroll-check --trust-fixture
```

全屏滚轮检查必须同时确认受限通道调用、真实控制字节及原生画面变化；普通缓冲必须确认浏览器本地历史变化，并且不调用受限通道。两种均核对原生 ID／代次保持、键盘仍锁定。脚本用快照列／行恢复观察画面；直接适配器测试创建明确标为 stopped 的展示夹具，不把该记录当作模型任务完成证据。

首次独立检查无需复用目录：

```bash
npx tsx scripts/native-smoke.ts --provider=codex --model=gpt-6.1-sol --effort=low --scroll-check --trust-fixture
npx tsx scripts/native-smoke.ts --provider=claude --model=deepseek-flash --effort=high --scroll-check --trust-fixture
npx tsx scripts/native-smoke.ts --provider=antigravity --model=gemini-3.8-flash-medium --scroll-check --trust-fixture
```

脚本要求真实输出 60 行中文及一条长命令文字示例；不执行示例命令。截图核对中文连续横排、长命令换行与原生输入区；夹具另覆盖 ANSI 定位、全屏无鼠标追踪、触控板小位移、离线后首次启动、重连、缺包及八成员持续输出。检查全局配置前后差异；CLI 自行保存隔离目录信任条目时，只清理确认为本轮创建的条目，保留用户其他设置。

性能夹具只能证明给定数据量下的客户端／持久化行为，不能推论八个真实模型长时压力或真实触控板硬件。需要性能测量时，明确数据量、环境和采样方法，脱敏结论记录在验收摘要；原始样本仅留本机。

## 桌面手工验收

### macOS 原生 App

原生壳编译目标为 macOS 13+ Apple Silicon；当前内置官方 Node 24 的安装包要求 macOS 13.5+：

```bash
npm run macos:check
npm run macos:build
npm run macos:package
npm run macos:smoke
npm run macos:test
```

开发构建需要 SwiftPM／Command Line Tools，不必把 `xcodebuild` 不可用等同于无法构建。`macos:check` 仅检查主机和必需资源；`macos:build` 额外校验／下载官方 Node、独立安装生产依赖、编译 Swift、嵌入 Sparkle、检查原生依赖／系统下限和资源边界，并执行 ad-hoc 签名完整性检查。可用 `RELAY_NODE_RUNTIME` 指定自备独立 Node，禁止直接复制依赖 Homebrew 的宿主 Node。正式发布仍需完整签名／公证工具和发布密钥；当前开发打包拒绝 `RELAY_RELEASE=1`，不能把 ad-hoc `.app` 写成可公证发布。

`macos:smoke` 使用 `.local/macos-smoke-*` 隔离数据和系统 PATH，实际启动安装包内 Node 服务，检查 PID／0600 ready／认证／前端资源／本机 origin，运行真实中文 PTY、resize、退出，并在夹具 HTTP 端点执行包内 Hook。随后确认服务退出码 0、ready／lock 删除与端口释放。Hook 端点为夹具，未调用模型；这不证明三类 CLI 的 App 内协作。该脚本保留失败证据，重跑生成新目录。

实际打开 App 的隔离验收可设置 `RELAY_APP_DATA_DIR` 后运行 `dist-macos/Relay.app/Contents/MacOS/RelayApp`。核对页面连接、`⌘K`、Escape、新建聊天、界面更新入口与 `⌘Q` 清理；占位更新源应显示原生“开发版尚未配置更新”，浏览器入口应提示在 App 检查。未知本地端口／file URL 不得导航；新项目的不同端口必须由主服务用户认证后允许。类型检查和构建先完成，再运行读取 dist 的浏览器测试，避免旧资源造成误判。

验证窗口位置／尺寸／全屏恢复、`⌘N` 新建聊天、`⌘K` 命令面板、`⌘⇧P` 项目选择、`⌘U` 更新检查、Escape 关闭；检查外部链接由系统浏览器打开，WKWebView 进程终止后可重载。首次启动不得自动复制 `.local` 或启动 Agent；用户明确导入时先备份并保持项目空间和原生 ID 隔离。Sparkle 用带有效 EdDSA 的 HTTPS appcast 验证当前版本不弹窗、新版本显示 release notes、稍后／跳过／更新、下载重试、安装前停止服务以及更新后数据和会话绑定保留。

1. 从 README 启动服务，使用输出的完整带 token 链接。同一数据目录只允许一个服务，已有服务不要再次启动。
2. 点击项目右侧“＋”后选择“在此电脑上选择文件夹”，用 macOS 原生选择器选可信、已有 Git 提交的测试项目。正式项目已有修改时，先记录 HEAD、分支、暂存与磁盘差异；不要将凭据内容复制到报告。
3. 团队空闲时选择成员、模型、强度和权限。保存不应启动 CLI 或请求模型；下一次需求才使用新设置。旧团队默认原生审批。
4. 运行下面两轮独立需求，分别记录原生会话、工具活动、消息确认、评审者、独立检查、退出码及磁盘结果。
5. 长聊天中核对待处理请求始终在输入框上方，多请求区内部滚动。审批只显示操作、路径／命令和范围；未知提示可打开原终端。
6. 左栏新建、切换、归档与确认删除；已归档条目不在左栏显示，通过右上角“已归档对话”弹窗搜索、排序、打开、取消归档、确认单条／全部删除；切换不启动 CLI，草稿、阅读位置及协作／成员交流展开保持。执行／排队／恢复时归档或删除应被拒绝。每名成员全流程及后续需求保持原生 ID，仅新聊天或首次新增成员可新建。
7. 最终结论在终端区下方，折叠也可阅读；标题、列表、代码与安全链接正常排版，原始 HTML 不执行。输入时接收状态更新，检查焦点与已输入文字保持；阅读历史时不跳到底部。折叠、放大、分页或调整窗口尺寸不重复启动会话。
8. 退出人工接管后分别用鼠标滚轮、触控板上下阅读普通／全屏终端；切换方向、分页、折叠、放大、刷新及持续输出后重复检查。普通键盘与粘贴仍不得写入原生会话。中文与长命令在双栏及放大终端连续横排；原生 CLI 可按自身布局换行。
9. Anti 应区分已启动待会话确认、执行中、等待确认；无活动 30 秒显示诊断。当前画面清除提示后旧提醒不应反复出现；活动不能直接使任务完成。
10. 执行或排队期间修改团队应被拒绝。停止后旧审批失效；刷新页面不重复派发，服务重启进入显式恢复。

分析需求示例：

> 审查本项目，结合实际文件说明主执行链路、两个已有测试覆盖点和两个未覆盖风险。自行分工并交叉检查，最终给出文件依据和验证限制。只分析，不修改文件，不调用项目自身需要密钥的外部服务。未运行的测试不要写成通过。

代码需求示例（仅用于隔离测试项目，先确认目标文件不存在）：

> 新增 native-result.txt，内容精确为一行 relay native task ok，结尾换行。自行分工、交叉评审并运行项目已有离线测试；只改该文件，不调用项目自身外部服务，不暂存、提交或推送原项目。最终说明实际改动、测试命令、退出状态和回写结果。

分析结束比较原始基线，应无业务文件、HEAD、分支和暂存区变化。代码结束只允许本次预期新增差异，原有修改保持；平台独立检查与 Agent 自行执行分开记录，无法识别测试入口时如实显示“未执行自动测试”。

## 验收记录

记录需求、起止时间、所选与原生确认的设置、成员参与、任务／消息／ACK、测试命令和退出码、成果版本、回写差异与原始基线对比。权限等待、模型连接失败、超时、人工干预和恢复必须保留。截图、参数传入和动画不能替代真实 CLI、结构化记录与磁盘证据。

模型选择专项：确认没有“自定义模型 ID”输入，模型下拉显示原生目录全部名称；Anti 完整模型内含强度，不出现单独强度选择。延迟目录到达时保留已聚焦选择器、当前值并补齐选项；目录失败保留上次列表／已保存值、默认和重试。保存不启动模型。

本机选择专项：检查菜单位置、Escape／点击外部关闭、取消保持草稿与聊天、打开期间重复点击禁用及系统授权失败后重试。切换另一隔离 Git 项目后确认旧聊天／任务保留，团队配置复制但成员身份和原生绑定独立；再次选择原目录或子目录应复用空间，服务重启后重新选择仍保留历史。Agent 凭据和跨项目用户凭据不得调用选择接口或读取另一空间。退出主服务后检查所有项目空间端口和锁释放。夹具验证不代替原生选择器实际点击验收。

### 0.1.4 编辑与输入法回归

在独立 App 数据目录测试 ⌘C／⌘V／⌘X／⌘A／⌘Z／⌘⇧Z，以及 ⌘B、⌘W。真实简体中文拼音输入 rutu，选中“如图”后回车应仅确认候选词；随后普通回车才进入发送，Shift+回车换行。自动回归覆盖 compositionend 先于 keydown、isComposing 为 false 且 keyCode 为 229 的 WebKit 行为，以及带引号／反斜杠的凭据样式模型文本后的人工接管。

原生测试启动器必须保留 `RELAY_APP_DATA_DIR`，并在操作 UI 前核对所属 Node 的 `--data-dir`。先启动测试进程，再绑定已运行 App；不要让 UI 工具自动重新启动丢失环境的 App。后台启动器须保持进程存活或使用独立进程会话。若测试进程提前退出，停止 UI 操作，重新验证隔离参数；不得回落到默认数据目录。使用不同测试 bundle ID，结束后退出并移除其注册，避免留下重复安装图标。
