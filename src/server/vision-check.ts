import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  visionChallenge,
  recordVision,
  configurationIdentity,
} from "./vision.ts";
import { Store, ensure, redact } from "./store.ts";
import { Auth } from "./auth.ts";
import { NativeRuntime } from "./runtime.ts";
import type { Runtime } from "./runtime.ts";
import { Service } from "./service.ts";
import { git, GitService } from "./git.ts";
import { createHttp } from "./http.ts";
import type {
  MemberConfig,
  PermissionMode,
  VisionCapability,
} from "../shared/types.ts";
const running = new Set<string>();
const activeChecks = new WeakMap<
  Service,
  Set<{ cancel: () => void; done: Promise<void> }>
>();
export async function stopVisionChecks(owner: Service) {
  const checks = [...(activeChecks.get(owner) ?? [])];
  for (const check of checks) check.cancel();
  await Promise.all(checks.map((check) => check.done));
}
const diagnostics = new WeakMap<
  Service,
  Map<string, { service: Service; agentId: string; manual: boolean }>
>();
function diagnostic(owner: Service, provider: string) {
  const item = diagnostics.get(owner)?.get(provider);
  ensure(item, "VISION_CHECK_IDLE", "当前没有运行中的图片验证", 404);
  return item;
}
export async function visionTerminal(owner: Service, provider: string) {
  const { service, agentId, manual } = diagnostic(owner, provider);
  const agent = service.store.state.agents.find((a) => a.id === agentId)!;
  const snapshot = await service.runtime.snapshot(agentId);
  return {
    ...snapshot,
    data: redact(snapshot.data),
    manual,
    attention: redact(
      agent.attention ?? agent.nativeError ?? agent.connectionWarning ?? "",
    ),
    approvals: service.store
      .publicState()
      .approvals.filter((a) => a.agentId === agentId && a.status === "pending"),
  };
}
export function visionTerminalInput(
  owner: Service,
  provider: string,
  generation: string,
  input: {
    manual?: boolean;
    data?: string;
    approvalId?: string;
    accepted?: boolean;
  },
) {
  const item = diagnostic(owner, provider),
    agent = item.service.store.state.agents.find((a) => a.id === item.agentId)!;
  ensure(
    agent.generation === generation && item.service.runtime.has(agent.id),
    "STALE_GENERATION",
    "验证会话已改变",
    409,
  );
  if (input.manual !== undefined) item.manual = input.manual;
  if (input.approvalId)
    item.service.approveRequest(input.approvalId, !!input.accepted);
  if (input.data) {
    ensure(item.manual, "MANUAL_REQUIRED", "先开启验证终端的人工接管", 403);
    item.service.runtime.write(agent.id, input.data);
  }
  return { ok: true };
}
export async function verifyVision(
  owner: Service,
  member: MemberConfig,
  permissionMode: PermissionMode,
  runtimeFactory: (dataDir: string) => Runtime = (dataDir) =>
    new NativeRuntime(dataDir),
): Promise<VisionCapability> {
  const root = owner.store.state.project?.root ?? "",
    key = root + ":" + member.provider;
  ensure(
    !running.has(key),
    "VISION_CHECK_BUSY",
    "此提供商正在验证图片能力",
    409,
  );
  running.add(key);
  let isolated: Service | undefined,
    app: Awaited<ReturnType<typeof createHttp>> | undefined,
    store: Store | undefined;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  let finish!: () => void;
  const stop = {
    cancel,
    done: new Promise<void>((resolve) => (finish = resolve)),
  };
  let checks = activeChecks.get(owner);
  if (!checks) {
    checks = new Set();
    activeChecks.set(owner, checks);
  }
  checks.add(stop);
  owner.store.once("closing", cancel);
  try {
    const identity = await configurationIdentity(member.provider, root);
    const base = join(owner.work.dataDir, "vision-checks");
    await mkdir(base, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(base, "check-")),
      repo = join(directory, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Relay Vision Check");
    await git(repo, "config", "user.email", "vision@localhost");
    await writeFile(
      join(repo, "README.md"),
      "# Isolated image capability check\n",
    );
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "image check fixture");
    store = new Store(join(directory, "state.sqlite"));
    isolated = new Service(
      store,
      new Auth(directory),
      new GitService(directory),
      runtimeFactory(directory),
      false,
    );
    app = await createHttp(isolated, {
      port: 0,
      root: join(import.meta.dirname, "../.."),
    });
    await isolated.createProject(repo, "独立图片能力验证");
    const { id } = await isolated.addAgent(
      "图片能力验证",
      member.provider,
      "验证者",
    );
    store.mutate((s) =>
      Object.assign(
        s.agents.find((a) => a.id === id)!,
        member,
        { id, permissionMode },
      ),
    );
    const challenge = visionChallenge(),
      requestId = randomUUID(),
      batchId = randomUUID();
    const attachment = await isolated.attachments.upload(
      store.state.defaultConversationId,
      `image-${challenge.nonce}.png`,
      challenge.bytes,
    );
    store.mutate((s) => {
      s.paused = true;
      s.activeRequestId = requestId;
      isolated!.attachments.bind(
        s,
        s.defaultConversationId,
        [attachment.id],
        requestId,
      );
      s.userRequests.push({
        id: requestId,
        conversationId: s.defaultConversationId,
        text: "独立图片验证",
        status: "planning",
        createdAt: new Date().toISOString(),
        agentIds: [id],
        version: 0,
        rounds: 0,
        attachmentIds: [attachment.id],
        vision: {
          agentId: id,
          batches: [
            { id: batchId, attachmentIds: [attachment.id], status: "running" },
          ],
        },
        control: {
          agentId: id,
          kind: "vision",
          startedAt: new Date().toISOString(),
        },
      });
    });
    const memberAgent = store.state.agents.find((a) => a.id === id)!;
    const cwd = await isolated.work.planningWorkspace(store.state.project!, id);
    let sessions = diagnostics.get(owner);
    if (!sessions) {
      sessions = new Map();
      diagnostics.set(owner, sessions);
    }
    sessions.set(member.provider, {
      service: isolated,
      agentId: id,
      manual: false,
    });
    ensure(!cancelled, "VISION_CHECK_CANCELLED", "图片验证已停止");
    await isolated.startSession({
      agent: memberAgent,
      cwd,
      url: isolated.url,
      token: isolated.auth.issue(id),
      readOnly: true,
      prompt: `独立图片能力测试。必须调用 relay.read_attachment(attachmentId=${attachment.id}) 实际查看图片。读出图片中从左到右的六位数字，然后调用 relay.submit_vision_analysis(requestId=${requestId},batchId=${batchId},analysis=仅六位数字)。不要读取图片文件的原始字节、不要运行 OCR 或生成读取脚本、不要猜测；不修改任何文件。无法识别则如实说明。调用成功后结束轮次。`,
    });
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !cancelled) {
      const batch = store.state.userRequests[0].vision!.batches[0];
      if (batch.status === "completed") {
        if (identity !== (await configurationIdentity(member.provider, root)))
          return {
            status: "unknown",
            source: "验证期间模型配置改变，请重新验证",
          };
        return recordVision(
          member.provider,
          member.model,
          root,
          batch.analysis?.trim() === challenge.answer,
          identity,
        );
      }
      const agent = store.state.agents.find((a) => a.id === id)!;
      if (agent.status === "error")
        throw Error(agent.error ?? "原生模型调用失败");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return {
      status: "unknown",
      source: cancelled
        ? "验证已停止，图片能力未确认"
        : "验证超时；检查登录、原生审批或模型连接后重试",
    };
  } catch (error) {
    return {
      status: "unknown",
      source: "验证未完成：" + redact((error as Error).message).slice(0, 180),
    };
  } finally {
    diagnostics.get(owner)?.delete(member.provider);
    owner.store.removeListener("closing", cancel);
    let cleanupFailed = false;
    try {
      if (isolated) await isolated.stopAll();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (app) await app.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      store?.close();
    } finally {
      running.delete(key);
      checks.delete(stop);
      finish();
    }
    ensure(
      !cleanupFailed,
      "VISION_CHECK_CLEANUP",
      "验证进程未完整退出，请检查后重试",
      500,
    );
  }
}
