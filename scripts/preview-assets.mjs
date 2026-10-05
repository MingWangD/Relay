import { readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("Invalid release version");
const git = async (...args) =>
  (await exec("git", args, { cwd: root })).stdout.trim();
if (await git("status", "--porcelain"))
  throw Error("Release source must be committed and clean");
const commit = await git("rev-parse", "HEAD");
const app = join(root, "dist-macos/Relay.app");
const plist = join(app, "Contents/Info.plist");
const field = async (key) =>
  (
    await exec("plutil", ["-extract", key, "raw", "-o", "-", plist])
  ).stdout.trim();
if ((await field("CFBundleShortVersionString")) !== version)
  throw Error("App does not match source version");
const build = await field("CFBundleVersion");
if (!/^\d+$/.test(build)) throw Error("Invalid build number");
await exec("codesign", ["--verify", "--deep", "--strict", app]);
await exec("hdiutil", ["verify", join(root, "dist-macos/Relay-arm64.dmg")]);
const out = join(root, "dist-macos/releases", `v${version}`);
await mkdir(out, { recursive: true });
const stem = `Relay-${version}-macos-arm64`;
await copyFile(
  join(root, "dist-macos/Relay-arm64.dmg"),
  join(out, stem + ".dmg"),
);
await exec("ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  app,
  join(out, stem + ".zip"),
]);
const files = [];
for (const name of [stem + ".dmg", stem + ".zip"]) {
  const data = await readFile(join(out, name));
  files.push({
    name,
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
await writeFile(
  join(out, "SHA256SUMS.txt"),
  files.map((f) => `${f.sha256}  ${f.name}\n`).join(""),
);
await mkdir(join(root, ".local"), { recursive: true });
await writeFile(
  join(root, ".local/preview-manifest.json"),
  JSON.stringify(
    {
      version,
      build,
      commit,
      minimum: await field("LSMinimumSystemVersion"),
      files,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ version, build, commit, output: out, files }, null, 2),
);
