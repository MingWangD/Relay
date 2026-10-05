import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { git, GitService } from "../src/server/git.ts";
import { Store } from "../src/server/store.ts";
import { Auth } from "../src/server/auth.ts";
import { Service } from "../src/server/service.ts";
import type { Runtime, StartOptions } from "../src/server/runtime.ts";
export class TestRuntime extends EventEmitter implements Runtime {
  sessions = new Map<string, StartOptions>();
  starts: StartOptions[] = [];
  sent: { id: string; text: string }[] = [];
  async start(o: StartOptions) {
    this.sessions.set(o.agent.id, o);
    this.starts.push(o);
    this.emit("event", {
      agentId: o.agent.id,
      type: "connected",
      sessionId: `session-${o.agent.id}`,
      pid: 9999999,
    });
    this.emit("event", { agentId: o.agent.id, type: "started" });
    return { pid: 9999999, sessionId: `session-${o.agent.id}` };
  }
  async send(id: string, text: string, _token?: string) {
    this.sent.push({ id, text });
    return true;
  }
  async stop(id: string) {
    this.sessions.delete(id);
  }
  async interrupt(id: string) {
    await this.stop(id);
  }
  has(id: string) {
    return this.sessions.has(id);
  }
  scroll?: (
    agentId: string,
    generation: string,
    direction: "up" | "down",
    count: number,
    col: number,
    row: number,
  ) => void;
  write(..._args: unknown[]) {}
  resize() {}
  approve() {}
  observeLifecycle() {}
  snapshot(_agentId: string) {
    return { generation: "test", seq: 0, cols: 100, rows: 28, data: "" };
  }
}
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-test-"));
  const repo = join(root, "repo");
  await import("node:fs/promises").then((fs) => fs.mkdir(repo));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@localhost");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "hello.txt"), "base\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  const data = join(root, "data");
  const store = new Store(join(data, "state.sqlite"));
  const runtime = new TestRuntime();
  const service = new Service(
    store,
    new Auth(data),
    new GitService(data),
    runtime,
    false,
  );
  service.url = "http://127.0.0.1:12345";
  await service.createProject(repo, "测试并行协作");
  // Unit tests inject capability records, never launch paid model calls.
  function agent(name = "Codex") {
    const id = crypto.randomUUID();
    store.mutate((s) =>
      s.agents.push({
        id,
        name,
        provider: "codex",
        role: "开发者",
        status: "offline",
        manual: false,
      }),
    );
    return id;
  }
  const task = (
    ownerId: string,
    title = "实现功能",
    dependencies: string[] = [],
  ) =>
    service.addTask({
      ownerId,
      title,
      description: "在工作区创建成果",
      acceptance: "验证成果并整合",
      dependencies,
    }).id;
  async function cleanup() {
    await service.stopAll();
    store.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
  return { root, repo, data, store, runtime, service, agent, task, cleanup };
}
export async function until(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5000) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}
