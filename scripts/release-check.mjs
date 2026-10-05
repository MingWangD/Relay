const required = [
  "DEVELOPER_ID_APPLICATION",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_APP_PASSWORD",
  "SPARKLE_ED_PRIVATE_KEY",
];
const missing = required.filter((name) => !process.env[name]);
if (process.env.RELAY_RELEASE === "1" && missing.length) {
  throw new Error(`正式 macOS 发布缺少签名凭据：${missing.join(", ")}`);
}
if (process.env.RELAY_RELEASE === "1") {
  console.log("macOS 发布凭据已提供；仍需在完整 Xcode 环境执行构建、签名、公证和 appcast 上传。");
} else {
  console.log("开发构建：未启用 Developer ID、公证或 Sparkle EdDSA；生产更新保持关闭。");
}
