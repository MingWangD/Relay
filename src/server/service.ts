import { conversationAgents, conversationId } from "./conversations.ts";
import { auditProjectFiles, assertAnalysisAudit } from "./snapshot.ts";
import { modelVision } from "./vision.ts";
import { Attachments } from "./attachments.ts";
import { Collaboration } from "./collaboration.ts";
import { randomUUID } from "node:crypto";
import { Store, ensure, AppError, redact } from "./store.ts";
import { Auth, hash } from "./auth.ts";
import { GitService, git, runCheck } from "./git.ts";
import { probe } from "./doctor.ts";
import { approvalPresentation } from "../shared/presentation.ts";
import type { Runtime, RuntimeEvent } from "./runtime.ts";
import {
  now,
  type State,
  type Provider,
  type Task,
  type CommandSpec,
  type Message,
  type TestRun,
} from "../shared/types.ts";

const activeRun = (s: State, id: string) =>
  s.runs.some(
    (r) => r.agentId === id && ["starting", "running"].includes(r.status),
  );
const slots = (s: State) =>
  s.agents.filter(
    (a) =>
      activeRun(s, a.id) ||
      ["starting", "running", "waiting"].includes(a.status),
  ).length;
export class Service {
  readonly collaboration: Collaboration;
  readonly attachments: Attachments;
  url = "";
  private scheduling = false;
  private integrating = false;
  private verifying = new Set<string>();
  private artifactSaves = new Map<string, Promise<unknown>>();
  private checkControllers = new Map<string, AbortController>();
  private flight = new Map<string, Promise<unknown>>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingNativeSend = new Set<string>();
  constructor(
    public store: Store,
    public auth: Auth,
    public work: GitService,
    public runtime: Runtime,
    private autoVerify = true,
  ) {
    runtime.on("event", (event: RuntimeEvent) => this.onRuntimeEvent(event));
    this.attachments = new Attachments(store, work.dataDir);
    this.collaboration = new Collaboration(this);
  }
  recover() {
    this.store.mutate((s) => {
      s.paused = true;
      for (const r of s.userRequests)
        if (!["completed", "failed", "stopped", "queued"].includes(r.status)) {
          r.status = "waiting";
          r.control = undefined;
          for (const batch of r.vision?.batches ?? [])
            if (batch.status === "running") batch.status = "pending";
          r.error = "服务已重启，请检查旧会话和工作区后继续";
        }
      for (const agent of s.agents) {
        agent.attention = undefined;
        agent.messageTurn = undefined;
        if (["offline", "stopped"].includes(agent.status)) agent.manual = false;
        if (agent.status !== "offline" && agent.status !== "stopped") {
          agent.status = "recovery";
          agent.error = "服务已重启。检查保存的 PID 和工作区后再恢复。";
        }
      }
      for (const run of s.runs)
        if (["starting", "running"].includes(run.status)) {
          run.status = "unknown";
          run.reason = "服务重启，执行结果待确认";
        }
      for (const task of s.tasks)
        if (["assigned", "running", "integrating"].includes(task.status)) {
          task.status = "blocked";
          task.error = "执行结果待确认；请检查工作区后重试";
        }
      for (const approval of s.approvals)
        if (approval.status === "pending") approval.status = "declined";
      this.store.event(s, "service.recovered", "本地服务就绪；自动派发已暂停");
    });
    this.reconcileCompletedSessions();
  }
  // A dead idle CLI is not an unfinished task. Preserve its native binding for later resume.
  reconcileCompletedSessions(chatId?: string) {
    const state = this.store.state;
    const settled = new Set(["completed", "failed", "stopped"]);
    const ids = state.agents
      .filter((agent) => {
        const id = conversationId(state, agent);
        if (
          (chatId && id !== chatId) ||
          !["idle", "recovery"].includes(agent.status) ||
          agent.manual ||
          agent.sessionError ||
          this.runtime.has(agent.id) ||
          this.hasPendingConversation(id)
        )
          return false;
        if (
          state.userRequests.some(
            (r) => conversationId(state, r) === id && !settled.has(r.status),
          )
        )
          return false;
        if (
          state.runs.some(
            (r) =>
              r.agentId === agent.id &&
              ["starting", "running", "unknown"].includes(r.status),
          )
        )
          return false;
        if (
          state.tasks.some((t) => {
            if (t.ownerId !== agent.id) return false;
            const request = state.userRequests.find(
              (r) => r.id === t.requestId,
            );
            return (
              (!request || !settled.has(request.status)) &&
              [
                "queued",
                "assigned",
                "running",
                "review",
                "integrating",
                "blocked",
              ].includes(t.status)
            );
          })
        )
          return false;
        if (agent.pid) {
          try {
            process.kill(agent.pid, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
          }
        }
        return true;
      })
      .map((a) => a.id);
    if (!ids.length) return;
    this.store.mutate((s) => {
      for (const agent of s.agents.filter((a) => ids.includes(a.id))) {
        agent.status = "stopped";
        agent.pid = undefined;
        agent.taskId = undefined;
        agent.error = undefined;
        agent.attention = undefined;
        agent.messageTurn = undefined;
        agent.connectionWarning = undefined;
        agent.nativeError = undefined;
        this.auth.revoke(agent.id);
        for (const approval of s.approvals)
          if (approval.agentId === agent.id && approval.status === "pending")
            approval.status = "resolved";
        this.store.event(
          s,
          "agent.settled",
          "已结束会话的原生进程已退出，无需恢复；原生历史绑定保留",
          { agentId: agent.id },
        );
      }
    });
  }
  async request(
    actor: string,
    requestId: string,
    body: unknown,
    operation: () => Promise<unknown>,
  ) {
    ensure(
      requestId && requestId.length <= 128,
      "REQUEST_ID",
      "缺少有效请求标识",
    );
    const key = `${actor}:${requestId}`;
    const digest = hash(JSON.stringify(body));
    const old = this.store.state.requests[key];
    if (old) {
      ensure(
        old.hash === digest,
        "IDEMPOTENCY_CONFLICT",
        "请求标识已用于不同内容",
        409,
      );
      if (this.flight.has(key)) return this.flight.get(key);
      const result = old.result as any;
      if (result?.pending)
        throw new AppError(
          "EXECUTION_UNKNOWN",
          "之前的操作结果待确认，请刷新状态后检查",
          409,
        );
      if (result?.error)
        throw new AppError(
          result.error.code,
          result.error.message,
          result.error.status,
        );
      return result;
    }
    this.store.mutate((s) => {
      s.requests[key] = { hash: digest, result: { pending: true } };
    });
    const promise = (async () => {
      try {
        const result = (await operation()) ?? { ok: true };
        this.store.mutate((s) => {
          s.requests[key].result = result;
        });
        return result;
      } catch (e) {
        const err = e as AppError;
        this.store.mutate((s) => {
          s.requests[key].result = {
            error: {
              code: err.code ?? "INTERNAL",
              message: redact(err.message),
              status: err.status ?? 500,
            },
          };
        });
        throw e;
      } finally {
        this.flight.delete(key);
      }
    })();
    this.flight.set(key, promise);
    return promise;
  }
  private project() {
    const p = this.store.state.project;
    ensure(p, "NO_PROJECT", "请先接入项目");
    return p;
  }
  private idleForEdit() {
    ensure(
      !this.store.state.runs.some((r) =>
        ["starting", "running"].includes(r.status),
      ) &&
        !this.integrating &&
        !this.verifying.size,
      "PROJECT_BUSY",
      "请先停止当前执行，再修改计划",
      409,
    );
  }
  async createProject(path: string, goal: string) {
    this.idleForEdit();
    ensure(
      !this.store.state.project,
      "PROJECT_EXISTS",
      "当前项目空间已有项目；请通过项目右侧的＋选择其他文件夹",
    );
    const project = await this.work.createProject(path, goal);
    this.store.mutate((s) => {
      s.project = project;
      this.store.event(
        s,
        "project.created",
        `已接入 ${project.name}；基线 ${project.base.slice(0, 8)}`,
      );
    });
    return project;
  }
  visionFor = async (
    agent: Pick<import("../shared/types.ts").Agent, "provider" | "model">,
  ) => modelVision(agent, this.store.state.project?.root ?? "");
  async visionMember(ids: string[]) {
    const agents = this.store.state.agents.filter(
      (a) =>
        ids.includes(a.id) &&
        a.probe?.installed !== false &&
        !["error", "recovery"].includes(a.status),
    );
    for (const agent of agents)
      if ((await this.visionFor(agent)).status === "supported") return agent.id;
    throw new AppError(
      "NO_VISION_MEMBER",
      "团队没有已确认支持图片的成员；请先选择支持视觉的模型或验证当前模型",
    );
  }
  private async imageContext(agentId: string, requestId?: string) {
    const state = this.store.state,
      request = state.userRequests.find(
        (r) => r.id === (requestId ?? state.activeRequestId),
      );
    const agent = state.agents.find((a) => a.id === agentId);
    if (
      !request ||
      !agent ||
      !request.agentIds.includes(agentId) ||
      !request.attachmentIds?.length
    )
      return { images: [] as string[], text: "" };
    const analyses =
      request.vision?.batches
        .filter((b) => b.status === "completed")
        .map((b) => `图片分析 ${b.attachmentIds.join(",")}：${b.analysis}`)
        .join("\n") ?? "";
    const visual = request.vision?.agentId === agentId;
    const latestBatch =
      request.vision?.batches.find((b) => b.status !== "completed") ??
      request.vision?.batches.at(-1);
    const ids = visual ? (latestBatch?.attachmentIds ?? []) : [];
    const images: string[] = [];
    const descriptions: string[] = [];
    for (const id of ids) {
      const { item, path } = await this.attachments.read(
        id,
        request.conversationId ?? state.defaultConversationId,
      );
      descriptions.push(`${item.id}（${item.filename}）`);
      if (agent.provider === "codex") images.push(path);
    }
    return {
      images,
      text: `\n用户图片附件：${request.attachmentIds.join(",")}。${visual ? "必须实际查看图片；可调用 read_attachment(attachmentId)，不要根据文件名猜测。" + descriptions.join("、") : "当前成员使用已完成的视觉成员分析；需要原图复核请与视觉成员交流。"}\n${analyses}`,
    };
  }
  async startSession(options: import("./runtime.ts").StartOptions) {
    const a = this.store.state.agents.find((a) => a.id === options.agent.id)!;
    const cwd =
      a.sessionCwd ??
      (await this.work.planningWorkspace(this.store.state.project!, a.id));
    const sessionId = a.boundSessionId ?? a.sessionId;
    ensure(
      a.provider !== "antigravity" || !a.reasoningEffort,
      "ANTI_MODEL_MIGRATION",
      "Antigravity 旧模型强度需要重新选择完整模型 ID",
    );
    ensure(
      !a.sessionError,
      "SESSION_UNAVAILABLE",
      a.sessionError ?? "原生会话不可用",
    );
    ensure(
      !a.sessionStarted || sessionId,
      "SESSION_UNCONFIRMED",
      "原生会话 ID 尚未确认；请检查 Hook 后恢复，不能另建对话",
    );
    this.store.mutate((s) => {
      const member = s.agents.find((member) => member.id === a.id)!;
      member.sessionCwd = cwd;
      member.cwd = cwd;
    });
    const imageContext = await this.imageContext(a.id);
    let result: { pid: number; sessionId?: string };
    try {
      result = await this.runtime.start({
        ...options,
        agent: a,
        cwd,
        images: options.images ?? imageContext.images,
        resumeSessionId: sessionId,
        accessDirs: [...new Set([options.cwd, ...(options.accessDirs ?? [])])],
        prompt:
          (options.prompt ?? "") +
          imageContext.text +
          "\n本阶段工作区：" +
          options.cwd +
          "。原生会话启动目录固定为 " +
          cwd +
          "；本阶段文件操作及测试请使用工作区绝对路径，执行命令先 cd 到本阶段工作区。",
      });
      ensure(
        !sessionId || !result.sessionId || result.sessionId === sessionId,
        "SESSION_MISMATCH",
        "原生会话接续身份不一致，请处理，不能另建对话",
      );
    } catch (error) {
      if (sessionId) {
        this.auth.revoke(a.id);
        this.store.mutate((s) => {
          const member = s.agents.find((member) => member.id === a.id)!;
          member.status = "error";
          member.sessionError =
            "原生会话接续失败：" +
            (error as Error).message +
            "。请检查原生历史和登录后恢复；不会新建对话。";
        });
        if (this.runtime.has(a.id)) await this.runtime.stop(a.id);
      }
      throw error;
    }
    this.store.mutate((s) => {
      s.agents.find((member) => member.id === a.id)!.sessionStarted = true;
    });
    if (result.sessionId)
      this.store.mutate((s) => {
        s.agents.find((member) => member.id === a.id)!.boundSessionId =
          result.sessionId;
      });
    return result;
  }
  async addAgent(
    name: string,
    provider: Provider,
    role: string,
    chatId = this.store.state.defaultConversationId,
  ) {
    ensure(
      conversationAgents(this.store.state, chatId).length < 8,
      "AGENT_LIMIT",
      "最多支持 8 个 Agent",
    );
    const id = randomUUID();
    const info = await probe(provider);
    this.store.mutate((s) => {
      ensure(
        conversationAgents(s, chatId).length < 8,
        "AGENT_LIMIT",
        "最多支持 8 个 Agent",
      );
      s.agents.push({
        id,
        name,
        conversationId: chatId,
        provider,
        role,
        status: "offline",
        manual: false,
        probe: info,
      });
      this.store.event(s, "agent.added", `${name} 已添加`, { agentId: id });
    });
    return { id };
  }
  updatePlan(
    goal: string,
    checks: CommandSpec[],
    maxMinutes: number,
    concurrency: number,
  ) {
    this.idleForEdit();
    this.project();
    this.store.mutate((s) => {
      const p = s.project!;
      p.plan = {
        ...p.plan,
        version: p.plan.version + 1,
        goal,
        checks,
        maxMinutes,
        approvedVersion: undefined,
        approvedAt: undefined,
      };
      s.paused = true;
      s.concurrency = concurrency;
      for (const task of s.tasks)
        if (!["completed", "cancelled"].includes(task.status)) {
          task.planVersion = p.plan.version;
          task.review = undefined;
          task.testIds = [];
        }
      this.store.event(s, "plan.updated", `计划 v${p.plan.version} 等待批准`);
    });
  }
  addTask(
    input: {
      title: string;
      description: string;
      ownerId: string;
      dependencies: string[];
      acceptance: string;
      priority?: number;
    },
    actor = "user",
  ) {
    this.idleForEdit();
    this.project();
    const id = randomUUID();
    this.store.mutate((s) => {
      ensure(
        s.agents.some((a) => a.id === input.ownerId),
        "AGENT_NOT_FOUND",
        "负责人不存在",
      );
      ensure(
        input.dependencies.every((dep) => s.tasks.some((t) => t.id === dep)),
        "DEPENDENCY_NOT_FOUND",
        "依赖任务不存在",
      );
      const plan = s.project!.plan;
      plan.version++;
      plan.approvedVersion = undefined;
      plan.approvedAt = undefined;
      s.paused = true;
      for (const task of s.tasks)
        if (["queued", "failed", "blocked"].includes(task.status))
          task.planVersion = plan.version;
      s.tasks.push({
        ...input,
        id,
        sourceId: actor,
        status: "queued",
        planVersion: plan.version,
        priority: input.priority ?? 0,
        createdAt: now(),
        testIds: [],
        attempts: 0,
      });
      this.store.event(s, "task.proposed", `${input.title} · 等待计划批准`, {
        taskId: id,
        agentId: input.ownerId,
      });
    });
    return { id };
  }
  updateTask(
    id: string,
    input: {
      title: string;
      description: string;
      ownerId: string;
      dependencies: string[];
      acceptance: string;
      priority?: number;
    },
  ) {
    this.idleForEdit();
    this.store.mutate((s) => {
      const task = s.tasks.find((t) => t.id === id);
      ensure(
        task && !["completed", "cancelled"].includes(task.status),
        "INVALID_STATE",
        "完成或取消的任务不能修改",
      );
      ensure(
        s.agents.some((a) => a.id === input.ownerId),
        "AGENT_NOT_FOUND",
        "负责人不存在",
      );
      ensure(
        !task.worktree ||
          JSON.stringify(task.dependencies) ===
            JSON.stringify(input.dependencies),
        "WORKSPACE_LOCKED",
        "任务已创建工作区；更改依赖请创建后续任务，原工作区保留",
      );
      ensure(
        input.dependencies.every(
          (dep) =>
            dep !== id &&
            s.tasks.some((t) => t.id === dep && t.status !== "cancelled"),
        ),
        "DEPENDENCY_NOT_FOUND",
        "依赖不存在、已取消或指向自身",
      );
      const reaches = (current: string, seen = new Set<string>()): boolean => {
        if (current === id) return true;
        if (seen.has(current)) return false;
        seen.add(current);
        return s.tasks
          .find((t) => t.id === current)!
          .dependencies.some((dep) => reaches(dep, seen));
      };
      ensure(
        !input.dependencies.some((dep) => reaches(dep)),
        "DEPENDENCY_CYCLE",
        "任务依赖不能形成循环",
      );
      Object.assign(task, input, {
        status: "queued",
        review: undefined,
        testIds: [],
        error: undefined,
        runId: undefined,
      });
      const plan = s.project!.plan;
      plan.version++;
      plan.approvedVersion = undefined;
      plan.approvedAt = undefined;
      s.paused = true;
      for (const t of s.tasks)
        if (!["completed", "cancelled"].includes(t.status))
          t.planVersion = plan.version;
      this.store.event(s, "task.updated", "任务变更等待计划批准", {
        taskId: id,
        agentId: task.ownerId,
      });
    });
  }
  cancelTask(id: string) {
    this.idleForEdit();
    this.store.mutate((s) => {
      const task = s.tasks.find((t) => t.id === id);
      ensure(
        task && !["completed", "cancelled"].includes(task.status),
        "INVALID_STATE",
        "任务不能取消",
      );
      ensure(
        !s.tasks.some(
          (t) => t.dependencies.includes(id) && t.status !== "cancelled",
        ),
        "DEPENDENTS_EXIST",
        "请先取消或调整下游任务",
      );
      task.status = "cancelled";
      s.project!.plan.version++;
      s.project!.plan.approvedVersion = undefined;
      s.paused = true;
      for (const t of s.tasks)
        if (!["completed", "cancelled"].includes(t.status))
          t.planVersion = s.project!.plan.version;
      this.store.event(s, "task.cancelled", task.title, { taskId: id });
    });
  }
  approvePlan(version: number) {
    this.store.mutate((s) => {
      ensure(
        s.project && s.project.plan.version === version,
        "STALE_PLAN",
        "计划版本已改变",
        409,
      );
      ensure(s.tasks.length, "EMPTY_PLAN", "请至少创建一项任务");
      s.project.plan.approvedVersion = version;
      s.project.plan.approvedAt = now();
      this.store.event(s, "plan.approved", `用户已批准计划 v${version}`);
    });
  }
  async setPaused(paused: boolean) {
    if (!paused && !this.store.state.activeRequestId) {
      const p = this.project();
      ensure(
        p.plan.approvedVersion === p.plan.version,
        "PLAN_NOT_APPROVED",
        "先批准当前计划",
      );
    }
    this.store.mutate((s) => {
      s.paused = paused;
      this.store.event(
        s,
        paused ? "dispatch.paused" : "dispatch.resumed",
        paused ? "已暂停新任务派发" : "自动派发已启动",
      );
    });
    if (!paused) void this.schedule();
  }
  async startPlanning(agentId: string) {
    const p = this.project();
    const a = this.store.state.agents.find((a) => a.id === agentId);
    ensure(a, "AGENT_NOT_FOUND", "Agent 不存在");
    ensure(
      !this.runtime.has(agentId),
      "SESSION_EXISTS",
      "已有原生会话，请先停止",
    );
    ensure(a.status !== "recovery", "RECOVERY_REQUIRED", "请先确认恢复状态");
    ensure(
      slots(this.store.state) < this.store.state.concurrency,
      "CONCURRENCY_LIMIT",
      "执行席位已用完",
    );
    const cwd = await this.work.planningWorkspace(p, agentId);
    this.auth.revoke(agentId);
    this.store.mutate((s) => {
      const a = s.agents.find((a) => a.id === agentId)!;
      a.cwd = cwd;
      a.status = "starting";
      a.error = undefined;
    });
    try {
      await this.startSession({
        agent: a,
        cwd,
        url: this.url,
        token: this.auth.issue(agentId),
        readOnly: true,
        prompt: `你在 Relay 多 Agent 控制台中担任${a.role}。项目目标：${p.plan.goal}。当前为规划阶段，禁止修改业务代码。先调用 relay.get_project_state 了解成员，再使用 relay.propose_task 提议任务（含验收标准和依赖）。计划必须由用户在控制台批准。不要自动开启子 Agent。`,
      });
    } catch (e) {
      this.failAgent(agentId, (e as Error).message);
      throw e;
    }
  }
  async schedule() {
    if (
      this.store.state.activeRequestId ||
      this.store.state.userRequests.some((r) => r.status === "queued")
    ) {
      await this.deliverQueued();
      this.collaboration.kick();
      return;
    }
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (true) {
        const s = this.store.state;

        const p = s.project;
        if (s.paused || !p || p.plan.approvedVersion !== p.plan.version) break;
        if (slots(s) >= s.concurrency) break;
        const task = s.tasks
          .filter(
            (t) =>
              !t.requestId &&
              t.status === "queued" &&
              t.planVersion === p.plan.version &&
              t.dependencies.every((id) =>
                s.tasks.some((d) => d.id === id && d.status === "completed"),
              ),
          )
          .sort(
            (a, b) =>
              b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
          )
          .find((t) => {
            const a = s.agents.find((a) => a.id === t.ownerId);
            return (
              a &&
              !a.manual &&
              !["recovery", "starting", "running", "waiting"].includes(
                a.status,
              ) &&
              !activeRun(s, a.id)
            );
          });
        if (!task) {
          await this.deliverQueued();
          break;
        }
        await this.dispatch(task.id);
      }
    } catch (e) {
      this.store.mutate((s) => {
        s.paused = true;
        this.store.event(s, "scheduler.error", (e as Error).message);
      });
    } finally {
      this.scheduling = false;
    }
  }
  async dispatch(taskId: string) {
    ensure(
      !this.store.state.userRequests
        .find((r) => r.id === this.store.state.activeRequestId)
        ?.vision?.batches.some((b) => b.status !== "completed"),
      "VISION_PENDING",
      "先完成新增图片的分析，再派发任务",
    );
    const p = this.project();
    const runId = randomUUID();
    this.store.mutate((s) => {
      const t = s.tasks.find((t) => t.id === taskId)!;
      const a = s.agents.find((a) => a.id === t.ownerId)!;
      ensure(
        t.status === "queued" && !activeRun(s, a.id),
        "TASK_CLAIMED",
        "任务或 Agent 已被占用",
      );
      t.status = "assigned";
      t.runId = runId;
      t.attempts++;
      t.error = undefined;
      a.taskId = taskId;
      a.status = "starting";
      a.error = undefined;
      s.runs.push({
        id: runId,
        taskId,
        agentId: a.id,
        status: "starting",
        startedAt: now(),
        model: a.model,
        reasoningEffort: a.reasoningEffort,
        permissionMode: a.permissionMode ?? "native",
      });
      this.store.event(s, "task.dispatching", t.title, {
        taskId,
        agentId: a.id,
      });
    });
    let task = this.store.state.tasks.find((t) => t.id === taskId)!;
    try {
      this.auth.revoke(task.ownerId); // Old lifecycle hooks must not update the newly claimed run.
      await this.runtime.stop(task.ownerId); // Rotate execution credentials; resume the same native identity.
      if (!task.worktree) {
        const workspace = await this.work.taskWorkspace(
          p,
          task.requestId ? `${task.id}-v${task.planVersion}` : task.id,
        );
        this.store.mutate((s) => {
          Object.assign(
            s.tasks.find((t) => t.id === taskId)!,
            workspace,
          );
        });
      }
      task = this.store.state.tasks.find((t) => t.id === taskId)!;
      ensure(
        this.store.state.runs.find((r) => r.id === runId)?.status ===
          "starting",
        "INTERRUPTED",
        "启动已被用户停止",
      );
      const agent = this.store.state.agents.find((a) => a.id === task.ownerId)!;
      this.auth.revoke(agent.id);
      this.store.mutate((s) => {
        s.agents.find((a) => a.id === agent.id)!.cwd = task.worktree;
      });
      const nativeCwd =
        agent.sessionCwd ?? (await this.work.planningWorkspace(p, agent.id));
      this.store.mutate((s) => {
        s.agents.find((a) => a.id === agent.id)!.sessionCwd = nativeCwd;
      });
      if (task.kind === "analysis") {
        const roots = [...new Set([p.root, task.worktree!, nativeCwd])];
        const audit = Object.fromEntries(
          await Promise.all(
            roots.map(
              async (root) =>
                [
                  root,
                  await auditProjectFiles(root, this.work.dataDir),
                ] as const,
            ),
          ),
        );
        this.store.mutate((s) => {
          s.runs.find((r) => r.id === runId)!.analysisAudit = audit;
        });
      }
      const prompt = task.requestId
        ? `用户需求：${p.plan.goal}。你负责团队内部任务 ${task.id}，执行ID ${runId}，类型 ${task.kind}。\n${task.title}\n${task.description}\n验收：${task.acceptance}\n修复原因：${task.remaining ?? "无"}\n先用 get_project_state 获取同伴与收件箱，report_progress 确认开始。用 send_message 与同伴交流，每个主要步骤检查消息。analysis 必须只读，完成后 submit_result(summary,evidence=文件位置及依据)，不得制造提交。code 只在自己的 worktree 改代码，完成后直接 submit_result；平台保存隔离分支成果版本，无需执行 Git 提交或申请额外 Git 写权限（排除 .agents/hooks.json）。不要扩大用户目标、提升权限、推送或开嵌套 Agent。结束轮次，平台自动验证并安排其他成员评审。信息不足用 ask_user。`
        : `你在 Relay 中执行已批准计划 v${task.planVersion} 的任务。\n任务ID: ${task.id}\n执行ID: ${runId}\n标题: ${task.title}\n内容: ${task.description}\n验收: ${task.acceptance}\n工作区: ${task.worktree}\n先调用 relay.report_progress 确认开始；使用 relay.get_project_state 获取上下文、成员及收件箱。可用 send_task / send_message 与伙伴通信。在每个主要步骤后报告进度并检查消息。不得修改目标、提升权限、开启嵌套子 Agent 或推送远端。完成后将业务成果提交到当前任务分支（不要提交 Relay 生成的 .agents/hooks.json），再调用 relay.submit_result。普通文字“完成”不算交付。测试由控制台按批准配置独立执行。`;
      const result = await this.startSession({
        agent,
        cwd: task.worktree!,
        prompt,
        taskId,
        runId,
        token: this.auth.issue(agent.id),
        url: this.url,
        readOnly: task.kind === "analysis",
      });
      this.store.mutate((s) => {
        const r = s.runs.find((r) => r.id === runId)!;
        r.pid = result.pid;
        r.sessionId = result.sessionId;
        for (const m of s.messages)
          if (
            m.kind === "task" &&
            m.taskId === taskId &&
            m.status === "queued"
          ) {
            m.status = "delivered";
            this.store.event(
              s,
              "message.delivered",
              "任务进入指定工作区和原生会话",
              { agentId: agent.id, taskId, messageId: m.id },
            );
          }
        this.store.event(s, "task.delivered", `原生会话已启动：${task.title}`, {
          taskId,
          agentId: agent.id,
        });
      });
      const timer = setTimeout(() => {
        void this.stopAgent(agent.id, "已达到本次执行时长上限");
      }, p.plan.maxMinutes * 60_000);
      timer.unref();
      this.timeouts.set(agent.id, timer);
    } catch (e) {
      this.store.mutate((s) => {
        const t = s.tasks.find((t) => t.id === taskId)!;
        t.status =
          (e as AppError).code === "INTERRUPTED" ? "blocked" : "failed";
        t.error = (e as Error).message;
        const r = s.runs.find((r) => r.id === runId)!;
        r.status = "ended";
        r.endedAt = now();
        r.reason = t.error;
        this.store.event(s, "task.dispatch-failed", t.error, {
          taskId,
          agentId: task.ownerId,
        });
      });
      this.failAgent(task.ownerId, (e as Error).message);
    }
  }
  private onRuntimeEvent(e: RuntimeEvent) {
    if (e.type === "exit") this.auth.revoke(e.agentId);
    this.store.mutate((s) => {
      const a = s.agents.find((a) => a.id === e.agentId);
      if (!a) return;
      if (e.type !== "attention") a.lastActivity = now();
      if (e.type === "attention") a.attention = e.detail;
      if (["started", "turn-ended", "exit"].includes(e.type))
        a.attention = undefined;
      if (["turn-ended", "exit"].includes(e.type)) a.messageTurn = undefined;
      if (e.pid) a.pid = e.pid;
      if (e.generation) {
        a.generation = e.generation;
        a.sessionId = e.sessionId;
        for (const approval of s.approvals)
          if (approval.agentId === a.id && approval.status === "pending")
            approval.status = "resolved";
        a.effectiveModel = undefined;
        a.effectiveEffort = undefined;
        a.connectionWarning = undefined;
        a.nativeError = undefined;
        a.settingChange = undefined;
      }
      if (e.model && a.effectiveModel && e.model !== a.effectiveModel)
        a.settingChange = `原生模型发生变化：${a.effectiveModel} 改为 ${e.model}`;
      if (e.effort && a.effectiveEffort && e.effort !== a.effectiveEffort)
        a.settingChange = `原生强度发生变化：${a.effectiveEffort} 改为 ${e.effort}`;
      if (e.model) a.effectiveModel = e.model;
      if (e.effort) a.effectiveEffort = e.effort;
      if (e.type === "session-confirmed" && e.sessionId)
        a.connectionWarning = undefined;
      if (e.type === "native-error") a.nativeError = e.detail;
      if (e.type === "connection-warning") a.connectionWarning = e.detail;
      if (e.sessionId) {
        if (a.boundSessionId && a.boundSessionId !== e.sessionId) {
          a.status = "error";
          a.sessionError = "原生会话身份不一致；接续已暂停，需要人工处理";
          return;
        }
        a.sessionId = e.sessionId;
        a.boundSessionId = e.sessionId;
      }
      const task = s.tasks.find((t) => t.id === a.taskId);
      const run = s.runs.find((r) => r.id === task?.runId);
      if (e.type === "connected") {
        a.status = a.taskId || e.awaitingTurn ? "starting" : "idle";
        if (a.provider === "codex" && a.probe) a.probe.verified = true;
      }
      if (["started", "activity"].includes(e.type)) {
        a.nativeError = undefined;
        a.status = s.approvals.some(
          (p) => p.agentId === a.id && p.status === "pending",
        )
          ? "waiting"
          : "running";
        a.connectionWarning = a.sessionId
          ? undefined
          : `${e.type === "activity" ? "会话已执行协作工具" : "已收到运行活动"}，但尚无原生会话 ID；接续能力尚未确认。`;
        if (task?.status === "assigned") task.status = "running";
        if (run?.status === "starting") run.status = "running";
      }
      if (e.type === "turn-ended") {
        a.status = "idle";
        if (task && ["assigned", "running"].includes(task.status)) {
          task.status = "blocked";
          task.error = "本轮已结束但未提交结构化成果；请检查输出后继续";
        }
        if (run && ["running", "starting"].includes(run.status)) {
          run.status = "ended";
          run.endedAt = now();
        }
      }
      if (e.type === "error" || e.type === "exit") {
        for (const approval of s.approvals)
          if (approval.agentId === a.id && approval.status === "pending")
            approval.status = "resolved";
        a.status = e.type === "error" ? "error" : "stopped";
        a.error = e.detail;
        if (task && ["assigned", "running"].includes(task.status)) {
          task.status = "blocked";
          task.error = e.detail;
        }
        if (run && ["starting", "running"].includes(run.status)) {
          run.status = "interrupted";
          run.endedAt = now();
          run.reason = e.detail;
        }
      }
      if (e.type === "approval-resolved") {
        const approval = s.approvals.find((r) => r.id === e.detail);
        if (approval?.status === "pending") approval.status = "resolved";
        if (a.status === "waiting") a.status = "running";
      }
      if (e.type === "approval" && e.request) {
        a.status = "waiting";
        s.approvals.push({
          id: e.request.id,
          agentId: a.id,
          method: e.request.method,
          detail: redact(JSON.stringify(e.request.params, null, 2)),
          presentation: approvalPresentation(
            e.request.method,
            redact(JSON.stringify(e.request.params)),
          ),
          status: "pending",
        });
      }
      this.store.event(s, `agent.${e.type}`, e.detail ?? e.type, {
        agentId: a.id,
        taskId: task?.id,
      });
    });
    if (["turn-ended", "exit"].includes(e.type)) {
      clearTimeout(this.timeouts.get(e.agentId));
      this.timeouts.delete(e.agentId);
      const s = this.store.state;
      const a = s.agents.find((a) => a.id === e.agentId);
      const t = s.tasks.find((t) => t.id === a?.taskId);
      if (
        this.autoVerify &&
        !t?.requestId &&
        t?.status === "review" &&
        !t.testIds.length &&
        s.project?.plan.checks.length
      ) {
        void this.verifyTask(t.id)
          .then((records) =>
            records.every((r) => r.status === "passed")
              ? this.requestReview(t.id)
              : undefined,
          )
          .catch((error) =>
            this.store.mutate((s) => {
              this.store.event(
                s,
                "verification.failed",
                (error as Error).message,
                { taskId: t.id },
              );
            }),
          );
      }
      setTimeout(() => void this.schedule(), 100).unref();
    }
  }
  private failAgent(id: string, reason: string) {
    this.store.mutate((s) => {
      const a = s.agents.find((a) => a.id === id);
      if (a) {
        a.status = "error";
        a.error = reason;
      }
    });
  }
  async stopAgent(id: string, reason = "用户停止") {
    await this.runtime.stop(id);
    this.auth.revoke(id);
    await Promise.allSettled(
      [...this.artifactSaves]
        .filter(
          ([taskId]) =>
            this.store.state.tasks.find((t) => t.id === taskId)?.ownerId === id,
        )
        .map(([, save]) => save),
    );
    clearTimeout(this.timeouts.get(id));
    this.store.mutate((s) => {
      const a = s.agents.find((a) => a.id === id);
      ensure(a, "AGENT_NOT_FOUND", "Agent 不存在");
      a.status = "stopped";
      a.manual = false;
      a.attention = undefined;
      a.messageTurn = undefined;
      a.pid = undefined;
      a.connectionWarning = undefined;
      a.nativeError = undefined;
      for (const approval of s.approvals)
        if (approval.agentId === id && approval.status === "pending")
          approval.status = "resolved";
      for (const r of s.runs)
        if (r.agentId === id && ["starting", "running"].includes(r.status)) {
          r.status = "interrupted";
          r.endedAt = now();
          r.reason = reason;
        }
      for (const t of s.tasks)
        if (t.ownerId === id && ["assigned", "running"].includes(t.status)) {
          t.status = "blocked";
          t.error = reason;
        }
      this.store.event(s, "agent.stopped", reason, { agentId: id });
    });
  }
  hasPendingConversation(chatId: string) {
    const tasks = this.store.state.tasks.filter(
      (t) => t.conversationId === chatId,
    );
    return tasks.some(
      (t) => this.checkControllers.has(t.id) || this.artifactSaves.has(t.id),
    );
  }
  async stopConversation(chatId: string) {
    for (const task of this.store.state.tasks.filter(
      (t) => t.conversationId === chatId,
    ))
      this.checkControllers.get(task.id)?.abort();
    for (const agent of conversationAgents(this.store.state, chatId))
      await this.stopAgent(agent.id);
    const deadline = Date.now() + 10000;
    while (this.hasPendingConversation(chatId) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    ensure(
      !this.hasPendingConversation(chatId),
      "STOP_PENDING",
      "检查仍在结束，请等待后再次停止",
    );
  }
  async stopAll() {
    const { stopVisionChecks } = await import("./vision-check.ts");
    await stopVisionChecks(this);
    for (const controller of this.checkControllers.values()) controller.abort();
    await this.setPaused(true);
    const results = await Promise.allSettled(
      this.store.state.agents.map((a) => this.stopAgent(a.id)),
    );
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    ensure(
      !failures.length,
      "STOP_FAILED",
      failures.map((r) => String(r.reason)).join("; "),
    );
  }
  async manual(id: string, enabled: boolean) {
    const a = this.store.state.agents.find((a) => a.id === id);
    ensure(a, "AGENT_NOT_FOUND", "Agent 不存在");
    if (!enabled)
      ensure(
        !activeRun(this.store.state, id) ||
          this.store.state.tasks.some(
            (t) =>
              t.ownerId === id &&
              t.requestId &&
              t.runId &&
              this.store.state.runs.some(
                (r) =>
                  r.id === t.runId &&
                  ["starting", "running"].includes(r.status),
              ),
          ),
        "AGENT_BUSY",
        "当前任务仍在执行，停止或提交成果后再退出人工接管",
      );
    this.store.mutate((s) => {
      const a = s.agents.find((a) => a.id === id)!;
      a.manual = enabled;
      this.store.event(
        s,
        "agent.manual",
        enabled ? "人工接管：自动派发暂停" : "人工接管结束",
        { agentId: id },
      );
    });
    if (!enabled) void this.schedule();
  }
  acknowledgeRecovery(id: string) {
    const a = this.store.state.agents.find((a) => a.id === id);
    ensure(a, "AGENT_NOT_FOUND", "Agent 不存在");
    if (a.pid) {
      let alive = false;
      try {
        process.kill(a.pid, 0);
        alive = true;
      } catch {}
      ensure(
        !alive,
        "PROCESS_ALIVE",
        `原进程 PID ${a.pid} 仍存活，请先在原终端停止并检查工作区`,
      );
    }
    this.store.mutate((s) => {
      const a = s.agents.find((a) => a.id === id)!;
      a.status = "stopped";
      a.pid = undefined;
      a.error = undefined;
      a.sessionError = undefined;
      this.store.event(s, "agent.reconciled", "用户已检查恢复状态", {
        agentId: id,
      });
    });
  }
  retryTask(id: string) {
    this.store.mutate((s) => {
      const t = s.tasks.find((t) => t.id === id);
      ensure(
        t && ["failed", "blocked"].includes(t.status),
        "INVALID_STATE",
        "仅失败或阻塞任务可重试",
      );
      ensure(!activeRun(s, t.ownerId), "AGENT_BUSY", "先停止旧执行");
      ensure(
        t.attempts < s.project!.plan.retryLimit + 1,
        "RETRY_LIMIT",
        "已达到自动修复次数上限",
      );
      t.status = "queued";
      t.error = undefined;
      t.planVersion = s.project!.plan.version;
      this.store.event(s, "task.retry", t.title, { taskId: id });
    });
    void this.schedule();
  }
  async sendMessage(
    actor: string,
    input: {
      targetId: string;
      text: string;
      taskId?: string;
      kind?: Message["kind"];
      replyTo?: string;
    },
  ) {
    ensure(
      this.store.state.agents.some((a) => a.id === input.targetId),
      "AGENT_NOT_FOUND",
      "接收者不存在",
    );
    ensure(actor !== input.targetId, "SELF_MESSAGE", "不向自己转发消息");
    const state = this.store.state;
    const sender = state.agents.find((a) => a.id === actor);
    const target = state.agents.find((a) => a.id === input.targetId)!;
    ensure(
      actor === "user" ||
        (sender &&
          conversationId(state, sender) === conversationId(state, target)),
      "OTHER_CONVERSATION",
      "不能跨对话发送协作消息",
      403,
    );
    const recent = this.store.state.messages.filter(
      (m) =>
        m.sourceId === actor && Date.now() - Date.parse(m.createdAt) < 60_000,
    );
    ensure(
      actor === "user" || recent.length < 20,
      "MESSAGE_RATE",
      "每个 Agent 每分钟最多 20 条协作消息，请等待或请求用户协调",
    );
    if (input.replyTo) {
      let parent = this.store.state.messages.find(
        (m) => m.id === input.replyTo,
      );
      ensure(
        parent &&
          parent.targetId === actor &&
          parent.sourceId === input.targetId,
        "INVALID_REPLY",
        "回复必须关联自己收到的原消息",
      );
      let depth = 0;
      while (parent) {
        depth++;
        parent = this.store.state.messages.find(
          (m) => m.id === parent!.replyTo,
        );
      }
      ensure(
        depth < 6,
        "CONVERSATION_LIMIT",
        "对话已达 3 轮，请总结分歧并请求用户决策",
      );
    }
    const id = randomUUID();
    this.store.mutate((s) => {
      if (input.taskId)
        ensure(
          s.tasks.some((t) => t.id === input.taskId),
          "TASK_NOT_FOUND",
          "任务不存在",
        );
      s.messages.push({
        requestId: s.activeRequestId,
        id,
        sourceId: actor,
        ...input,
        kind: input.kind ?? "question",
        status: "queued",
        createdAt: now(),
      });
      this.store.event(s, "message.queued", input.text.slice(0, 160), {
        agentId: input.targetId,
        taskId: input.taskId,
        messageId: id,
      });
    });
    const a = this.store.state.agents.find((a) => a.id === input.targetId)!;
    if (
      input.kind === "task" ||
      a.manual ||
      !this.runtime.has(a.id) ||
      this.pendingNativeSend.has(a.id) ||
      (!["running", "waiting"].includes(a.status) &&
        slots(this.store.state) >= this.store.state.concurrency)
    )
      return { id, status: "queued" };
    return this.deliverMessage(id);
  }
  async deliverQueued() {
    for (const m of this.store.state.messages.filter(
      (m) =>
        m.status === "queued" &&
        m.kind !== "task" &&
        (m.requestId
          ? m.requestId === this.store.state.activeRequestId
          : !this.store.state.activeRequestId),
    )) {
      const s = this.store.state;
      const a = s.agents.find((a) => a.id === m.targetId)!;
      if (
        a.manual ||
        !this.runtime.has(a.id) ||
        this.pendingNativeSend.has(a.id) ||
        (!["running", "waiting"].includes(a.status) &&
          slots(s) >= s.concurrency)
      )
        continue;
      await this.deliverMessage(m.id);
    }
  }
  private async deliverMessage(id: string) {
    const input = this.store.state.messages.find((m) => m.id === id)!;
    const a = this.store.state.agents.find((a) => a.id === input.targetId)!;
    const actor = input.sourceId;
    this.pendingNativeSend.add(a.id);
    // Idle native adapters restart the same conversation. A completed request
    // has already revoked the old launch token; do not reuse it on continuation.
    const token = a.provider === "codex" ? undefined : this.auth.issue(a.id);
    let delivered = false;
    try {
      this.store.mutate((s) => {
        s.messages.find((m) => m.id === id)!.status = "sending";
        const current = s.agents.find((x) => x.id === a.id)!;
        if (!["running", "waiting"].includes(current.status))
          current.status = "starting";
      });
      const imageContext = await this.imageContext(a.id, input.requestId);
      delivered = await this.runtime.send(
        a.id,
        `[来自 ${actor} 的协作消息 ${id}，不是用户审批]\n${input.text}${imageContext.text}\n处理后调用 relay.ack_message，必要时使用 send_message 回复。`,
        token,
        imageContext.images,
      );
      if (!delivered)
        this.store.mutate((s) => {
          s.messages.find((m) => m.id === id)!.status = "queued";
          const current = s.agents.find((x) => x.id === a.id)!;
          if (current.status === "starting") current.status = a.status;
        });
      if (delivered)
        this.store.mutate((s) => {
          s.messages.find((m) => m.id === id)!.status = "delivered";
          const current = s.agents.find((member) => member.id === a.id)!;
          const request = s.userRequests.find(
            (r) => r.id === s.activeRequestId,
          );
          if (
            input.requestId === request?.id &&
            request &&
            !activeRun(s, a.id) &&
            request.control?.agentId !== a.id &&
            !current.messageTurn
          )
            current.messageTurn = { messageId: id, startedAt: now() };
          this.store.event(s, "message.delivered", input.text.slice(0, 160), {
            agentId: a.id,
            messageId: id,
            taskId: input.taskId,
          });
        });
      return { id, status: delivered ? "delivered" : "queued" };
    } catch (e) {
      this.store.mutate((s) => {
        const m = s.messages.find((m) => m.id === id)!;
        m.status = "failed";
        const current = s.agents.find((x) => x.id === a.id)!;
        if (current.status === "starting") current.status = "error";
        m.error = (e as Error).message;
        this.store.event(s, "message.failed", m.error, {
          agentId: a.id,
          messageId: id,
        });
      });
      return { id, status: "failed" };
    } finally {
      if (token && !delivered) this.auth.discard(token);
      this.pendingNativeSend.delete(a.id);
    }
  }
  async sendTask(actor: string, taskId: string, targetId: string) {
    const s = this.store.state;
    const t = s.tasks.find((t) => t.id === taskId);
    ensure(t, "TASK_NOT_FOUND", "任务不存在");
    ensure(
      s.project?.plan.approvedVersion === s.project?.plan.version,
      "PLAN_NOT_APPROVED",
      "需要用户批准计划",
    );
    ensure(
      t.ownerId === targetId,
      "PLAN_CHANGE_REQUIRED",
      "负责人变更需重新批准计划",
    );
    ensure(t.status === "queued", "TASK_CLAIMED", "任务已派发或完成");
    const result = await this.sendMessage(actor, {
      targetId,
      taskId,
      text: `任务交接：${t.title}\n${t.description}`,
      kind: "task",
    });
    void this.schedule();
    return result;
  }
  agentState(actor: string) {
    this.store.mutate((s) => {
      for (const m of s.messages)
        if (
          m.targetId === actor &&
          (m.requestId
            ? m.requestId === s.activeRequestId
            : !s.activeRequestId) &&
          m.kind !== "task" &&
          ["queued", "failed"].includes(m.status)
        ) {
          m.status = "delivered";
          m.error = undefined;
          this.store.event(s, "message.delivered", "Agent 已读取收件箱", {
            agentId: actor,
            messageId: m.id,
            taskId: m.taskId,
          });
        }
    });
    const s = this.store.publicState();
    const self = s.agents.find((a) => a.id === actor)!;
    const cid = conversationId(s, self);
    const ownMembers = conversationAgents(s, cid);
    const ownRequests = s.userRequests.filter(
      (r) => conversationId(s, r) === cid,
    );
    if (!ownRequests.some((r) => r.id === s.activeRequestId))
      s.activeRequestId = undefined;
    const ownTasks = s.tasks.filter(
      (t) =>
        ownRequests.some((r) => r.id === t.requestId) ||
        (!t.requestId && ownMembers.some((a) => a.id === t.ownerId)),
    );
    const tasks = s.activeRequestId
      ? ownTasks.filter((t) => t.requestId === s.activeRequestId)
      : ownTasks;
    const taskIds = new Set(tasks.map((t) => t.id));
    return {
      activeRequest: s.userRequests.find((r) => r.id === s.activeRequestId),
      attachments: s.attachments?.filter(
        (a) => a.conversationId === cid && a.requestId === s.activeRequestId,
      ),
      chat: s.chat.filter((m) => m.requestId === s.activeRequestId),
      project: s.project
        ? {
            ...s.project,
            plan: {
              ...s.project.plan,
              goal:
                ownRequests.find((r) => r.id === s.activeRequestId)?.text ?? "",
            },
          }
        : undefined,
      conversationId: cid,
      agents: ownMembers,
      tasks,
      tests: s.activeRequestId
        ? s.tests.filter((test) => taskIds.has(test.taskId))
        : s.tests.filter((test) => taskIds.has(test.taskId)),
      inbox: s.messages.filter(
        (m) =>
          m.targetId === actor &&
          ((!m.requestId && !s.activeRequestId) ||
            (m.requestId === s.activeRequestId &&
              s.userRequests.some(
                (r) =>
                  r.id === m.requestId &&
                  !["completed", "stopped", "failed"].includes(r.status),
              ))) &&
          m.status !== "acknowledged" &&
          (m.kind !== "task" || m.status === "delivered"),
      ),
      paused: s.paused,
    };
  }
  ackMessage(actor: string, id: string) {
    this.store.mutate((s) => {
      const m = s.messages.find((m) => m.id === id);
      ensure(
        m && m.targetId === actor && m.status === "delivered",
        "FORBIDDEN",
        "不能确认他人的消息",
        403,
      );
      m.status = "acknowledged";
      this.store.event(s, "message.acknowledged", "Agent 已确认接收", {
        agentId: actor,
        messageId: id,
      });
    });
  }
  report(
    actor: string,
    taskId: string,
    runId: string,
    progress: string,
    remaining: string,
    blocked: boolean,
  ) {
    this.store.mutate((s) => {
      const t = s.tasks.find((t) => t.id === taskId);
      ensure(
        t && t.ownerId === actor && t.runId === runId,
        "STALE_RUN",
        "执行身份或版本已过期",
        409,
      );
      const r = s.runs.find((r) => r.id === runId);
      ensure(
        r && ["starting", "running"].includes(r.status),
        "STALE_RUN",
        "执行已停止",
        409,
      );
      ensure(
        ["assigned", "running", "blocked"].includes(t.status),
        "INVALID_STATE",
        "此任务不能报告执行进度",
      );
      t.progress = progress;
      t.remaining = remaining;
      t.status = blocked ? "blocked" : "running";
      r.status = "running";
      const a = s.agents.find((a) => a.id === actor)!;
      a.status = blocked ? "waiting" : "running";
      a.lastActivity = now();
      this.store.event(s, "task.progress", progress, {
        agentId: actor,
        taskId,
      });
    });
    return this.agentState(actor);
  }
  async submit(
    actor: string,
    taskId: string,
    runId: string,
    summary: string,
    evidence?: string,
  ) {
    let t = this.store.state.tasks.find((t) => t.id === taskId);
    ensure(
      t && t.ownerId === actor && t.runId === runId,
      "STALE_RUN",
      "执行身份不匹配",
      409,
    );
    ensure(
      this.store.state.runs.some(
        (r) => r.id === runId && ["starting", "running"].includes(r.status),
      ),
      "STALE_RUN",
      "执行已停止",
      409,
    );
    ensure(
      !this.artifactSaves.has(t.id),
      "ARTIFACT_BUSY",
      "成果正在保存，请等待当前请求返回",
    );
    const task = t;
    const saving = (async () => {
      if (task.requestId && task.kind === "code")
        await this.work.checkpointTask(task);
      if (task.kind === "analysis") {
        const audit = this.store.state.runs.find(
          (r) => r.id === runId,
        )?.analysisAudit;
        ensure(
          audit,
          "AUDIT_MISSING",
          "缺少分析前文件审计，不能验收此旧执行；请重新执行分析",
        );
        try {
          await assertAnalysisAudit(audit, this.work.dataDir);
        } catch (error) {
          this.store.mutate((s) => {
            const failed = s.tasks.find((t) => t.id === taskId)!;
            failed.status = "failed";
            failed.error = (error as Error).message;
            const request = s.userRequests.find(
              (r) => r.id === failed.requestId,
            );
            if (request) {
              request.status = "waiting";
              request.error = failed.error + "；请检查文件改动后再恢复。";
            }
            this.store.event(s, "analysis.audit-failed", failed.error, {
              taskId,
              agentId: actor,
            });
          });
          throw error;
        }
      }
      return task.kind === "analysis"
        ? { commit: task.base! }
        : await this.work.verifyArtifact(task);
    })();
    this.artifactSaves.set(task.id, saving);
    let artifact: Awaited<typeof saving>;
    try {
      artifact = await saving;
    } finally {
      this.artifactSaves.delete(task.id);
    }
    if (t.kind === "analysis")
      ensure(
        evidence?.trim(),
        "EVIDENCE_REQUIRED",
        "分析成果需提供文件位置及依据",
      );
    this.store.mutate((s) => {
      const t = s.tasks.find((t) => t.id === taskId)!;
      ensure(
        t.runId === runId &&
          s.runs.some(
            (r) => r.id === runId && ["starting", "running"].includes(r.status),
          ),
        "STALE_RUN",
        "执行已被替换或停止",
        409,
      );
      t.commit = artifact.commit;
      t.artifact =
        "files" in artifact
          ? {
              files: artifact.files,
              diff: artifact.diff,
              truncated: artifact.truncated,
            }
          : undefined;
      t.result = summary;
      t.evidence = evidence;
      t.checked = false;
      t.status = "review";
      t.review = undefined;
      t.testIds = [];
      // Keep the execution slot until the native turn ends. The MCP call is still
      // running here; replacing its process before the response would lose the result.
      this.store.event(s, "task.submitted", summary, {
        agentId: actor,
        taskId,
      });
    });
    const source = t.sourceId;
    if (!t.requestId && source !== "user" && source !== actor)
      await this.sendMessage(actor, {
        targetId: source,
        taskId,
        text: `成果待验收：${summary}\n提交：${artifact.commit}`,
        kind: "result",
      });
    // The task turn must end before replacing this native CLI session with another task.
    return { status: "review", commit: artifact.commit };
  }
  async verifyTask(id: string) {
    ensure(!this.verifying.has(id), "VERIFY_BUSY", "该任务正在验证");
    this.verifying.add(id);
    const controller = new AbortController();
    this.checkControllers.set(id, controller);
    try {
      const t = this.store.state.tasks.find((t) => t.id === id);
      ensure(
        t?.commit && t.worktree && t.status === "review",
        "INVALID_STATE",
        "请先提交成果",
      );
      ensure(
        !activeRun(this.store.state, t.ownerId),
        "AGENT_BUSY",
        "等待原生执行轮次结束后再验证",
      );
      const artifact = await this.work.verifyArtifact(t);
      ensure(
        artifact.commit === t.commit,
        "STALE_ARTIFACT",
        "成果版本已变化，请重新提交",
      );
      const checks = this.project().plan.checks;
      ensure(
        checks.length,
        "NO_CHECKS",
        "未配置自动检查，需人工核查并明确接受",
      );
      const records: TestRun[] = [];
      for (const check of checks)
        records.push(
          await runCheck(
            id,
            t.commit,
            t.worktree,
            check,
            "task",
            120_000,
            controller.signal,
          ),
        );
      const after = await this.work.verifyArtifact(t);
      ensure(after.commit === t.commit, "STALE_ARTIFACT", "验证期间代码变化");
      this.store.mutate((s) => {
        s.tests.push(...records);
        s.tasks.find((t) => t.id === id)!.testIds = records.map((r) => r.id);
        this.store.event(
          s,
          "task.verified",
          records.every((r) => r.status === "passed") ? "检查通过" : "检查失败",
          { taskId: id },
        );
      });
      return records;
    } finally {
      this.verifying.delete(id);
      this.checkControllers.delete(id);
    }
  }
  review(id: string, accepted: boolean) {
    this.store.mutate((s) => {
      const t = s.tasks.find((t) => t.id === id);
      ensure(
        t?.commit && t.status === "review",
        "INVALID_STATE",
        "任务不在待验收状态",
      );
      if (accepted) {
        const checks = s.project!.plan.checks;
        ensure(
          !checks.length ||
            (t.testIds.length === checks.length &&
              t.testIds.every((id) =>
                s.tests.some(
                  (r) =>
                    r.id === id &&
                    r.commit === t.commit &&
                    r.status === "passed",
                ),
              )),
          "TESTS_REQUIRED",
          "必需检查未通过",
        );
        t.review = { by: "user", commit: t.commit, at: now() };
      } else {
        t.status = "blocked";
        t.error = "评审退回，请修复后重新提交";
        t.review = undefined;
      }
      this.store.event(
        s,
        accepted ? "task.review-approved" : "task.review-rejected",
        accepted ? "用户已核查验收标准" : "成果已退回",
        { taskId: id },
      );
    });
  }
  private async requestReview(id: string) {
    const s = this.store.state;
    if (s.paused) return;
    const task = s.tasks.find((t) => t.id === id)!;
    const candidates = s.agents
      .filter(
        (a) => a.id !== task.ownerId && !a.manual && a.status !== "recovery",
      )
      .sort(
        (a, b) => Number(b.role === "评审者") - Number(a.role === "评审者"),
      );
    const reviewer =
      candidates.find((a) => this.runtime.has(a.id)) ?? candidates[0];
    if (!reviewer) return;
    const text = `请独立评审任务 ${task.id}：${task.title}。成果提交 ${task.commit}，只读工作区 ${task.worktree}。验收标准：${task.acceptance}。用 get_project_state 查看独立测试记录，检查代码差异后调用 review_result(taskId, commit, accepted, note)。不得修改成果或降低验收标准。`;
    if (!this.runtime.has(reviewer.id)) {
      if (slots(this.store.state) >= s.concurrency) return;
      this.store.mutate((s) => {
        const a = s.agents.find((a) => a.id === reviewer.id)!;
        a.status = "starting";
        a.cwd = task.worktree;
        a.taskId = undefined;
        this.store.event(
          s,
          "review.requested",
          `交给 ${reviewer.name} 独立评审`,
          { taskId: id, agentId: reviewer.id },
        );
      });
      this.auth.revoke(reviewer.id);
      try {
        await this.startSession({
          agent: reviewer,
          cwd: task.worktree!,
          prompt: text,
          url: this.url,
          token: this.auth.issue(reviewer.id),
          readOnly: true,
        });
      } catch (e) {
        this.failAgent(reviewer.id, (e as Error).message);
      }
    } else
      await this.sendMessage(task.ownerId, {
        targetId: reviewer.id,
        text,
        taskId: id,
        kind: "result",
      });
  }
  async peerReview(
    actor: string,
    id: string,
    commit: string,
    accepted: boolean,
    note: string,
  ) {
    if (this.store.state.tasks.find((t) => t.id === id)?.requestId)
      return this.collaboration.review(actor, id, commit, accepted, note);
    this.store.mutate((s) => {
      const t = s.tasks.find((t) => t.id === id);
      ensure(
        t && t.ownerId !== actor && s.agents.some((a) => a.id === actor),
        "FORBIDDEN",
        "作者不能自己通过评审",
        403,
      );
      ensure(
        t.status === "review" && t.commit === commit,
        "STALE_ARTIFACT",
        "成果版本已变化",
        409,
      );
      const checks = s.project!.plan.checks;
      ensure(
        checks.length &&
          t.testIds.length === checks.length &&
          t.testIds.every((id) =>
            s.tests.some(
              (r) =>
                r.id === id && r.status === "passed" && r.commit === commit,
            ),
          ),
        "TESTS_REQUIRED",
        "独立测试尚未通过；无自动测试时需要用户验收",
      );
      if (accepted) t.review = { by: actor, commit, at: now() };
      else {
        t.status = "blocked";
        t.error = `评审退回：${note}`;
        t.review = undefined;
      }
      this.store.event(
        s,
        accepted ? "review.accepted" : "review.rejected",
        note,
        { taskId: id, agentId: actor },
      );
    });
    if (accepted && !this.store.state.paused) return this.integrate(id);
    return { accepted };
  }
  async integrate(id: string) {
    ensure(!this.integrating, "INTEGRATION_BUSY", "另一个成果正在整合", 409);
    this.integrating = true;
    const controller = new AbortController();
    this.checkControllers.set(id, controller);
    try {
      const p = this.project();
      ensure(
        p.plan.approvedVersion === p.plan.version,
        "PLAN_NOT_APPROVED",
        "整合前需要批准当前计划",
      );
      const t = this.store.state.tasks.find((t) => t.id === id);
      ensure(
        t?.commit && t.review?.commit === t.commit && t.status === "review",
        "REVIEW_REQUIRED",
        "先完成检查与评审",
      );
      ensure(
        !activeRun(this.store.state, t.ownerId),
        "AGENT_BUSY",
        "等待执行结束后再整合",
      );
      const current = await this.work.verifyArtifact(t);
      ensure(
        current.commit === t.commit,
        "STALE_ARTIFACT",
        "代码已改变，旧评审失效",
      );
      this.store.mutate((s) => {
        s.tasks.find((t) => t.id === id)!.status = "integrating";
        this.store.event(s, "task.integrating", t.title, { taskId: id });
      });
      const candidate = await this.work.candidate(p, t);
      if (candidate.conflict) {
        this.store.mutate((s) => {
          const item = s.tasks.find((t) => t.id === id)!;
          item.status = "blocked";
          item.error = `整合冲突：${candidate.files}。冲突工作区：${candidate.path}；解决并提交后可作为新的任务成果重新验收。`;
          const conflictId = randomUUID();
          s.tasks.push({
            id: conflictId,
            title: `解决冲突：${t.title}`,
            resolvesTaskId: id,
            requestId: t.requestId,
            kind: t.kind,
            key: `conflict-${id}`,
            description: `解决 ${candidate.path} 的合并冲突，保留两侧正确行为。完成合并提交，再提交成果。通过测试、评审与整合后自动完成原任务 ${id}。`,
            acceptance: t.acceptance,
            ownerId: t.ownerId,
            sourceId: "user",
            dependencies: [],
            status: "queued",
            planVersion: p.plan.version + 1,
            priority: 10,
            createdAt: now(),
            worktree: candidate.path,
            gitDir: candidate.gitDir,
            branch: candidate.branch,
            base: p.integratedHead,
            testIds: [],
            attempts: 0,
          });
          s.project!.plan.version++;
          s.project!.plan.approvedVersion = t.requestId
            ? s.project!.plan.version
            : undefined;
          s.paused = !t.requestId;
          for (const task of s.tasks)
            if (task.status === "queued")
              task.planVersion = s.project!.plan.version;
          this.store.event(s, "integration.conflict", item.error!, {
            taskId: id,
          });
        });
        return { conflict: true, path: candidate.path };
      }
      const checks: TestRun[] = [];
      for (const check of p.plan.checks)
        checks.push(
          await runCheck(
            id,
            candidate.commit,
            candidate.path,
            check,
            "integration",
            120_000,
            controller.signal,
          ),
        );
      this.store.mutate((s) => {
        s.tests.push(...checks);
      });
      ensure(
        checks.every((c) => c.status === "passed"),
        "INTEGRATION_TEST_FAILED",
        "集成检查失败，未推进集成分支",
      );
      ensure(
        (await git(candidate.path, "rev-parse", "HEAD")) === candidate.commit &&
          !(await git(
            candidate.path,
            "status",
            "--porcelain",
            "--untracked-files=no",
          )),
        "STALE_ARTIFACT",
        "集成测试修改了代码，需重新验收",
      );
      await this.work.advance(p, candidate.commit);
      this.store.mutate((s) => {
        const t = s.tasks.find((t) => t.id === id)!;
        t.status = "completed";
        t.integratedCommit = candidate.commit;
        s.project!.integratedHead = candidate.commit;
        let resolves = t.resolvesTaskId;
        while (resolves) {
          const original = s.tasks.find((x) => x.id === resolves)!;
          resolves = original.resolvesTaskId;
          original.status = "completed";
          original.integratedCommit = candidate.commit;
          original.error = undefined;
          this.store.event(
            s,
            "task.completed",
            `冲突解决并验证：${original.title}`,
            { taskId: original.id, agentId: t.ownerId },
          );
        }
        this.store.event(s, "task.completed", t.title, {
          taskId: id,
          agentId: t.ownerId,
        });
      });
      void this.schedule();
      return { commit: candidate.commit };
    } catch (e) {
      this.store.mutate((s) => {
        const t = s.tasks.find((t) => t.id === id);
        if (t?.status === "integrating") {
          t.status = "review";
          t.error = (e as Error).message;
        }
        this.store.event(s, "integration.failed", (e as Error).message, {
          taskId: id,
        });
      });
      throw e;
    } finally {
      this.integrating = false;
      this.checkControllers.delete(id);
    }
  }
  async finalize() {
    const s = this.store.state;
    ensure(
      s.tasks.length &&
        s.tasks.every((t) => ["completed", "cancelled"].includes(t.status)),
      "UNFINISHED_TASKS",
      "仍有未完成任务",
    );
    await this.work.finalize(this.project());
    this.store.mutate((s) => {
      this.store.event(s, "project.finalized", "用户已确认合入原始分支");
    });
  }
  approveRequest(id: string, accepted: boolean) {
    const a = this.store.state.approvals.find((a) => a.id === id);
    ensure(a?.status === "pending", "STALE_APPROVAL", "审批已失效");
    ensure(
      approvalPresentation(a.method, a.detail).supported,
      "UNSUPPORTED_APPROVAL",
      "此请求需在原生终端中处理，控制台不猜测协议响应",
    );
    this.runtime.approve(a.agentId, id, accepted);
    this.store.mutate((s) => {
      s.approvals.find((a) => a.id === id)!.status = accepted
        ? "accepted"
        : "declined";
      s.agents.find((x) => x.id === a.agentId)!.status = "running";
    });
  }
  conversationState(chatId: string) {
    const s = this.store.publicState();
    ensure(
      s.conversations.some((c) => c.id === chatId),
      "CONVERSATION_NOT_FOUND",
      "对话不存在",
      404,
    );
    s.conversations = s.conversations.filter((c) => c.id === chatId);
    s.agents = conversationAgents(s, chatId);
    const agentIds = new Set(s.agents.map((a) => a.id));
    s.userRequests = s.userRequests.filter(
      (r) => conversationId(s, r) === chatId,
    );
    const requests = new Set(s.userRequests.map((r) => r.id));
    s.chat = s.chat.filter(
      (m) => m.conversationId === chatId || requests.has(m.requestId ?? ""),
    );
    s.tasks = s.tasks.filter((t) => t.conversationId === chatId);
    const tasks = new Set(s.tasks.map((t) => t.id));
    s.tests = s.tests.filter(
      (t) => t.conversationId === chatId || tasks.has(t.taskId),
    );
    s.runs = s.runs.filter((r) => agentIds.has(r.agentId));
    s.messages = s.messages.filter((m) => m.conversationId === chatId);
    s.approvals = s.approvals.filter((p) => agentIds.has(p.agentId));
    s.events = s.events.filter(
      (e) => agentIds.has(e.agentId ?? "") || tasks.has(e.taskId ?? ""),
    );
    if (!requests.has(s.activeRequestId ?? "")) s.activeRequestId = undefined;
    if (s.project) s.project.plan.goal = s.userRequests.at(-1)?.text ?? "";
    return s;
  }
  reportMarkdown(chatId?: string) {
    const s = chatId
      ? this.conversationState(chatId)
      : this.store.publicState();
    const p = s.project;
    return `# Relay 协作报告\n\n生成时间：${now()}\n\n项目：${p?.name ?? "未接入"}\n\n目标：${p?.plan.goal ?? ""}\n\n计划版本：${p?.plan.version ?? 0}\n\n成果分支：${p?.integrationBranch ?? ""}\n\n成果版本：${p?.integratedHead ?? ""}\n\n## 用户需求\n\n${s.userRequests.map((r) => `### ${r.text}\n\n状态：${r.status}；已回写：${r.delivered ? "是" : "否"}\n\n${r.summary ?? r.error ?? "尚未完成"}\n\n改动：${r.changedFiles?.join(", ") || "无"}`).join("\n\n")}\n\n## 任务\n\n${s.tasks.map((t) => `### ${t.title}\n\n状态：${t.status}\n\n验收：${t.acceptance}\n\n成果：${t.commit ?? "未提交"}\n\n${t.result ?? ""}\n\n依据：${t.evidence ?? "未提供"}\n\n交叉评审：${t.review ? `${t.review.by} · ${t.review.commit}` : "未执行交叉评审"}\n\n未完成 / 问题：${t.error ?? t.remaining ?? "未报告"}\n`).join("\n")}\n## 独立测试记录\n\n${s.tests.length ? s.tests.map((t) => `### ${t.command.executable} ${t.command.args.join(" ")}\n\n状态：${t.status}；代码版本：${t.commit}；退出码：${t.exitCode}\n\n日志：\n\n${t.log || "无输出"}`).join("\n") : "未执行自动测试。不得据此判定测试通过。"}\n\n## 接入边界\n\n${s.agents.map((a) => `- ${a.name}：${a.probe?.version ?? "未知"}；会话控制验证：${a.probe?.verified ? "已连接验证" : "未完成"}；${a.probe?.notes.join(" ") ?? ""}`).join("\n")}\n`;
  }
}
