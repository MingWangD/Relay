import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, open, unlink, readFile } from "node:fs/promises";
import { Store } from "./store.ts";
import { Auth } from "./auth.ts";
import { GitService } from "./git.ts";
import { NativeRuntime } from "./runtime.ts";
import { Service } from "./service.ts";
import { createHttp } from "./http.ts";
import {
  parseServerOptions,
  removeReadyFile,
  writeReadyFile,
} from "./desktop.ts";
import { DESKTOP_PROTOCOL_VERSION } from "../shared/desktop.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseServerOptions(process.argv.slice(2), process.env, root);
const dir = options.dataDir;
await mkdir(dir, { recursive: true, mode: 0o700 });
const lockPath = resolve(dir, "server.lock");
try {
  const file = await open(lockPath, "wx", 0o600);
  await file.writeFile(String(process.pid));
  await file.close();
} catch {
  let alive = false;
  try {
    process.kill(Number(await readFile(lockPath, "utf8")), 0);
    alive = true;
  } catch {}
  if (alive) throw new Error("该数据目录已有 Relay 服务，不能重复启动");
  await unlink(lockPath).catch(() => {});
  const f = await open(lockPath, "wx", 0o600);
  await f.writeFile(String(process.pid));
  await f.close();
}
const store = new Store(resolve(dir, "relay.sqlite"));
const auth = new Auth(dir);
const runtime = new NativeRuntime(dir);
const service = new Service(store, auth, new GitService(dir), runtime);
service.recover();
const app = await createHttp(service, {
  port: options.port,
  dev: options.dev,
  root: options.root,
});
try {
  if (options.readyFile) {
    const ready = new URL(app.url);
    await writeReadyFile(options.readyFile, {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      pid: process.pid,
      port: Number(ready.port),
      url: app.url,
      token: auth.consoleToken,
    });
    console.log(`Relay 服务已就绪（本机端口 ${ready.port}）`);
  } else {
    console.log(
      `\nRelay 本地协作控制台\n${app.url}/#token=${auth.consoleToken}\n\n数据保存在 ${dir}\n仅监听本机。关闭浏览器不会停止任务。\n`,
    );
  }
} catch (error) {
  await app.close().catch(() => {});
  store.close();
  await unlink(lockPath).catch(() => {});
  await removeReadyFile(options.readyFile);
  throw error;
}
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await service.stopAll();
  await app.close();
  store.close();
  await unlink(lockPath).catch(() => {});
  await removeReadyFile(options.readyFile);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
