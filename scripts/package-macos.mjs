import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(repo, "dist-macos");
const app = resolve(output, "Relay.app");
const nodeVersion = "24.21.0";
const nodeArchive = `node-v${nodeVersion}-darwin-arm64.tar.gz`;
const nodeChecksum =
  "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} 退出（${code ?? signal}）`));
    });
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function parseMachO(output, loadCommands) {
  const dependencies = output
    .split("\n")
    .filter((line) => /^\s+\S/.test(line))
    .map((line) => line.trim().split(" (compatibility version")[0])
    .filter(Boolean);
  const nonSystem = dependencies.filter(
    (path) =>
      !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"),
  );
  const minimum =
    loadCommands.match(
      /cmd LC_BUILD_VERSION[\s\S]*?\bminos (\d+(?:\.\d+){0,2})/,
    ) ??
    loadCommands.match(
      /cmd LC_VERSION_MIN_MACOSX[\s\S]*?\bversion (\d+(?:\.\d+){0,2})/,
    );
  if (!minimum) throw new Error("无法读取 Mach-O 最低系统版本");
  return { nonSystem, minimum: minimum[1] };
}

async function macho(path) {
  const [
    { stdout: libraries },
    { stdout: commands },
    { stdout: architectures },
  ] = await Promise.all([
    exec("otool", ["-arch", "arm64", "-L", path]),
    exec("otool", ["-arch", "arm64", "-l", path]),
    exec("lipo", ["-archs", path]),
  ]);
  if (!architectures.trim().split(/\s+/).includes("arm64"))
    throw new Error(`${basename(path)} 缺少 arm64 架构`);
  return parseMachO(libraries, commands);
}

export async function verifyNodeRuntime(path) {
  const { nonSystem, minimum } = await macho(path);
  if (nonSystem.length)
    throw new Error(
      `Node 依赖包外动态库，不能独立分发：${nonSystem.join(", ")}`,
    );
  const { stdout } = await exec(
    path,
    [
      "-p",
      "JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})",
    ],
    { env: { PATH: "/usr/bin:/bin" } },
  );
  const info = JSON.parse(stdout);
  if (
    info.platform !== "darwin" ||
    info.arch !== "arm64" ||
    Number(info.version.split(".")[0]) < 24
  )
    throw new Error("内置 Node 必须为 macOS arm64、版本 24 或更高");
  return { ...info, minimum };
}

async function nodeRuntime() {
  if (process.env.RELAY_NODE_RUNTIME) {
    const binary = resolve(process.env.RELAY_NODE_RUNTIME);
    return { binary, info: await verifyNodeRuntime(binary) };
  }
  const cache = resolve(repo, ".local/macos-runtime");
  const archive = resolve(cache, nodeArchive);
  await mkdir(cache, { recursive: true });
  if (!(await exists(archive))) {
    console.log(`下载官方 Node ${nodeVersion} arm64 runtime。`);
    const response = await fetch(
      `https://nodejs.org/dist/v${nodeVersion}/${nodeArchive}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok)
      throw new Error(`Node runtime 下载失败：HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== nodeChecksum)
      throw new Error("官方 Node runtime SHA-256 不匹配");
    await writeFile(archive + ".tmp", data);
    await rename(archive + ".tmp", archive);
  }
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  if (digest !== nodeChecksum)
    throw new Error("缓存 Node runtime SHA-256 不匹配；请重新获取官方归档");
  const runtime = resolve(cache, `node-v${nodeVersion}-darwin-arm64`);
  await rm(runtime, { recursive: true, force: true });
  await run("tar", ["-xzf", archive, "-C", cache]);
  const binary = resolve(runtime, "bin/node");
  return {
    binary,
    license: resolve(runtime, "LICENSE"),
    info: await verifyNodeRuntime(binary),
  };
}

// Explicit allowlist: development data and machine credentials never enter Resources.
export async function copyServerResources(source, destination) {
  for (const path of [
    "dist",
    "src/server",
    "src/shared",
    "package.json",
    "package-lock.json",
    "scripts/agent-hook.mjs",
    "scripts/prepare-pty.mjs",
  ]) {
    const target = resolve(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(source, path), target, {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

export async function auditResources(root) {
  const canonicalRoot = await realpath(root);
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name);
      if (
        /^\.env(?:\.|$)|^(?:console-token|server-token|server\.lock|\.credentials\.json)$|\.(?:sqlite(?:-(?:wal|shm))?|db|jsonl|pem|key)$/.test(
          entry.name,
        )
      )
        throw new Error(`App Resources 包含私有文件：${relative(root, path)}`);
      if (entry.isSymbolicLink()) {
        const target = relative(canonicalRoot, await realpath(path));
        if (
          target === ".." ||
          target.startsWith(".." + sep) ||
          isAbsolute(target)
        )
          throw new Error(
            `App Resources 链接指向包外：${relative(root, path)}`,
          );
      } else if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
}

export function higherVersion(a, b) {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0))
      return (left[i] ?? 0) > (right[i] ?? 0) ? a : b;
  }
  return a;
}

