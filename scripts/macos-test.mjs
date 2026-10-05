import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(join(tmpdir(), "relay-swift-tests-"));
try {
  const binary = join(dir, "import-checks");
  await exec("swiftc", [
    "-parse-as-library",
    "-target",
    "arm64-apple-macosx13.0",
    resolve(root, "macos/RelayApp/Sources/RelayApp/DataImport.swift"),
    resolve(root, "macos/RelayApp/Tests/RelayAppTests/DataImportChecks.swift"),
    "-o",
    binary,
  ]);
  const { stdout } = await exec(binary, []);
  process.stdout.write(stdout);
} finally {
  await rm(dir, { recursive: true, force: true });
}
