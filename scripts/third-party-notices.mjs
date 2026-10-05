import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);
let notice =
  "# Third-party notices\n\nRelay is licensed under MIT. Bundled components retain their own licenses. Vendor license files remain in the distribution. This list covers the installed production JavaScript packages, embedded Node and Sparkle. Development-only tools are not shipped.\n\n";
const seen = new Set();
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev) continue;
  const directory = join(root, location);
  let manifest, files;
  try {
    manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    files = await readdir(directory);
  } catch {
    continue;
  }
  const key = manifest.name + "@" + manifest.version;
  if (seen.has(key)) continue;
  seen.add(key);
  notice += `## ${key}\n\nDeclared license: ${typeof manifest.license === "string" ? manifest.license : JSON.stringify(manifest.license ?? "see vendor files")}.\n\n`;
  for (const name of files
    .filter((x) => /^(license|licence|copying|notice)(\.[a-z]+)?$/i.test(x))
    .sort()) {
    try {
      notice += `### ${name}\n\n\`\`\`text\n${(await readFile(join(directory, name), "utf8")).trim()}\n\`\`\`\n\n`;
    } catch {}
  }
}
const nodeLicense = join(
  root,
  ".local/macos-runtime/node-v24.21.0-darwin-arm64/LICENSE",
);
let nodeText;
try {
  nodeText = await readFile(nodeLicense, "utf8");
} catch {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const archive = join(
    root,
    ".local/macos-runtime/node-v24.21.0-darwin-arm64.tar.gz",
  );
  nodeText = (
    await promisify(execFile)(
      "tar",
      ["-xOf", archive, "node-v24.21.0-darwin-arm64/LICENSE"],
      { maxBuffer: 2 * 1024 * 1024 },
    )
  ).stdout;
}
notice += "## Node 24.21.0\n\n```text\n" + nodeText.trim() + "\n```\n\n";
const sparkle = await readFile(
  join(root, "macos/RelayApp/.build/artifacts/sparkle/Sparkle/LICENSE"),
  "utf8",
);
notice += "## Sparkle 2.10.0\n\n```text\n" + sparkle.trim() + "\n```\n";
await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), notice);
console.log(
  `Third-party notices: ${seen.size} JavaScript packages, Node and Sparkle.`,
);