async function check() {
  for (const path of [
    "macos/RelayApp/Package.swift",
    "macos/RelayApp/Sources/RelayApp/main.swift",
    "macos/RelayApp/Resources/Info.plist",
    "macos/RelayApp/Resources/Relay.entitlements",
    "macos/RelayApp/Resources/Relay.icns",
    "scripts/agent-hook.mjs",
  ])
    if (!(await exists(resolve(repo, path))))
      throw new Error(`缺少 macOS 资源：${path}`);
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("macOS 打包要求 macOS arm64 主机");
  if (!(await exists(resolve(repo, "node_modules/node-pty"))))
    throw new Error("缺少 node-pty，先运行 npm ci");
  if (process.env.RELAY_RELEASE === "1")
    throw new Error(
      "当前仅实现开发打包；Developer ID 签名、公证与生产更新流水线尚未完成，禁止作为正式发布",
    );
  console.log("macOS 资源检查通过（开发构建，生产发布另需签名、公证验收）。");
}

async function build() {
  await check();
  const runtime = await nodeRuntime();
  await run("npm", ["run", "build"]);
  await run("swift", [
    "build",
    "--configuration",
    "release",
    "--package-path",
    "macos/RelayApp",
    "--arch",
    "arm64",
  ]);
  const { stdout: binDirectory } = await exec(
    "swift",
    [
      "build",
      "--configuration",
      "release",
      "--package-path",
      "macos/RelayApp",
      "--arch",
      "arm64",
      "--show-bin-path",
    ],
    { cwd: repo },
  );
  const binary = resolve(binDirectory.trim(), "RelayApp");
  const framework = resolve(binDirectory.trim(), "Sparkle.framework");
  if (!(await exists(binary)) || !(await exists(framework)))
    throw new Error("SwiftPM 未生成 RelayApp 或 Sparkle.framework");
  const staging = resolve(output, "Relay.staging.app");
  await rm(staging, { recursive: true, force: true });
  const contents = resolve(staging, "Contents");
  const resources = resolve(contents, "Resources");
  try {
    await mkdir(resolve(contents, "MacOS"), { recursive: true });
    await mkdir(resolve(contents, "Frameworks"), { recursive: true });
    await mkdir(resolve(resources, "node/bin"), { recursive: true });
    await cp(binary, resolve(contents, "MacOS/RelayApp"));
    await cp(resolve(repo, "macos/RelayApp/Resources/Relay.icns"), resolve(resources, "Relay.icns"));
    await cp(resolve(repo, "LICENSE"), resolve(resources, "LICENSE"));
    await cp(resolve(repo, "THIRD_PARTY_NOTICES.md"), resolve(resources, "THIRD_PARTY_NOTICES.md"));
    await cp(framework, resolve(contents, "Frameworks/Sparkle.framework"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    await copyServerResources(repo, resolve(resources, "server"));
    await run(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: resolve(resources, "server") },
    );
    await cp(runtime.binary, resolve(resources, "node/bin/node"));
    await chmod(resolve(resources, "node/bin/node"), 0o755);
    if (runtime.license)
      await cp(runtime.license, resolve(resources, "node/LICENSE"));
    await run(resolve(resources, "node/bin/node"), [
      resolve(resources, "server/scripts/prepare-pty.mjs"),
    ]);
    let minimum = higherVersion("13.0", runtime.info.minimum);
    for (const path of [
      resolve(contents, "MacOS/RelayApp"),
      resolve(contents, "Frameworks/Sparkle.framework/Sparkle"),
      resolve(
        resources,
        "server/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      ),
      resolve(
        resources,
        "server/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      ),
      resolve(
        resources,
        "server/node_modules/@esbuild/darwin-arm64/bin/esbuild",
      ),
    ]) {
      const info = await macho(path);
      minimum = higherVersion(minimum, info.minimum);
      if (
        info.nonSystem.some(
          (library) => !library.startsWith("@rpath/Sparkle.framework/"),
        )
      )
        throw new Error(`${basename(path)} 引用了包外动态库`);
    }
    const { version } = JSON.parse(
      await readFile(resolve(repo, "package.json"), "utf8"),
    );
    let plist = await readFile(
      resolve(repo, "macos/RelayApp/Resources/Info.plist"),
      "utf8",
    );
    plist = plist
      .replace(
        /(<key>LSMinimumSystemVersion<\/key>\s*<string>)[^<]+/,
        `$1${minimum}`,
      )
      .replace(
        /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+/,
        `$1${version}`,
      );
    await writeFile(resolve(contents, "Info.plist"), plist);
    await auditResources(resources);
    await run("plutil", ["-lint", resolve(contents, "Info.plist")]);
    // Apple Silicon executes an ad-hoc signed development bundle; this is not Developer ID signing.
    await run("codesign", ["--force", "--sign", "-", staging]);
    await run("codesign", ["--verify", "--deep", "--strict", staging]);
    await rm(app, { recursive: true, force: true });
    await rename(staging, app);
    console.log(
      `已生成开发版 ${app}（arm64，macOS ${minimum}+，Node ${runtime.info.version}）。`,
    );
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const mode = process.argv[2] ?? "--check";
  if (mode === "--check") await check();
  else if (mode === "--app" || mode === "--dmg") {
    await build();
    if (mode === "--dmg") {
      const folder = resolve(output, "dmg-staging");
      await rm(folder, { recursive: true, force: true });
      await mkdir(folder, { recursive: true });
      try {
        await cp(app, resolve(folder, "Relay.app"), {
          recursive: true,
          verbatimSymlinks: true,
        });
        const { symlink } = await import("node:fs/promises");
        await symlink("/Applications", resolve(folder, "Applications"));
        await run("hdiutil", [
          "create",
          "-volname",
          "Relay",
          "-srcfolder",
          folder,
          "-ov",
          resolve(output, "Relay-arm64.dmg"),
        ]);
        await run("shasum", ["-a", "256", resolve(output, "Relay-arm64.dmg")]);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    }
  } else throw new Error(`未知模式：${mode}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
