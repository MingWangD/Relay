# 安全说明

Relay 当前为开发预览版，不能代替操作系统安全隔离。安全修复以当前开发分支为目标；不承诺历史版本的长期维护或固定响应时限。

## 报告漏洞

涉及凭据泄露、认证绕过、跨项目访问或数据破坏的问题，请通过 GitHub 的 [Report a vulnerability](https://github.com/MingWangD/Relay/security/advisories/new) 私密报告。

请提供受影响版本、最短复现、影响范围与脱敏后的证据。不要在公开 Issue、PR、截图或日志中暴露账号密钥、ready 文件、完整 `#token=` 链接、用户数据库或完整模型终端。普通安装／模型配置问题使用 [Issue 表单](https://github.com/MingWangD/Relay/issues/new/choose)。

## 使用边界

- 新团队默认完全访问，可操作项目外文件；需要逐项确认时先选择原生审批。Relay 不绕过 macOS 权限、CLI 风险声明或组织策略。
- Git 快照、独立 worktree、评审和回写检查用于保留项目状态，不是针对恶意代码或模型的安全沙箱。只打开可信项目；平台检查会执行项目自己的脚本。
- 本机服务使用 loopback 与会话凭据。不要公开监听服务、转发端口或分享带 token 的链接。
- 模型请求由本机 CLI 发往其配置的服务。Relay 不提供模型账号；CLI 的数据处理规则仍适用。
- App 数据默认保存在 `~/Library/Application Support/Relay`；删除 App 不会删除数据。自行保存必要备份，导入由原生菜单显式触发。

## 安装包与更新

0.1.3 使用 ad-hoc 签名，未经 Apple 公证，生产自动更新关闭。安装包只从 [本仓库 Release](https://github.com/MingWangD/Relay/releases/tag/v0.1.3) 下载并核对 SHA-256。首次打开遵循 [Apple 单个可信 App 流程](https://support.apple.com/en-us/102445)，不关闭 Gatekeeper 或全局安全保护。

发布者必须分别验证签名、真实系统下限、公证和更新签名；构建成功不能证明这些步骤通过。当前实测范围见 [验收摘要](docs/VALIDATION.md)。
