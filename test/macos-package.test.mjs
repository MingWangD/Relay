import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditResources,
  copyServerResources,
  higherVersion,
  parseMachO,
  verifyNodeRuntime,
} from "../scripts/package-macos.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "relay-package-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("packaged server keeps lifecycle hooks, omits development data and host dependencies", async (t) => {
  const root = await fixture(t),
    source = join(root, "source"),
    target = join(root, "target");
  const files = [
    "dist/index.html",
    "src/server/main.ts",
    "src/shared/types.ts",
    "package.json",
    "package-lock.json",
    "scripts/agent-hook.mjs",
    "scripts/prepare-pty.mjs",
  ];
  for (const file of [
    ...files,
    ".local/relay.sqlite",
    ".env",
    "node_modules/host-marker",
    "scripts/private.key",
  ]) {
    await mkdir(join(source, file, ".."), { recursive: true });
    await writeFile(join(source, file), file);
  }
  await copyServerResources(source, target);
  for (const file of files)
    assert.equal(await readFile(join(target, file), "utf8"), file);
  for (const file of [".local", ".env", "node_modules", "scripts/private.key"])
    await assert.rejects(stat(join(target, file)));
  await auditResources(target);
});

test("resource audit rejects credentials and external links but accepts internal executable links", async (t) => {
  const root = await fixture(t),
    resources = join(root, "Resources");
  await mkdir(resources);
  await writeFile(join(resources, "main.js"), "");
  await symlink("main.js", join(resources, "internal"));
  await auditResources(resources);
  await writeFile(join(resources, "console-token"), "private-test-marker");
  await assert.rejects(auditResources(resources), /私有文件/);
  await rm(join(resources, "console-token"));
  await symlink(root, join(resources, "escape"));
  await assert.rejects(auditResources(resources), /包外/);
});

test("Mach-O inspection exposes Homebrew dependencies and actual minimum OS", () => {
  const info = parseMachO(
    "node:\n\t@rpath/libnode.dylib (compatibility version 0.0.0)\n\t/opt/homebrew/lib/libuv.dylib (compatibility version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n",
    "cmd LC_BUILD_VERSION\n platform 1\n minos 13.5\n sdk 26.0",
  );
  assert.deepEqual(info.nonSystem, [
    "@rpath/libnode.dylib",
    "/opt/homebrew/lib/libuv.dylib",
  ]);
  assert.equal(info.minimum, "13.5");
  assert.equal(higherVersion("13.0", "13.5"), "13.5");
  assert.equal(higherVersion("13.5", "13.10"), "13.10");
  assert.throws(() => parseMachO("", ""), /最低系统版本/);
});

test(
  "host Node with external libraries cannot become the embedded runtime",
  { skip: process.platform !== "darwin" },
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout: libraries } = await promisify(execFile)("otool", [
      "-L",
      process.execPath,
    ]);
    if (/\/opt\/homebrew\/|@rpath\/libnode/.test(libraries))
      await assert.rejects(verifyNodeRuntime(process.execPath), /包外动态库/);
    else
      assert.equal((await verifyNodeRuntime(process.execPath)).arch, "arm64");
  },
);
