# GitHub 开发预览版发布

当前目标为公开源码与可下载的 arm64 开发 App。Developer ID、公证与 Sparkle 生产更新是独立流程，预览发布不启用它们。

1. 完成适用的服务、浏览器、Swift 与真实原生验收，确认版本和 build number 单调递增。更新 MIT／第三方许可、安装说明和发布说明。
2. 私有工作区可用 `node scripts/export-public.mjs <新目录>` 导出白名单源码；原 Git 历史与本地数据不会复制。目录应位于工作区内 `.local/` 或工作区外，不能覆盖已有仓库。公开验收摘要来自 `docs/PUBLIC_VALIDATION.md`，不复制私有原始记录。
3. 在导出的源码中执行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`、`npm run macos:test`。构建机需 Apple Silicon macOS、Command Line Tools、Node 24+；浏览器回归需 Chrome。真实推理单独使用隔离 App 数据与项目，不在 CI 使用账户凭据。
4. 在独立发布仓库提交验收源码。执行 `npm run macos:package` 与 `npm run macos:smoke`，再运行 `npm run macos:preview-assets`。后者要求源码已提交且干净，并核对 App 版本、签名完整性和 DMG 后生成带版本号的 DMG／ZIP／SHA256SUMS。
5. 给相同源码 commit 创建并推送版本标签，先执行 `npm run macos:preview-draft`。检查草稿说明、三个资产、大小及校验值，再执行 `npm run macos:preview-publish`。已有 Release 不会被覆盖，发布失败保留草稿。
6. 使用无登录凭据的请求下载两个公开资产，比较校验值、解包和启动；另记录浏览器下载后的系统首次启动提示。README 使用明确标签下载地址，预览版不依赖 latest 跳转。

`docs/RELEASE_NOTES.md` 为本版本发布正文。`dist-macos/releases/v<版本>/` 保存安装资产，`.local/preview-manifest.json` 保存源码 commit 与资产来源。上传前检查不允许 GitHub 登录 token、CLI 凭据、ready 文件、SQLite、日志或本机私有路径进入源码或包。

发布脚本不创建或更改仓库可见性。首次仓库创建、源码推送和公开发布须由仓库所有者授权。GitHub 工作流无模型账户密钥，App 内原生 CLI 始终由用户自行安装和配置。
