import { createHash, randomUUID } from "node:crypto";
import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Store, ensure, AppError } from "./store.ts";
import { Auth } from "./auth.ts";
import { GitService } from "./git.ts";
import { NativeRuntime } from "./runtime.ts";
import { Service } from "./service.ts";
import { conversationAgents, conversation } from "./conversations.ts";

interface ProjectConsole {
  service: Service;
  url: string;
  close?: () => Promise<void>;
}

// Each project keeps the existing single-project engine, credentials and database.
// Picking a folder never changes another console's project or native session binding.
export class LocalProjects {
  private consoles = new Map<string, Promise<ProjectConsole>>();
  private children = new Set<ProjectConsole>();
  private closing = false;
  constructor(
    private dataDir: string,
    private root: string,
    private dev = false,
  ) {}
  register(service: Service) {
    if (
      !this.closing &&
      service.store.state.project &&
      !this.consoles.has(service.store.state.project.root)
    )
      this.consoles.set(
        service.store.state.project.root,
        Promise.resolve({ service, url: service.url }),
      );
  }
  allowsOrigin(origin: string) {
    return (
      !this.closing && [...this.children].some((child) => child.url === origin)
    );
  }
  async open(path: string, source: Service, chatId: string) {
    ensure(
      !this.closing,
      "PROJECT_CLOSING",
      "服务正在关闭，请重新启动后选择项目",
      409,
    );
    let info: Awaited<ReturnType<GitService["inspect"]>>;
    try {
      info = await source.work.inspect(path);
    } catch {
      throw new AppError(
        "PROJECT_FOLDER",
        "请选择已有 Git 提交的项目文件夹；所选目录未被修改",
        400,
      );
    }
    ensure(
      !this.closing,
      "PROJECT_CLOSING",
      "服务正在关闭，请重新启动后选择项目",
      409,
    );
    let pending = this.consoles.get(info.root);
    if (!pending) {
      pending = this.create(info.root, source, chatId);
      this.consoles.set(info.root, pending);
    }
    try {
      const item = await pending;
      return {
        url: item.url,
        token: item.service.auth.consoleToken,
        project: {
          id: item.service.store.state.project!.id,
          name: item.service.store.state.project!.name,
        },
      };
    } catch (error) {
      if (this.consoles.get(info.root) === pending)
        this.consoles.delete(info.root);
      throw error;
    }
  }
  private async create(
    path: string,
    source: Service,
    chatId: string,
  ): Promise<ProjectConsole> {
    const config = structuredClone(conversation(source.store.state, chatId));
    const members = structuredClone(
      conversationAgents(source.store.state, chatId),
    );
    const dir = join(
      this.dataDir,
      "projects",
      createHash("sha256").update(path).digest("hex").slice(0, 24),
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, "server.lock");
    try {
      const file = await open(lock, "wx", 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
    } catch {
      let alive = false;
      try {
        process.kill(Number(await readFile(lock, "utf8")), 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
      ensure(
        !alive,
        "PROJECT_RUNNING",
        "此项目空间已有服务，请使用原窗口",
        409,
      );
      await unlink(lock).catch(() => {});
      const file = await open(lock, "wx", 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
    }
    let store: Store | undefined, service: Service | undefined;
    try {
      store = new Store(join(dir, "relay.sqlite"));
      service = new Service(
        store,
        new Auth(dir),
        new GitService(dir),
        new NativeRuntime(dir),
      );
      if (!store.state.project) {
        await service.createProject(path, "等待用户需求");
        store.mutate((s) => {
          s.permissionMode = config.permissionMode;
          s.teamConfigured = config.teamConfigured;
          s.conversations[0].permissionMode = config.permissionMode;
          s.conversations[0].teamConfigured = config.teamConfigured;
          s.agents = members.map((a) => ({
            id: randomUUID(),
            name: a.name,
            provider: a.provider,
            role: a.role,
            model: a.model,
            reasoningEffort: a.reasoningEffort,
            permissionMode: a.permissionMode,
            probe: a.probe,
            conversationId: s.defaultConversationId,
            status: "offline",
            manual: false,
          }));
        });
      }
      ensure(
        store.state.project!.root === path,
        "PROJECT_PATH",
        "项目空间与选择的目录不一致",
      );
      service.recover();
      const { createHttp } = await import("./http.ts");
      const app = await createHttp(service, {
        port: 0,
        root: this.root,
        dev: this.dev,
        projects: this,
      });
      const active = service;
      const ownedStore = store;
      const item: ProjectConsole = {
        service: active,
        url: app.url,
        close: async () => {
          await active.stopAll();
          await app.close();
          ownedStore.close();
          await unlink(lock);
        },
      };
      this.children.add(item);
      return item;
    } catch (error) {
      await service?.stopAll();
      store?.close();
      await unlink(lock).catch(() => {});
      throw error;
    }
  }
  async close() {
    this.closing = true;
    await Promise.allSettled(this.consoles.values());
    const results = await Promise.allSettled(
      [...this.children].map((child) => child.close!()),
    );
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        "项目空间关闭失败",
      );
    this.children.clear();
    this.consoles.clear();
  }
}
