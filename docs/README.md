# Relay 文档

按目标选择入口；安装与使用无需先读开发规范。

## 使用 Relay

| 文档                           | 内容                                 |
| ------------------------------ | ------------------------------------ |
| [项目首页](../README.md)       | 产品、下载、第一次协作与版本边界     |
| [安装指南](INSTALLATION.md)    | 系统／CLI 前提、校验、首次打开与卸载 |
| [使用指南](USAGE.md)           | 项目、团队、需求、审批、恢复与数据   |
| [排障指南](TROUBLESHOOTING.md) | 模型缺失、原生提示、连接与文件冲突   |
| [安全说明](../SECURITY.md)     | 权限边界和私密漏洞报告               |

## 开发与贡献

| 文档                              | 内容                              |
| --------------------------------- | --------------------------------- |
| [贡献指南](../CONTRIBUTING.md)    | Issue、PR 与验证要求              |
| [开发指南](DEVELOPMENT.md)        | 环境、启动、构建、目录与隔离数据  |
| [架构](ARCHITECTURE.md)           | 原生壳、服务、CLI 与成果处理      |
| [Agent 指南](../AGENTS.md)        | 命令、模块位置和必须保持的行为    |
| [功能与验收口径](REQUIREMENTS.md) | 当前产品行为与完成条件            |
| [界面规范](DESIGN.md)             | 页面布局、交互与阅读规则          |
| [测试指南](TESTING.md)            | 自动检查、真实 CLI 和原生手工场景 |
| [macOS 实现](../macos/README.md)  | 壳、资源、运行时与打包细节        |

## 维护与发布

| 文档                                    | 内容                               |
| --------------------------------------- | ---------------------------------- |
| [验收摘要](VALIDATION.md)               | 实际检查、已知失败与尚未验证的范围 |
| [发布说明](RELEASE_NOTES.md)            | 0.1.4 功能、安装与限制             |
| [发布流程](RELEASING.md)                | 干净源码、安装资产、草稿与公开验证 |
| [交接入口](../HANDOFF.md)               | 当前状态与后续工作                 |
| [第三方声明](../THIRD_PARTY_NOTICES.md) | 实际分发组件及许可文本             |

维护原则：README 提供入口；专项文档保存具体操作；VALIDATION 保存证据结论。公开仓库不包含本机数据、私有历史和原始验收材料。文档更新 main 不改变已发布版本标签或安装包。

## 文档组织参考

本次整理参考以下项目的公开结构：采用简短产品介绍、明确安装入口、独立开发／贡献文档和可执行的 Agent 指南。内容依据 Relay 实际实现编写，其他项目的贡献政策和平台范围不适用于 Relay。

- [Ghostty README 与 Agent 指南](https://github.com/ghostty-org/ghostty/tree/35a81a980bb9fce09a1ea762a68b55f8eb3477ed)：产品入口、开发命令与目录定位。
- [Zed 贡献指南](https://github.com/zed-industries/zed/blob/a6169ca96987105be7d60a5051f3155eb6225ccc/CONTRIBUTING.md)：小范围贡献、自查和实际验证。
- [Codex README](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/README.md)：安装优先、开发文档分离。
- [Aider README](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/README.md)：产品识别与快速开始。
