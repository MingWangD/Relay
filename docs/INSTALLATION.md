# 安装 Relay

## 前置条件

- Apple Silicon Mac（arm64）、macOS 13.5+。Intel Mac 和其他系统暂不支持。
- 已安装 Git；使用有至少一次提交的可信 Git 项目。Git 子模块暂不支持。
- 至少一个已安装并完成登录／服务配置的 CLI：`codex`、`agy` 或 `claude`。对应成员需要对应 CLI；不是三个都必须安装。

Relay App 内置 Node；只有源码开发需要另装 Node.js 24+。模型由 CLI 和账号提供，Relay 不附赠额度；实际需求可能产生模型费用。CLI 安装方式随厂商变化，请遵循对应官方渠道，先确认 CLI 能独立运行。

## 下载与校验

从 [v0.1.4 Release](https://github.com/MingWangD/Relay/releases/tag/v0.1.4) 下载 DMG（推荐）或 ZIP，同时下载 `SHA256SUMS.txt`。

在安装文件所在目录检查，例如：

```bash
shasum -a 256 Relay-0.1.4-macos-arm64.dmg
# 使用 ZIP 时：
shasum -a 256 Relay-0.1.4-macos-arm64.zip
```

把输出与校验文件中同名条目的完整 64 位值比较；不一致时停止安装并重新下载。校验用于检查文件一致性，不替代 Apple 公证。

## 安装与首次打开

1. 打开 DMG，将 Relay 拖入 Applications；ZIP 则解压后移动 Relay.app。
2. 从“应用程序”打开 Relay。首次启动不会自动导入开发数据或启动模型。
3. 若被 macOS 拦截，确认来自上述 Release 且校验一致后，按 [Apple 官方说明](https://support.apple.com/en-us/102445) 在系统设置“隐私与安全性”中允许单个可信 App；系统确认由你操作。
4. 按 [使用指南](USAGE.md) 选择项目、配置团队，再发送需求。

此预览版 ad-hoc 签名、未公证、自动更新关闭。不要运行关闭 Gatekeeper、删除隔离属性或修改全局安全设置的安装脚本。下载／首次打开的实际验收边界见 [VALIDATION](VALIDATION.md)。

## 更新与卸载

预览版手动下载新版本。先停止需求、正常退出 Relay，保留数据备份，再替换 App；不要同时启动两个版本使用同一数据目录。

卸载时正常退出，将 Relay.app 移到废纸篓。聊天、成员绑定和项目空间数据仍留在 `~/Library/Application Support/Relay`；删除 App 不删除这些数据，也不删除项目或 CLI 全局历史。保留数据可用于之后重新安装。下载的 DMG／ZIP 可另行移到废纸篓。

不要在未备份的情况下删除数据目录。导入旧数据、故障恢复与权限说明见 [USAGE](USAGE.md)，遇到阻碍见 [TROUBLESHOOTING](TROUBLESHOOTING.md)。
