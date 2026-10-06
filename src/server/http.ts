import { conversation, conversationId } from "./conversations.ts";
import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { Service } from "./service.ts";
import { AppError, ensure, redact } from "./store.ts";
import { LocalProjects } from "./local-projects.ts";
import {
  pickLocalPath,
  validateLocalPath,
  type LocalPathSelection,
} from "./local-picker.ts";

const id = z.string().uuid();
const text = z.string().min(1).max(16000);
const memberSchema = z.object({
  id: id.optional(),
  provider: z.enum(["codex", "antigravity", "claude"]),
  model: z.string().min(1).max(160).optional(),
  reasoningEffort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    .optional(),
});
const taskSchema = z.object({
  title: z.string().min(1).max(200),
  description: text,
  ownerId: id,
  dependencies: z.array(id).max(100).default([]),
  acceptance: text,
  priority: z.number().int().min(0).max(10).default(0),
});
export async function createHttp(
  service: Service,
  options: {
    port: number;
    dev?: boolean;
    root: string;
    projects?: LocalProjects;
    pickFolder?: () => Promise<LocalPathSelection | null>;
  },
) {
  const ownsProjects = !options.projects;
  const projects =
    options.projects ??
    new LocalProjects(service.work.dataDir, options.root, options.dev);
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  app.use((req, res, next) => {
    const host = req.headers.host?.split(":")[0];
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host ?? ""))
      return res
        .status(403)
        .json({ error: { code: "HOST", message: "仅允许本地访问" } });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`)
      return res
        .status(403)
        .json({ error: { code: "ORIGIN", message: "拒绝跨站请求" } });
    next();
  });
  app.use(express.json({ limit: "512kb" }));
  app.use("/api", (req, res, next) => {
    const actor = service.auth.actor(
      (req.headers.authorization ?? "").replace(/^Bearer /, ""),
    );
    if (!actor)
      return res
        .status(401)
        .json({ error: { code: "AUTH", message: "请通过启动链接连接控制台" } });
    res.locals.actor = actor;
    next();
  });
  const user = (res: express.Response) =>
    ensure(
      res.locals.actor === "user",
      "FORBIDDEN",
      "此操作需用户在控制台确认",
      403,
    );
  app.get("/api/capabilities", async (req, res) => {
    user(res);
    const { probe } = await import("./doctor.ts");
    res.json(
      await Promise.all(
        (["codex", "antigravity", "claude"] as const).map(probe),
      ),
    );
  });
  app.post(
    "/api/attachments",
    (req, res, next) => {
      user(res);
      next();
    },
    express.raw({ type: "application/octet-stream", limit: "10mb" }),
    async (req, res) => {
      user(res);
      const chatId = id.parse(req.query.conversationId);
      ensure(Buffer.isBuffer(req.body), "IMAGE_BODY", "请使用二进制图片上传");
      const filename = z
        .string()
        .max(1800)
        .parse(req.headers["x-relay-filename"] ?? "图片");
      let decoded: string;
      try {
        decoded = decodeURIComponent(filename);
      } catch {
        ensure(false, "IMAGE_FILENAME", "图片文件名编码无效");
      }
      res
        .status(201)
        .json(await service.attachments.upload(chatId, decoded, req.body));
    },
  );
  app.get("/api/attachments/:id", async (req, res) => {
    user(res);
    const { item, bytes } = await service.attachments.read(
      id.parse(req.params.id),
      id.parse(req.query.conversationId),
    );
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.type(item.mimeType).send(bytes);
  });
  app.delete("/api/attachments/:id", async (req, res) => {
    user(res);
    await service.attachments.remove(
      id.parse(req.params.id),
      id.parse(req.query.conversationId),
    );
    res.json({ ok: true });
  });
  app.get("/api/vision-check/:provider/terminal", async (req, res) => {
    user(res);
    const provider = z
      .enum(["codex", "claude", "antigravity"])
      .parse(req.params.provider);
    const { visionTerminal } = await import("./vision-check.ts");
    res.json(await visionTerminal(service, provider));
  });
  app.post("/api/vision-check/:provider/terminal", async (req, res) => {
    user(res);
    const provider = z
      .enum(["codex", "claude", "antigravity"])
      .parse(req.params.provider);
    const body = z
      .object({
        generation: z.string().min(1),
        manual: z.boolean().optional(),
        data: z.string().max(4096).optional(),
        approvalId: z.string().optional(),
        accepted: z.boolean().optional(),
      })
      .parse(req.body);
    const { visionTerminalInput } = await import("./vision-check.ts");
    res.json(visionTerminalInput(service, provider, body.generation, body));
  });
  app.post("/api/vision-check", async (req, res) => {
    user(res);
    const body = z
      .object({ conversationId: id, member: memberSchema })
      .parse(req.body);
    const selected = conversation(service.store.state, body.conversationId);
    const { validateMemberConfig } = await import("./models.ts");
    await validateMemberConfig(body.member, service.store.state.project?.root);
    const { verifyVision } = await import("./vision-check.ts");
    res.json(await verifyVision(service, body.member, selected.permissionMode));
  });
  app.get("/api/state", (req, res) => {
    user(res);
    res.type("json").send(service.store.publicJSON());
  });
  app.get("/api/desktop/origin", (req, res) => {
    user(res);
    const origin = z.string().max(200).parse(req.query.origin);
    res.json({
      allowed: origin === service.url || projects.allowsOrigin(origin),
    });
  });
  app.get("/api/app-info", (req, res) => {
    user(res);
    const configuredChannel = process.env.RELAY_APP_CHANNEL;
    const channel = ["stable", "beta", "development"].includes(
      configuredChannel ?? "",
    )
      ? configuredChannel
      : "development";
    res.json({
      version: process.env.RELAY_APP_VERSION ?? "0.1.5",
      build: process.env.RELAY_APP_BUILD ?? "development",
      channel,
      desktop: "macos-arm64",
    });
  });
  app.get("/api/models/:provider", async (req, res) => {
    user(res);
    const provider = z
      .enum(["codex", "antigravity", "claude"])
      .parse(req.params.provider);
    const { modelCatalog } = await import("./models.ts");
    const { forgetVision, checkedVision } = await import("./vision.ts");
    const root = service.store.state.project?.root ?? "";
    if (req.query.refresh === "1") forgetVision(provider, root);
    const catalog = await modelCatalog(
      provider,
      root,
      req.query.refresh === "1",
    );
    res.json({
      ...catalog,
      defaultVision:
        (await checkedVision(provider, undefined, root)) ??
        catalog.models.find((m) => m.id === catalog.defaultModelId)?.vision,
      models: await Promise.all(
        catalog.models.map(async (m) => ({
          ...m,
          vision: (await checkedVision(provider, m.id, root)) ?? m.vision,
        })),
      ),
    });
  });
  app.get("/api/report", (req, res) => {
    user(res);
    const chatId = z.string().optional().parse(req.query.conversationId);
    if (req.query.format === "json")
      res.json(
        chatId
          ? service.conversationState(chatId)
          : service.store.publicState(),
      );
    else res.type("text/markdown").send(service.reportMarkdown(chatId));
  });
  app.get("/api/diff", async (req, res) => {
    user(res);
    const r = service.store.state.userRequests.find(
      (r) => r.id === req.query.requestId,
    );
    ensure(r?.snapshot && r.integrationPath, "NO_RESULT", "没有可用成果");
    const { git } = await import("./git.ts");
    const result = await git(
      r.integrationPath,
      "diff",
      r.snapshot.commit,
      "HEAD",
    );
    const files = (
      await git(
        r.integrationPath,
        "diff",
        "--name-only",
        "-z",
        r.snapshot.commit,
        "HEAD",
      )
    )
      .split("\0")
      .filter(Boolean);
    const pending = service.store.state.tasks.filter(
      (t) =>
        t.requestId === r.id &&
        t.kind === "code" &&
        t.commit &&
        !t.integratedCommit,
    );
    const pendingDiffs: string[] = [];
    for (const task of pending) {
      if (!task.worktree || !task.base) continue;
      try {
        pendingDiffs.push(
          `\n\n尚未整合：${task.title}（${task.status}）\n${await git(task.worktree, "diff", task.base, task.commit!)}`,
        );
      } catch {
        pendingDiffs.push(
          `\n尚未整合：${task.title}；工作区无法读取，成果版本 ${task.commit}`,
        );
      }
    }
    const current =
      r.status === "waiting" && files.length
        ? await git(
            r.snapshot.root,
            "--literal-pathspecs",
            "diff",
            r.snapshot.commit,
            "--",
            ...files,
          )
        : "";
    res
      .type("text/plain")
      .send(
        redact(
          `本次成果差异\n${result}${pendingDiffs.join("")}${current ? `\n\n原项目当前涉及文件的差异（回写已暂停）\n${current}\n请先处理人工修改，平台不会强制覆盖。` : ""}`,
        ),
      );
  });
  let pickingFolder = false,
    closing = false;
  const pickerAbort = new AbortController();
  // Console credentials for another project must never enter persisted action results.
  app.post("/api/project-folder", async (req, res) => {
    user(res);
    const { conversationId: chatId, path } = z
      .object({
        conversationId: id,
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine((p) => !p.includes("\0"))
          .optional(),
      })
      .parse(req.body);
    conversation(service.store.state, chatId);
    ensure(!pickingFolder, "PICKER_BUSY", "文件夹选择器已打开", 409);
    pickingFolder = true;
    try {
      const selected =
        path !== undefined
          ? await validateLocalPath(path, "folder")
          : await (
              options.pickFolder ??
              (() =>
                pickLocalPath(
                  "folder",
                  undefined,
                  process.platform,
                  pickerAbort.signal,
                ))
            )();
      if (!selected) {
        res.json({ cancelled: true });
        return;
      }
      ensure(
        !closing,
        "PROJECT_CLOSING",
        "服务正在关闭，请重新启动后选择项目",
        409,
      );
      ensure(selected.kind === "folder", "LOCAL_PATH_TYPE", "请选择文件夹");
      conversation(service.store.state, chatId);
      if (!service.store.state.project) {
        try {
          await service.work.inspect(selected.path);
        } catch {
          throw new AppError(
            "PROJECT_FOLDER",
            "请选择已有 Git 提交的项目文件夹；所选目录未被修改",
            400,
          );
        }
        await service.createProject(selected.path, "等待用户需求");
        projects.register(service);
        res.json({ url: service.url, token: service.auth.consoleToken });
      } else res.json(await projects.open(selected.path, service, chatId));
    } finally {
      pickingFolder = false;
    }
  });
  app.post("/api/action", async (req, res) => {
    user(res);
    const b = z
      .object({
        requestId: z.string().min(1).max(128),
        action: z.string(),
        data: z.unknown(),
      })
      .parse(req.body);
    const result = await service.request("user", b.requestId, b, async () => {
      const chatId =
        z.object({ conversationId: id.optional() }).parse(b.data ?? {})
          .conversationId ?? service.store.state.defaultConversationId;
      conversation(service.store.state, chatId);
      const data = b.data as Record<string, unknown> | undefined;
      if (
        ["manual", "stop", "recover", "message", "approval"].includes(b.action)
      ) {
        const agentId =
          b.action === "approval"
            ? service.store.state.approvals.find((a) => a.id === data?.id)
                ?.agentId
            : (data?.agentId ?? data?.targetId ?? data?.id);
        const member = service.store.state.agents.find((a) => a.id === agentId);
        ensure(
          member && conversationId(service.store.state, member) === chatId,
          "OTHER_CONVERSATION",
          "成员或请求不属于当前对话",
          409,
        );
      }
      if (
        [
          "retry",
          "verify",
          "cancel-task",
          "update-task",
          "review",
          "integrate",
        ].includes(b.action)
      ) {
        const taskId = data?.taskId ?? data?.id;
        const task = service.store.state.tasks.find((t) => t.id === taskId);
        ensure(
          task?.conversationId === chatId,
          "OTHER_CONVERSATION",
          "任务不属于当前对话",
          409,
        );
      }
      if (["pause", "planning", "stop-all"].includes(b.action)) {
        const current = service.store.state.userRequests.find(
          (r) => r.id === service.store.state.activeRequestId,
        );
        ensure(
          !current || conversationId(service.store.state, current) === chatId,
          "OTHER_CONVERSATION",
          "当前执行属于另一对话",
          409,
        );
      }
      switch (b.action) {
        case "conversation-create":
          return service.collaboration.createConversation(chatId);
        case "conversation-archive":
          return service.collaboration.archiveConversation(
            chatId,
            z.object({ archived: z.boolean() }).parse(b.data).archived,
          );
        case "conversation-delete":
          ensure(
            z.object({ confirmed: z.literal(true) }).parse(b.data).confirmed,
            "CONFIRM",
            "需要确认删除",
          );
          return service.collaboration.deleteConversation(chatId);
        case "project": {
          const d = z
            .object({ path: text, goal: text.default("等待用户需求") })
            .parse(b.data);
          return service.createProject(d.path, d.goal);
        }
        case "agent": {
          const d = z
            .object({
              name: z.string().min(1).max(60).optional(),
              provider: z.enum(["codex", "antigravity", "claude"]),
              role: z.string().min(1).max(100).default("团队成员"),
            })
            .parse(b.data);
          return service.addAgent(
            d.name ??
              `${d.provider === "antigravity" ? "Antigravity" : d.provider === "claude" ? "Claude Code" : "Codex"} ${service.store.state.agents.filter((a) => a.provider === d.provider).length + 1}`,
            d.provider,
            d.role,
            chatId,
          );
        }
        case "team": {
          if (b.data && typeof b.data === "object" && "members" in b.data) {
            const config = z
              .object({
                members: z.array(memberSchema).min(1).max(8),
                permissionMode: z.enum(["full", "native"]).default("full"),
              })
              .parse(b.data);
            return service.collaboration.configureTeam(config, chatId);
          }
          const counts = z
            .object({
              codex: z.number().int().min(0).max(8).default(0),
              antigravity: z.number().int().min(0).max(8).default(0),
              claude: z.number().int().min(0).max(8).default(0),
            })
            .parse(b.data);
          return service.collaboration.configureTeam(counts, chatId);
        }
        case "request":
        case "supplement": {
          const d = z
            .object({
              text: z.string().max(16000).default(""),
              attachmentIds: z.array(id).max(8).default([]),
            })
            .parse(b.data);
          ensure(
            d.text.trim() || d.attachmentIds.length,
            "EMPTY_REQUEST",
            "请填写需求或添加图片",
          );
          const members = service.store.state.agents.filter(
            (a) => conversationId(service.store.state, a) === chatId,
          );
          const reader = d.attachmentIds.length
            ? await service.visionMember(members.map((a) => a.id))
            : undefined;
          const content = d.text.trim() || "请分析附件图片";
          return b.action === "request"
            ? service.collaboration.submit(
                content,
                chatId,
                d.attachmentIds,
                reader,
              )
            : service.collaboration.supplement(
                content,
                chatId,
                d.attachmentIds,
                reader,
              );
        }
        case "request-stop":
          return service.collaboration.stop(chatId);
        case "request-resume":
          return service.collaboration.resume(
            z.object({ requestId: id.optional() }).parse(b.data ?? {})
              .requestId,
            chatId,
          );
        case "preferences": {
          const d = z
            .object({
              concurrency: z.number().int().min(1).max(4),
              maxMinutes: z.number().min(1).max(240),
            })
            .parse(b.data);
          service.store.mutate((s) => {
            s.concurrency = d.concurrency;
            if (s.project) s.project.plan.maxMinutes = d.maxMinutes;
          });
          return { ok: true };
        }
        case "plan": {
          const d = z
            .object({
              goal: text,
              checks: z
                .array(
                  z.object({
                    executable: text,
                    args: z.array(z.string()).max(100),
                  }),
                )
                .max(20),
              maxMinutes: z.number().min(1).max(240),
              concurrency: z.number().int().min(1).max(8),
            })
            .parse(b.data);
          return service.updatePlan(
            d.goal,
            d.checks,
            d.maxMinutes,
            d.concurrency,
          );
        }
        case "task":
          return service.addTask(taskSchema.parse(b.data));
        case "update-task": {
          const d = taskSchema.extend({ id }).parse(b.data);
          const { id: taskId, ...input } = d;
          return service.updateTask(taskId, input);
        }
        case "cancel-task":
          return service.cancelTask(z.object({ id }).parse(b.data).id);
        case "approve-plan":
          return service.approvePlan(
            z.object({ version: z.number().int() }).parse(b.data).version,
          );
        case "pause":
          return service.setPaused(
            z.object({ paused: z.boolean() }).parse(b.data).paused,
          );
        case "planning":
          return service.startPlanning(z.object({ id }).parse(b.data).id);
        case "stop":
          return service.stopAgent(z.object({ id }).parse(b.data).id);
        case "stop-all":
          return service.stopAll();
        case "manual": {
          const d = z.object({ id, enabled: z.boolean() }).parse(b.data);
          return service.manual(d.id, d.enabled);
        }
        case "recover":
          return service.acknowledgeRecovery(z.object({ id }).parse(b.data).id);
        case "retry":
          return service.retryTask(z.object({ id }).parse(b.data).id);
        case "message": {
          const d = z
            .object({ targetId: id, text, taskId: id.optional() })
            .parse(b.data);
          return service.sendMessage("user", d);
        }
        case "verify":
          return service.verifyTask(z.object({ id }).parse(b.data).id);
        case "review": {
          const d = z.object({ id, accepted: z.boolean() }).parse(b.data);
          return service.review(d.id, d.accepted);
        }
        case "integrate":
          return service.integrate(z.object({ id }).parse(b.data).id);
        case "finalize":
          return service.finalize();
        case "approval": {
          const d = z.object({ id, accepted: z.boolean() }).parse(b.data);
          return service.approveRequest(d.id, d.accepted);
        }
        default:
          throw new AppError("UNKNOWN_ACTION", "未知操作");
      }
    });
    res.json(result ?? { ok: true });
  });
  app.post("/api/tools", async (req, res) => {
    const actor = res.locals.actor;
    ensure(actor !== "user", "AGENT_REQUIRED", "协作工具需要 Agent 身份", 403);
    const body = z
      .object({
        tool: z.string(),
        generation: z.string().uuid().optional(),
        requestId: z.string().min(1).max(128),
        arguments: z.unknown(),
      })
      .parse(req.body);
    const currentAgent = service.store.state.agents.find((a) => a.id === actor);
    ensure(
      currentAgent &&
        (!currentAgent.generation ||
          currentAgent.generation === body.generation),
      "STALE_SESSION",
      "旧会话协作身份已失效",
      409,
    );
    ensure(
      !currentAgent?.generation ||
        ["starting", "running", "waiting", "idle"].includes(
          currentAgent.status,
        ),
      "STALE_SESSION",
      "原生会话已经结束",
      409,
    );
    const active = service.store.state.userRequests.find(
      (r) => r.id === service.store.state.activeRequestId,
    );
    ensure(
      !active || active.agentIds.includes(actor),
      "OTHER_CONVERSATION",
      "当前需求属于另一对话",
      409,
    );
    // Image bytes must never enter the persisted idempotency result cache.
    if (body.tool === "read_attachment") {
      const args = z.object({ attachmentId: id }).parse(body.arguments);
      res.json(
        await service.collaboration.readAttachment(actor, args.attachmentId),
      );
      return;
    }
    const result = await service.request(
      actor,
      body.requestId,
      body,
      async () => {
        switch (body.tool) {
          case "submit_vision_analysis": {
            const d = z
              .object({ requestId: id, batchId: id, analysis: text })
              .parse(body.arguments);
            return service.collaboration.submitVision(
              actor,
              d.requestId,
              d.batchId,
              d.analysis,
            );
          }
          case "publish_plan": {
            const d = z
              .object({
                requestId: id,
                version: z.number().int().min(0),
                cancelKeys: z.array(z.string().min(1)).max(100).default([]),
                tasks: z
                  .array(
                    taskSchema.extend({
                      key: z.string().min(1).max(100),
                      kind: z.enum(["analysis", "code"]),
                      dependencies: z
                        .array(z.string().min(1))
                        .max(100)
                        .default([]),
                    }),
                  )
                  .max(100),
              })
              .parse(body.arguments);
            ensure(
              d.requestId === service.store.state.activeRequestId,
              "STALE_REQUEST",
              "需求已变化",
              409,
            );
            return service.collaboration.publish(
              actor,
              d.version,
              d.tasks,
              d.cancelKeys,
            );
          }
          case "transfer_coordinator":
            return service.collaboration.transfer(
              actor,
              z.object({ targetId: id }).parse(body.arguments).targetId,
            );
          case "ask_user":
            return service.collaboration.ask(
              actor,
              z.object({ question: text }).parse(body.arguments).question,
            );
          case "complete_request": {
            const d = z
              .object({ requestId: id, summary: text })
              .parse(body.arguments);
            ensure(
              d.requestId === service.store.state.activeRequestId,
              "STALE_REQUEST",
              "需求已变化",
              409,
            );
            return service.collaboration.summary(actor, d.summary);
          }
          case "get_project_state":
            return service.agentState(actor);
          case "send_task": {
            const d = z
              .object({ taskId: id, targetId: id })
              .parse(body.arguments);
            return service.sendTask(actor, d.taskId, d.targetId);
          }
          case "send_message": {
            const d = z
              .object({
                targetId: id,
                text,
                taskId: id.optional(),
                replyTo: id.optional(),
                kind: z
                  .enum(["question", "reply", "progress", "result"])
                  .optional(),
              })
              .parse(body.arguments);
            return service.sendMessage(actor, d);
          }
          case "report_progress": {
            const d = z
              .object({
                taskId: id,
                runId: id,
                progress: text,
                remaining: z.string().max(16000).default(""),
                blocked: z.boolean().default(false),
              })
              .parse(body.arguments);
            return service.report(
              actor,
              d.taskId,
              d.runId,
              d.progress,
              d.remaining,
              d.blocked,
            );
          }
          case "submit_result": {
            const d = z
              .object({
                taskId: id,
                runId: id,
                summary: text,
                evidence: text.optional(),
              })
              .parse(body.arguments);
            return service.submit(
              actor,
              d.taskId,
              d.runId,
              d.summary,
              d.evidence,
            );
          }
          case "ack_message":
            return service.ackMessage(
              actor,
              z.object({ messageId: id }).parse(body.arguments).messageId,
            );
          case "propose_task":
            ensure(
              !service.store.state.activeRequestId,
              "AUTONOMOUS_PLAN",
              "当前需求请使用 publish_plan 更新整体计划",
            );
            return service.addTask(taskSchema.parse(body.arguments), actor);
          case "review_result": {
            const d = z
              .object({
                taskId: id,
                commit: z.string().regex(/^[0-9a-f]{40,64}$/),
                accepted: z.boolean(),
                note: text,
              })
              .parse(body.arguments);
            return service.peerReview(
              actor,
              d.taskId,
              d.commit,
              d.accepted,
              d.note,
            );
          }
          default:
            throw new AppError("UNKNOWN_TOOL", "未知协作工具");
        }
      },
    );
    const a = service.store.state.agents.find((a) => a.id === actor);
    if (a && ["starting", "running", "waiting", "idle"].includes(a.status)) {
      service.runtime.emit("event", {
        agentId: a.id,
        type: "activity",
        sessionId: a.sessionId,
      });
    }
    res.json(result ?? { ok: true });
  });
  app.post("/api/hooks", (req, res) => {
    const actor = res.locals.actor;
    ensure(actor !== "user", "AGENT_REQUIRED", "需要 Agent 身份", 403);
    const b = z
      .object({
        event: z.enum(["start", "stop", "session", "activity"]),
        sessionId: z.string().max(150).optional(),
        runId: z.string().max(100).optional(),
        generation: z.string().uuid().optional(),
        model: z.string().max(160).optional(),
        effort: z.string().max(30).optional(),
      })
      .parse(req.body);
    const s = service.store.state;
    const a = s.agents.find((a) => a.id === actor);
    ensure(a, "AGENT_NOT_FOUND", "Agent 不存在");
    ensure(
      !a.generation || a.generation === b.generation,
      "STALE_SESSION",
      "旧会话 hook 已失效",
      409,
    );
    ensure(
      !a.generation ||
        ["starting", "running", "waiting", "idle"].includes(a.status),
      "STALE_SESSION",
      "原生会话已经结束",
      409,
    );
    if (b.runId)
      ensure(
        s.tasks.some((t) => t.ownerId === actor && t.runId === b.runId),
        "STALE_RUN",
        "旧会话 hook 已失效",
        409,
      );
    if (b.sessionId && a.boundSessionId && b.sessionId !== a.boundSessionId) {
      service.store.mutate((s) => {
        const member = s.agents.find((member) => member.id === actor)!;
        member.sessionError =
          "原生会话接续身份不一致，已暂停；请检查原生历史，不能另建对话。";
        member.status = "error";
        const request = s.userRequests.find(
          (r) => r.id === s.activeRequestId && r.agentIds.includes(actor),
        );
        if (request) {
          request.status = "waiting";
          request.error = member.sessionError;
        }
      });
      service.auth.revoke(actor);
      void service.runtime.stop(actor).catch(() => {});
      throw new AppError(
        "SESSION_MISMATCH",
        "原生会话身份不一致；不会另建对话",
        409,
      );
    }
    const messages = ["session", "activity"].includes(b.event)
      ? []
      : s.messages.filter(
          (m) =>
            m.targetId === actor &&
            m.kind !== "task" &&
            ["queued", "failed"].includes(m.status),
        );
    service.store.mutate((s) => {
      const a = s.agents.find((a) => a.id === actor)!;
      if (b.sessionId) {
        a.sessionId = b.sessionId;
        a.boundSessionId = b.sessionId;
        if (a.probe) {
          a.probe.verified = true;
          a.probe.notes = [
            "已收到真实原生生命周期 Hook；空闲消息通过同一会话 ID 接续。",
          ];
        }
      }
      for (const m of s.messages)
        if (messages.some((x) => x.id === m.id)) {
          m.status = "delivered";
          m.error = undefined;
          service.store.event(
            s,
            "message.delivered",
            "通过原生会话 hook 送达",
            { agentId: actor, messageId: m.id },
          );
        }
    });
    if (!["session", "activity"].includes(b.event))
      service.runtime.observeLifecycle(
        actor,
        b.sessionId,
        b.event === "stop" && !messages.length,
      );
    service.runtime.emit("event", {
      agentId: actor,
      type:
        b.event === "activity"
          ? "activity"
          : b.event === "session"
            ? "session-confirmed"
            : b.event === "stop" && !messages.length
              ? "turn-ended"
              : "started",
      sessionId: b.sessionId,
      model: b.model,
      effort: b.effort,
      detail: "原生生命周期 hook",
    });
    res.json({ messages });
  });
  const broadcast = (value: unknown, serialized?: string) => {
    const data = serialized ?? JSON.stringify(value);
    for (const client of wss.clients)
      if (client.readyState === WebSocket.OPEN) {
        if (client.bufferedAmount > 2 * 1024 * 1024)
          client.close(1013, "slow consumer");
        else client.send(data);
      }
  };
  const onChange = (state: unknown) =>
    broadcast({ type: "state", state }, service.store.publicMessage());
  const onTerminal = (packet: unknown) =>
    broadcast({ type: "terminal", ...(packet as object) });
  service.store.on("change", onChange);
  service.runtime.on("terminal", onTerminal);
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") return socket.destroy();
    if (req.headers.origin !== `http://${req.headers.host}`)
      return socket.destroy();
    const protocols =
      req.headers["sec-websocket-protocol"]?.split(",").map((x) => x.trim()) ??
      [];
    const credential =
      protocols.find((x) => x.startsWith("relay."))?.slice(6) ?? "";
    if (service.auth.actor(credential) !== "user") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    ws.send(service.store.publicMessage());
    ws.on("message", async (raw) => {
      try {
        const b = z
          .discriminatedUnion("type", [
            z.object({
              type: z.literal("input"),
              conversationId: id.optional(),
              generation: z.string().optional(),
              agentId: id,
              data: z.string().max(16000),
            }),
            z.object({
              type: z.literal("resize"),
              conversationId: id.optional(),
              generation: z.string().optional(),
              agentId: id,
              cols: z.number().int(),
              rows: z.number().int(),
            }),
            z.object({ type: z.literal("snapshot"), agentId: id }),
            z.object({
              type: z.literal("scroll"),
              agentId: id,
              conversationId: id,
              generation: z.string().uuid(),
              direction: z.enum(["up", "down"]),
              count: z.number().int().min(1).max(10),
              col: z.number().int().min(1).max(1000),
              row: z.number().int().min(1).max(500),
            }),
          ])
          .parse(JSON.parse(raw.toString()));
        if (b.type === "input" || b.type === "resize") {
          const a = service.store.state.agents.find((a) => a.id === b.agentId);
          ensure(
            a &&
              (!b.conversationId ||
                conversationId(service.store.state, a) === b.conversationId) &&
              (!b.generation || !a.generation || a.generation === b.generation),
            "STALE_SESSION",
            "终端身份已变化",
          );
        }
        if (b.type === "input") {
          const a = service.store.state.agents.find((a) => a.id === b.agentId);
          ensure(a?.manual, "MANUAL_REQUIRED", "先开启人工接管");
          service.runtime.write(b.agentId, b.data);
        }
        if (b.type === "scroll") {
          const a = service.store.state.agents.find((a) => a.id === b.agentId);
          ensure(
            a &&
              conversationId(service.store.state, a) === b.conversationId &&
              a.generation === b.generation,
            "STALE_SESSION",
            "终端身份已变化",
          );
          service.runtime.scroll?.(
            b.agentId,
            b.generation,
            b.direction,
            b.count,
            b.col,
            b.row,
          );
        }
        if (b.type === "resize")
          service.runtime.resize(b.agentId, b.cols, b.rows);
        if (b.type === "snapshot") {
          const snapshot = await service.runtime.snapshot(b.agentId);
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                type: "terminal-snapshot",
                agentId: b.agentId,
                ...snapshot,
              }),
            );
        }
      } catch (e) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({ type: "error", message: (e as Error).message }),
          );
      }
    });
  });
  let vite: any;
  if (options.dev) {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({
      root: options.root,
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(resolve(options.root, "dist")));
    app.get("/{*path}", (req, res) =>
      res.sendFile(resolve(options.root, "dist/index.html")),
    );
  }
  app.use(
    (
      err: any,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const status = err instanceof z.ZodError ? 400 : (err.status ?? 500);
      res.status(status).json({
        error: {
          code:
            err.code ?? (err instanceof z.ZodError ? "VALIDATION" : "INTERNAL"),
          message: redact(
            err instanceof z.ZodError
              ? err.issues
                  .map((i: any) => `${i.path.join(".")}: ${i.message}`)
                  .join("; ")
              : err.message,
          ),
        },
      });
    },
  );
  await new Promise<void>((r) => server.listen(options.port, "127.0.0.1", r));
  const address = server.address();
  ensure(address && typeof address !== "string", "LISTEN", "监听失败");
  service.url = `http://127.0.0.1:${address.port}`;
  projects.register(service);
  return {
    server,
    url: service.url,
    close: async () => {
      closing = true;
      pickerAbort.abort();
      if (ownsProjects) await projects.close();
      service.store.off("change", onChange);
      service.runtime.off("terminal", onTerminal);
      for (const c of wss.clients) c.terminate();
      wss.close();
      await vite?.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    },
  };
}
