import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (!["--draft", "--publish"].includes(mode))
  throw Error("Use --draft or --publish");
const manifest = JSON.parse(
  await readFile(join(root, ".local/preview-manifest.json"), "utf8"),
);
const tag = `v${manifest.version}`;
const run = async (...args) =>
  (await exec("gh", args, { cwd: root, maxBuffer: 1024 * 1024 })).stdout.trim();
const git = async (...args) =>
  (await exec("git", args, { cwd: root })).stdout.trim();
if (await git("status", "--porcelain"))
  throw Error("Release source is no longer clean");
if (
  (await git("rev-parse", "HEAD")) !== manifest.commit ||
  (await git("rev-parse", `${tag}^{commit}`)) !== manifest.commit
)
  throw Error("Tag/source/asset commit mismatch");
const directory = join(root, "dist-macos/releases", tag);
for (const f of manifest.files) {
  const data = await readFile(join(directory, f.name));
  if (createHash("sha256").update(data).digest("hex") !== f.sha256)
    throw Error("Asset checksum mismatch");
}
if (mode === "--draft") {
  let exists = false;
  try {
    await run("release", "view", tag);
    exists = true;
  } catch {}
  if (exists)
    throw Error("Release already exists; never overwrite an existing version");
  await run(
    "release",
    "create",
    tag,
    "--verify-tag",
    "--draft",
    "--prerelease",
    "--title",
    `Relay ${manifest.version} — Development Preview`,
    "--notes-file",
    join(root, "docs/RELEASE_NOTES.md"),
  );
  await run(
    "release",
    "upload",
    tag,
    ...manifest.files.map((f) => join(directory, f.name)),
    join(directory, "SHA256SUMS.txt"),
  );
}
const release = JSON.parse(
  await run(
    "release",
    "view",
    tag,
    "--json",
    "isDraft,isPrerelease,assets,url",
  ),
);
if (!release.isDraft || !release.isPrerelease)
  throw Error("Expected an unpublished preview draft");
const expected = [...manifest.files.map((f) => f.name), "SHA256SUMS.txt"];
if (
  release.assets.length !== 3 ||
  expected.some((n) => !release.assets.some((a) => a.name === n && a.size > 0))
)
  throw Error("Draft assets incomplete");
if (mode === "--publish") {
  for (const f of manifest.files) {
    const asset = release.assets.find((a) => a.name === f.name);
    if (asset.size !== f.size) throw Error("Uploaded asset size mismatch");
  }
  await run("release", "edit", tag, "--draft=false", "--prerelease");
}
console.log(
  await run(
    "release",
    "view",
    tag,
    "--json",
    "url,isDraft,isPrerelease,assets",
  ),
);
