import {
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
} from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw Error("Provide a new export directory");
const output = resolve(process.argv[2]);
if (
  output === root ||
  root.startsWith(output + "/") ||
  (output.startsWith(root + "/") &&
    !output.startsWith(join(root, ".local") + "/"))
)
  throw Error("Export must be outside source or under .local");
try {
  await lstat(output);
  throw Error("Export directory already exists");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await mkdir(output, { recursive: true });
const files = [
  ".gitignore",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "index.html",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "playwright.config.ts",
];
for (const f of files) await cp(join(root, f), join(output, f));
const blocked = new Set([
  ".git",
  ".build",
  ".local",
  "node_modules",
  "test-results",
  "playwright-report",
  ".DS_Store",
]);
for (const dir of ["src", "test", "scripts", "macos"])
  await cp(join(root, dir), join(output, dir), {
    recursive: true,
    filter: (p) =>
      !relative(root, p)
        .split("/")
        .some((x) => blocked.has(x)),
  });
await mkdir(join(output, "docs"));
for (const f of [
  "REQUIREMENTS.md",
  "DESIGN.md",
  "TESTING.md",
  "RELEASING.md",
  "RELEASE_NOTES.md",
])
  await cp(join(root, "docs", f), join(output, "docs", f));
await cp(
  join(root, "docs/PUBLIC_VALIDATION.md"),
  join(output, "docs/VALIDATION.md"),
);
let agents = await readFile(join(root, "AGENTS.md"), "utf8");
agents = agents.slice(agents.indexOf("# Relay：Agent"));
await writeFile(join(output, "AGENTS.md"), agents);
await writeFile(
  join(output, "HANDOFF.md"),
  "# Relay 开发入口\n\n当前为 0.1.3／build 4 开发预览版。先读 AGENTS.md 与 README.md；架构、测试、当前验收及发布流程分别见 docs/DESIGN.md、TESTING.md、VALIDATION.md、RELEASING.md。\n\n后续重点：Developer ID、公证、签名更新、干净机器／macOS 13.5 实机验收，以及多模型长时压力。私有原始证据不公开，恢复需求必须重新核对进程、工作区和原生身份，不能自动重跑。\n",
);
async function audit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw Error("Source export rejects links");
    if (entry.isDirectory()) {
      await audit(path);
      continue;
    }
    if (/\.(png|icns)$/.test(entry.name)) continue;
    let text = await readFile(path, "utf8");
    if (/\.(md)$/.test(entry.name)) {
      text = text
        .replaceAll(root, "<workspace>")
        .replace(/MiniCode|AntiEnter/g, "外部项目");
      await writeFile(path, text);
    }
    if (
      text.includes(homedir() + "/") ||
      /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|#token=[A-Za-z0-9_-]{24,})/.test(
        text,
      )
    )
      throw Error("Private content detected: " + relative(output, path));
  }
}
await audit(output);
console.log("Public source exported and audited: " + output);
