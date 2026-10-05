# Relay 0.1.3 — Development Preview

首个公开开发预览版，build 4。Apple Silicon arm64，安装包最低要求 macOS 13.5；实际原生验收环境为 macOS 26.4，13.5 实机与干净机器尚未验收。

## 下载与安装

推荐下载 `Relay-0.1.3-macos-arm64.dmg`，打开后将 Relay 拖入 Applications。也可解压 `Relay-0.1.3-macos-arm64.zip` 并移动 Relay.app。用 `SHA256SUMS.txt` 检查文件完整性。

App 自带 Node。Git 与所需的 Codex、Antigravity、Claude Code CLI 需自行安装、登录并配置。选择项目和保存团队不调用模型；提交需求后才启动 CLI，可能产生模型服务费用。

这是 ad-hoc 签名、未经 Apple 公证的开发版；自动更新关闭。首次启动可能受 macOS 拦截，请核对来源与校验值，并遵循 [Apple 官方首次打开说明](https://support.apple.com/en-us/102445) 对单个可信 App 进行确认，不关闭全局安全保护。

## 功能与修复

- 原生中文／英语项目选择器，独立项目空间与对话历史。
- 共享 Claude 环境解析，使 Finder 启动可发现本机配置模型。
- 独立标题栏、窗口拖动、全屏状态恢复及网页故障后的手动重载（⌘R）。
- 三类 CLI 多 Agent 协商、分工、独立检查、评审与安全回写；同会话后续需求保持原生身份。
- 原创三节点协作图标；MIT 源码与随包第三方许可。
- 只读 Git 查询关闭可选索引写锁，保持用户暂存内容与索引文件。

## 使用边界

新团队默认“完全访问”，可读写当前用户可访问的文件，包括项目外文件；也可选择“原生审批”。只作用于 Relay 启动的子进程，不更改 CLI 全局权限或账号。数据存于 `~/Library/Application Support/Relay`，首次启动不会导入其他数据；原生菜单导入会先备份。

此预览版未完成 Developer ID、公证、生产自动更新、干净机器和 macOS 13.5 实机验收。部分 CLI 保留自己的目录信任或工具提示，需按原生入口处理。真实验收摘要见 [VALIDATION](https://github.com/MingWangD/Relay/blob/v0.1.3/docs/VALIDATION.md)。
