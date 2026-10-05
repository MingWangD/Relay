# Relay 开发入口

当前发布：**0.1.3 / build 4**，Apple Silicon arm64、macOS 13.5+ 开发预览版。固定版本源码与安装包见 [v0.1.3](https://github.com/MingWangD/Relay/releases/tag/v0.1.3)；main 可包含后续文档及源码改动，不能据此认定安装包已更新。

## 开始接手

阅读 [README](README.md)、[AGENTS](AGENTS.md) 和 [文档索引](docs/README.md)。实际检查与待验收项见 [VALIDATION](docs/VALIDATION.md)，贡献及发布步骤见 [CONTRIBUTING](CONTRIBUTING.md) 与 [RELEASING](docs/RELEASING.md)。

2026-10-05 文档整理：重写产品首页和 Agent 指南，拆分安装、使用、排障、开发及架构说明；新增贡献／安全入口、Issue／PR 模板；公开导出白名单同步这些文件。此轮不改变业务运行行为，不重建已发布安装包或覆盖版本标签。文档相对链接／锚点、npm 命令与格式检查通过；私有工作区和公开克隆均完成导出验证，原始验收摘要回退被拒绝。主要文档经 GitHub Markdown 渲染检查，下载及参考入口可访问。

## 后续工作

1. 干净 Apple Silicon Mac 与 macOS 13.5 实机验收，默认 Gatekeeper 的首次授权路径。
2. Dock、应用切换器、最小化后恢复的人工视觉确认。
3. Developer ID、公证和签名更新；当前 ad-hoc 开发版保持自动更新关闭。
4. 多模型长时压力与性能工作独立安排，不把已有夹具结果当作真实模型结论。

公开仓库不包含本机 PID、端口、数据、凭据或私有原始证据。恢复工作须重新核对所属进程、数据目录锁、项目基线和成员原生身份；不自动恢复旧用户任务，不更换已有会话 ID。失败证据与未验收边界不得改写为通过。
