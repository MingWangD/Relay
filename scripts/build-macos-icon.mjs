import { chromium } from "@playwright/test";
import { readFile, mkdir, mkdtemp, rm, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const resources = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../macos/RelayApp/Resources",
);
const temporary = await mkdtemp(join(tmpdir(), "relay-icon-"));
const iconset = join(temporary, "Relay.iconset");
const browser = await chromium.launch({ channel: "chrome" });
try {
  await mkdir(iconset);
  const svg = await readFile(join(resources, "Relay.svg"), "utf8");
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{width:100%;height:100%;display:block}</style>${svg}`,
  );
  for (const size of [16, 32, 128, 256, 512]) {
    for (const density of [1, 2]) {
      await page.setViewportSize({
        width: size * density,
        height: size * density,
      });
      const file = join(
        iconset,
        `icon_${size}x${size}${density === 2 ? "@2x" : ""}.png`,
      );
      await page.screenshot({ path: file, omitBackground: true });
      if (size === 512 && density === 2)
        await copyFile(file, join(resources, "Relay.png"));
    }
  }
  await promisify(execFile)("/usr/bin/iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    join(resources, "Relay.icns"),
  ]);
  console.log("Relay 原创矢量图标：1024px PNG 与 10 个尺寸的 ICNS 已生成。");
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
