import {
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fingerprintFile } from "../src/server/snapshot.ts";
const mode = process.argv[2] ?? "parent",
  dir = resolve(".local/performance/snapshot");
await mkdir(dir, { recursive: true });
if (mode === "parent") {
  const file = join(dir, "large.bin");
  await writeFile(file, Buffer.alloc(128 * 1024 * 1024, 42));
  for (let i = 0; i < 1000; i++)
    await writeFile(join(dir, `small-${i}`), "small file\n");
  const results = [];
  for (const variant of ["before", "after"])
    results.push(
      JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", "tsx", import.meta.filename, variant],
          { encoding: "utf8" },
        ),
      ),
    );
  await writeFile(join(dir, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} else {
  const digest = async (path: string) =>
    mode === "after"
      ? await fingerprintFile(path)
      : createHash("sha256")
          .update("100644")
          .update("\0")
          .update(await readFile(path))
          .digest("hex");
  const times = [];
  let hash: string | undefined;
  const begin = performance.now();
  for (let i = 0; i < 4; i++) {
    const start = performance.now();
    hash = await digest(join(dir, "large.bin"));
    times.push(performance.now() - start);
  }
  const smallStart = performance.now();
  for (let i = 0; i < 1000; i++) await digest(join(dir, `small-${i}`));
  console.log(
    JSON.stringify({
      mode,
      hash,
      largeMs: times,
      smallMs: performance.now() - smallStart,
      totalMs: performance.now() - begin,
      memory: process.memoryUsage(),
      maxRSS: process.resourceUsage().maxRSS,
    }),
  );
}
