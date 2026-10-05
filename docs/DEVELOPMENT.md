# 开发指南

## 环境与启动

Apple Silicon macOS、Node.js 24+、Git。原生构建需要 Command Line Tools（提供 SwiftPM）；浏览器回归和图标再生成使用本机 Google Chrome。安装包内置 Node，开发环境仍需独立安装。

```bash
git clone https://github.com/MingWangD/Relay.git
cd Relay
npm ci
npm run doctor
npm run build
npm start
```

`doctor` 只检查三类 CLI 安装与接口能力。服务默认监听 `127.0.0.1:4317`，数据目录 `.local/`。打开输出的完整带 token 链接；不要分享链接、ready 文件或浏览器会话凭据。

开发模式：`npm run dev`。前端热更新；后端修改后先正常停止旧服务，再启动。关闭浏览器不停止任务。服务支持 `--port`、`--data-dir`、`--ready-file` 及对应环境变量；同一数据目录只运行一个服务。

## 目录职责

```text
.github/          Issue 表单与 PR 模板
src/client/       对话界面、手动阅读与终端展示
src/server/       本机服务、协作、CLI、Git 与 SQLite
src/shared/       类型、原生桥协议与展示规则
macos/RelayApp/   Swift AppKit／WKWebView 壳、测试和资源
test/             服务与文件保护回归，browser/ 为 UI 夹具
scripts/          CLI 联测、打包、许可、公开导出和发布
docs/             用户、开发、测试、架构与发布说明
```

根目录入口为 README、CONTRIBUTING、SECURITY、AGENTS 与 HANDOFF。依赖锁文件和实际分发许可随源码提交。`.local/`、`dist/`、`dist-macos/`、`node_modules/`、浏览器报告和 Swift `.build/` 是本机生成内容，不提交。

## 原生构建

```bash
npm run macos:check
npm run macos:build
npm run macos:package
```

`check` 检查环境与资源；`build` 生成 `dist-macos/Relay.app`；`package` 同时生成 `dist-macos/Relay-arm64.dmg`。脚本校验官方 Node 24.21.0 arm64 下载、独立生产依赖、Sparkle 框架、原生链接、系统下限与资源边界。

Swift 壳目标为 macOS 13，但当前 Node 的实际下限为 13.5，安装包声明 13.5+。开发构建使用 ad-hoc 签名、关闭更新；不视为 Developer ID 或公证构建。更多细节见 [macOS 实现](../macos/README.md)。

## 隔离数据与进程

原生 App 使用 `~/Library/Application Support/Relay`，不要用这个目录进行破坏性测试。每次隔离验收创建新数据目录与新建 Git 项目；不得自动恢复用户旧任务。

完成构建后，可直接启动原生可执行文件并指定仅本次进程的数据目录：

```bash
RELAY_APP_DATA_DIR="$PWD/.local/app-check-$(date +%Y%m%d-%H%M%S)"   ./dist-macos/Relay.app/Contents/MacOS/RelayApp
```

正常通过 `⌘Q` 退出，再核对对应 Node／PTY、ready、锁和端口清理。检查进程必须确认所属 App 与数据目录；不要批量终止 Node 或凭历史 PID 操作。App 窗口偏好按测试数据路径隔离。

浏览器启动可指定新目录，例如：

```bash
npm start -- --port 0 --data-dir .local/browser-check
```

同一测试目录顺序使用，不重复启动服务；复用前核对旧进程。真实模型联测会读取本机账号并可能产生费用，仅按已授权测试范围执行，见 [TESTING](TESTING.md)。

## 检查与发布

适用命令、夹具边界和原生手工验收见 [TESTING](TESTING.md)。检查结果写入验收摘要时区分实际运行、未运行与失败；当前版本证据见 [VALIDATION](VALIDATION.md)。

预览发布使用干净独立源码、明确标签、草稿资产与匿名下载复验，见 [RELEASING](RELEASING.md)。已经公开的标签与资产不覆盖；文档更新可以单独进入 main。
