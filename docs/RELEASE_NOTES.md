# Relay 0.1.4 — Development Preview

build 5，修复 macOS 编辑快捷键、输入法误发送与人工接管报错。Apple Silicon arm64、macOS 13.5+；实际验收环境 macOS 26.4。

## 本版修复

- ⌘C 复制、⌘V 粘贴、⌘X 剪切、⌘A 全选、⌘Z 撤销、⌘⇧Z 重做通过原生“编辑”菜单作用于当前输入控件。
- 中文等输入法候选词确认回车不发送消息，覆盖 WebKit 先结束 composition 再触发 keydown 的情况。确认后再次回车发送，Shift+回车换行。
- “人工接管”不再因模型文本含凭据样式与引号、反斜杠而出现 JSON 解析弹窗。脱敏按文本值处理，用户持久化记录不变。
- 新增 ⌘B 显示／隐藏聊天历史、⌘W 关闭窗口；关闭最后一个窗口时退出 App。保留 ⌘K 命令面板、⌘N 新建聊天等已有快捷键。

快捷键参考 [Codex 官方命令说明](https://learn.chatgpt.com/docs/reference/commands)，原生编辑采用 AppKit 响应者链。终端输入仍需人工接管，团队权限及原生会话规则不变。

## 下载与更新

推荐下载 `Relay-0.1.4-macos-arm64.dmg`；也提供 `Relay-0.1.4-macos-arm64.zip` 与 `SHA256SUMS.txt`。

请先完成或停止正在执行的需求，再退出旧版 Relay。打开 DMG，把 Relay 拖入 Applications，并替换旧 App；卸载 DMG 后从 Applications 启动。保留 `~/Library/Application Support/Relay` 即保留原有数据，不需要删除或导入。仅推送源码不会更新本机 0.1.3。

App 自带 Node；Git、Codex／Antigravity／Claude Code CLI 需自行安装、登录并配置。选择项目、保存团队不调用模型；提交需求后可能产生模型服务费用。

这是 ad-hoc 签名、未经 Apple 公证的开发版，自动更新关闭。首次打开可能受 macOS 拦截；核对来源与 SHA-256 后按 [Apple 官方说明](https://support.apple.com/en-us/102445) 授权单个可信 App，不更改全局安全设置。

## 验证与边界

类型检查、生产／Swift release 构建、82 项服务／打包、31 项浏览器、4 项 Swift 导入检查及包内 Node／PTY smoke 通过。真实隔离 App 的复制粘贴、剪切、全选、撤销／重做、聊天历史切换、中文候选词回车确认和关闭退出通过。本轮没有调用真实模型，夹具结果与此前真实协作结果分开记录。

新团队默认“完全访问”，包含项目外当前用户可访问的文件；可改为“原生审批”。只设置 Relay 子进程，不修改全局账号或权限。

干净机器、macOS 13.5 实机、默认 Gatekeeper 首次授权、Developer ID、公证、正式自动更新仍待验收。完整事实见 [本版验收摘要](https://github.com/MingWangD/Relay/blob/v0.1.4/docs/VALIDATION.md)；发布后下载校验见 [当前记录](https://github.com/MingWangD/Relay/blob/main/docs/VALIDATION.md)。
