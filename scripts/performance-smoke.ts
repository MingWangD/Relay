// Isolated synthetic measurements; no model calls or user database access.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
const variant = process.argv[2] ?? "after";
const dir = resolve(".local/performance", variant);
await mkdir(dir, { recursive: true });
let source =
  variant === "before"
    ? execFileSync("git", ["show", "v0.1.4:src/server/store.ts"], {
        encoding: "utf8",
      })
    : await readFile("src/server/store.ts", "utf8");
source = source.replaceAll(
  '"../shared/types.ts"',
  JSON.stringify(resolve("src/shared/types.ts")),
);
source = source.replace(
  "const next = this.state;",
  "const start = performance.now(); let mark = start; const metric: Record<string, number> = {}; const next = this.state; metric.clone = performance.now() - mark; mark = performance.now();",
);
source = source.replace(
  "next.revision++;",
  "metric.compareAndNormalize = performance.now() - mark; mark = performance.now(); next.revision++;",
);
source = source.replace(
  ".run(JSON.stringify(next));",
  ".run((() => { const begin = performance.now(); const json = JSON.stringify(next); metric.serialize = performance.now() - begin; return json; })());",
);
source = source.replace(
  "this.current = next;",
  "metric.transaction = performance.now() - mark; mark = performance.now(); this.current = next;",
);
source = source.replace(
  'this.emit("change", this.publicState());',
  'const view = this.publicState(); metric.publicState = performance.now() - mark; mark = performance.now(); this.emit("change", view); metric.publish = performance.now() - mark; metric.total = performance.now() - start; (globalThis as any).relayMetric = metric;',
);
const modulePath = join(dir, "instrumented-store.ts");
await writeFile(modulePath, source);
const { Store } = await import(pathToFileURL(modulePath).href);
const results = [];
for (const mib of [1, 10, 50]) {
  const path = join(dir, `${mib}.sqlite`);
  await rm(path, { force: true });
  const store = new Store(path);
  store.mutate((state: any) => {
    const detail = "合成历史 ".repeat(8192);
    state.events = Array.from(
      { length: Math.ceil((mib * 1024 * 1024) / Buffer.byteLength(detail)) },
      (_, i) => ({
        seq: i + 1,
        type: "benchmark",
        at: new Date().toISOString(),
        detail,
      }),
    );
  });
  let broadcastBytes = 0;
  store.on("change", (state: unknown) => {
    const message =
      typeof store.publicMessage === "function"
        ? store.publicMessage()
        : JSON.stringify({ type: "state", state });
    broadcastBytes = Buffer.byteLength(message);
  });
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const samples: Record<string, number>[] = [];
  let rss = 0,
    external = 0;
  for (let i = 0; i < 14; i++) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    store.mutate((state: any) => {
      state.paused = !state.paused;
    });
    // Model an HTTP state read and one reconnect at the same committed revision.
    const begin = performance.now();
    store.publicState();
    typeof store.publicMessage === "function"
      ? store.publicMessage()
      : JSON.stringify({ type: "state", state: store.publicState() });
    const sample = {
      ...(globalThis as any).relayMetric,
      sameRevisionReads: performance.now() - begin,
    };
    if (i > 1) samples.push(sample);
    const memory = process.memoryUsage();
    rss = Math.max(rss, memory.rss);
    external = Math.max(external, memory.external);
  }
  delay.disable();
  const times = Object.fromEntries(
    Object.keys(samples[0]).map((key) => {
      const values = samples.map((s) => s[key]).sort((a, b) => a - b);
      return [
        key,
        {
          p50: values[Math.floor(values.length * 0.5)],
          p95: values[Math.ceil(values.length * 0.95) - 1],
        },
      ];
    }),
  );
  results.push({
    mib,
    samples: samples.length,
    broadcastBytes,
    rss,
    external,
    eventLoopP95Ms: delay.percentile(95) / 1e6,
    times,
  });
  store.close();
}
await writeFile(
  join(dir, "results.json"),
  JSON.stringify({ variant, node: process.version, results }, null, 2),
);
console.log(
  JSON.stringify(
    results.map(({ mib, times, broadcastBytes, rss, eventLoopP95Ms }) => ({
      mib,
      times,
      broadcastBytes,
      rss,
      eventLoopP95Ms,
    })),
  ),
);
