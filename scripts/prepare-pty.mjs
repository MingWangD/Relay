import { chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (process.platform !== "win32") {
  // node-pty 1.1.0 ships a non-executable spawn-helper in its npm prebuild.
  for (const folder of [
    `prebuilds/${process.platform}-${process.arch}`,
    "build/Release",
  ]) {
    const path = fileURLToPath(
      new URL(
        `../node_modules/node-pty/${folder}/spawn-helper`,
        import.meta.url,
      ),
    );
    if (existsSync(path)) chmodSync(path, 0o755);
  }
}
