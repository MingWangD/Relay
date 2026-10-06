# Relay 0.1.5 — Development Preview

build 6，新增图片附件、视觉能力验证、日期工作区，并修复 Markdown 链接及快照大文件内存。Apple Silicon arm64、macOS 13.5+；实际验收环境 macOS 26.4。

## 本版变化

- 选择、拖入、粘贴 PNG／JPEG／WebP；每条最多 8 张，单张 10 MiB、合计 40 MiB。支持只发图片及执行中补图，失败保留草稿；原图随所属聊天保存。
- 支持视觉的成员先读原图并提交分析，其他成员使用团队识图结果。Codex 使用原生图片输入；Claude／Antigravity 使用 MCP 图片内容块。未知配置可独立验证，验证会调用当前模型；终端支持查看提示及人工接管，不自动批准权限。
- 新工作区按本机日期分组，项目、需求、成员使用短名称；旧目录和原生启动目录保持，接续同一会话。
- markdown-it 行内 Token 解析保留链接原始地址，修复 `__tests__`、星号等 URL 被格式正则改写。关闭原始 HTML、自动链接和远程图片，仅允许 HTTP／HTTPS／mailto。
- 快照及项目审计普通文件采用流式哈希，指纹兼容；两遍一致性与 Git 保护保留。按 revision 缓存脱敏状态和完整消息，SQLite 全量事务与断线恢复不变。
- 保留 0.1.4 编辑快捷键、输入法回车与人工接管 JSON 修复。

## 真实验证与性能

Codex gpt-6.1-sol 在原生 App 通过首图识别、⌘V 补图及同原生 ID 接续；Antigravity gemini-3.8-flash-medium 在独立诊断通过识图及补图接续。DeepSeek 验证停在原生目录信任提示，保持未确认，不能据此称其不支持。其他配置仅真实验证后标为支持。

首轮 Codex 曾漏交结构化分析、直接提问；保留失败，补顺序校验并在同会话修复后完成。原图退出重启、原生菜单导入、备份及导入源不变已检查；测试项目 HEAD、分支、暂存区和文件保持。

128 MiB 文件的子进程峰值 RSS 从约 321.6 MiB 降为 141.3 MiB，指纹一致；1000 小文件耗时从 53.82 ms 增至 70.84 ms。状态缓存改善同 revision 再读；50 MiB mutate p50 基本持平、p95 变慢，RSS 增加。数据仅代表本轮夹具，详细方法、阶段量测及未消除的全量成本见 [PERFORMANCE](https://github.com/MingWangD/Relay/blob/v0.1.5/docs/PERFORMANCE.md)。

## 下载与更新

推荐 `Relay-0.1.5-macos-arm64.dmg`；另提供 `Relay-0.1.5-macos-arm64.zip`、`SHA256SUMS.txt`。先完成或停止当前需求，退出旧 App，再自行安装新版；本轮不替换用户当前 App。保留 `~/Library/Application Support/Relay` 即保留数据，服务重启不自动恢复旧任务。旧版资产继续保留。

App 内置 Node；Git 和所用 CLI 需自行安装、登录及配置。选择项目、保存团队不调用模型；提交需求或验证视觉能力可能产生服务费用。图片会经所选 CLI／模型服务处理，不增加 OCR 服务。

ad-hoc 签名、未经公证，生产自动更新关闭。首次打开核对来源及摘要后，按 [Apple 单个可信 App 授权说明](https://support.apple.com/en-us/102445) 操作；不修改全局安全设置。

类型检查、生产／Swift release 构建、96 项服务／打包、35 项浏览器夹具、4 项 Swift 实文件导入检查及包内 Node／PTY smoke 通过。实际执行事实与尚未验收场景见 [VALIDATION](https://github.com/MingWangD/Relay/blob/v0.1.5/docs/VALIDATION.md)。干净机器、macOS 13.5 实机、默认 Gatekeeper 首次授权、Developer ID、公证及正式自动更新仍待验收。
