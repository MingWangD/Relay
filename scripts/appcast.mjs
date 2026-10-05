import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [, , output = "dist-macos/appcast.xml"] = process.argv;
const feed = `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">\n  <channel>\n    <title>Relay</title>\n    <description>Relay macOS 更新</description>\n    <language>zh-CN</language>\n    <!-- 发布机使用 Sparkle generate_appcast 生成带 EdDSA 签名的 item。 -->\n  </channel>\n</rss>\n`;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, feed, "utf8");
console.log(`已写入开发 appcast 模板：${output}`);
