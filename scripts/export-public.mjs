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
  "CONTRIBUTING.md",
  "SECURITY.md",
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
await mkdir(join(output, ".github/ISSUE_TEMPLATE"), { recursive: true });
for (const f of [
  "ISSUE_TEMPLATE/bug_report.yml",
  "ISSUE_TEMPLATE/feature_request.yml",
  "ISSUE_TEMPLATE/config.yml",
  "PULL_REQUEST_TEMPLATE.md",
])
  await cp(join(root, ".github", f), join(output, ".github", f));
await mkdir(join(output, "docs"));
for (const f of [
  "README.md",
  "INSTALLATION.md",
  "USAGE.md",
  "TROUBLESHOOTING.md",
  "DEVELOPMENT.md",
  "ARCHITECTURE.md",
  "REQUIREMENTS.md",
  "DESIGN.md",
  "TESTING.md",
  "RELEASING.md",
  "RELEASE_NOTES.md",
])
  await cp(join(root, "docs", f), join(output, "docs", f));
// Private workspaces provide a curated public summary; public clones already
// contain the safe summary as VALIDATION.md. Never copy a private handoff.
let validation = join(root, "docs/PUBLIC_VALIDATION.md");
try {
  await lstat(validation);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  validation = join(root, "docs/VALIDATION.md");
  const summary = await readFile(validation, "utf8");
  if (!/^# Relay[^\n]*验收摘要(?:\r?\n|$)/.test(summary))
    throw Error("A curated public validation summary is required");
}
await cp(validation, join(output, "docs/VALIDATION.md"));
const agents = await readFile(join(root, "AGENTS.md"), "utf8");
const agentStart = agents.indexOf("# Relay：Agent");
if (agentStart < 0) throw Error("Relay agent guide header is missing");
await writeFile(join(output, "AGENTS.md"), agents.slice(agentStart));
const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
await writeFile(
  join(output, "HANDOFF.md"),
  `# Relay 开发入口

当前源码版本 ${version}。安装与产品说明见 [README](README.md)，开发约束见 [AGENTS](AGENTS.md)，专项文档见 [文档索引](docs/README.md)。

当前验收事实见 [VALIDATION](docs/VALIDATION.md)，发布步骤见 [RELEASING](docs/RELEASING.md)。公开仓库不包含私有原始证据或本机进程状态；开始恢复前重新核对进程、数据目录锁、工作区和原生身份，不自动重跑旧需求。

后续重点：干净机器／最低系统版本、默认 Gatekeeper 首次授权、Dock／切换器与最小化恢复、Developer ID／公证及签名更新。是否完成以验收摘要为准，不能从构建成功推导。
`,
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
