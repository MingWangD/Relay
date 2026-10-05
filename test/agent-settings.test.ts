import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import {
  agentStatusText,
  approvalPresentation,
} from "../src/shared/presentation.ts";
import { createHttp } from "../src/server/http.ts";
import { resolve } from "node:path";

test("Anti permission waiting is visible independently of missing lifecycle; MCP proves activity", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = f.agent("Antigravity 1");
  f.store.mutate((s) => {
    s.agents[0].provider = "antigravity";
    s.agents[0].status = "starting";
  });
  f.runtime.emit("event", {
    agentId: id,
    type: "connected",
    awaitingTurn: true,
    pid: 9999999,
  });
  assert.equal(
    agentStatusText(f.store.state.agents[0]),
    "已启动，等待会话确认",
  );
  f.runtime.emit("event", {
    agentId: id,
    type: "attention",
    detail: "原生权限确认",
  });
  assert.equal(agentStatusText(f.store.state.agents[0]), "等待确认");
  const app = await createHttp(f.service, { port: 0, root: resolve(".") });
  t.after(app.close);
  const response = await fetch(app.url + "/api/tools", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${f.service.auth.issue(id)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool: "get_project_state",
      requestId: "activity",
      arguments: {},
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(f.store.state.agents[0].status, "running");
  assert.equal(f.store.state.agents[0].sessionId, undefined);
  assert.ok(f.store.state.agents[0].connectionWarning?.includes("接续"));
});

test("Claude retry reminder clears on current tool activity and a later error can appear again", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = f.agent();
  f.store.mutate((s) => {
    s.agents[0].provider = "claude";
  });
  f.runtime.emit("event", {
    agentId: id,
    type: "native-error",
    detail: "连接重试",
  });
  assert.equal(f.store.state.agents[0].nativeError, "连接重试");
  f.runtime.emit("event", { agentId: id, type: "activity" });
  assert.equal(f.store.state.agents[0].nativeError, undefined);
  assert.equal(f.store.state.agents[0].status, "running");
  f.runtime.emit("event", {
    agentId: id,
    type: "native-error",
    detail: "新的连接重试",
  });
  assert.equal(f.store.state.agents[0].nativeError, "新的连接重试");
});

test("member settings survive resizing; legacy counts keep native approvals; save never starts models", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.service.collaboration.configureTeam({
    members: [
      { provider: "codex", model: "test-model", reasoningEffort: "high" },
      { provider: "codex", model: "other-model", reasoningEffort: "low" },
    ],
    permissionMode: "full",
  });
  const [a, b] = f.store.state.agents;
  assert.equal(a.permissionMode, "full");
  assert.equal(b.model, "other-model");
  await f.service.collaboration.configureTeam({
    members: [
      {
        id: a.id,
        provider: "codex",
        model: a.model,
        reasoningEffort: a.reasoningEffort,
      },
    ],
    permissionMode: "full",
  });
  assert.equal(f.store.state.agents[0].id, a.id);
  assert.equal(f.runtime.starts.length, 0);
  await f.service.collaboration.configureTeam({ codex: 1 });
  assert.equal(f.store.state.agents[0].permissionMode, "native");
});

test("readable MCP approval excludes protocol fields; unknown and nonempty forms require terminal", () => {
  const p = approvalPresentation(
    "mcpServer/elicitation/request",
    JSON.stringify({
      threadId: "hidden",
      mode: "form",
      message: 'Allow the relay MCP server to run tool "get_project_state"?',
      _meta: { tool_description: "读取项目计划、成员、任务和收件箱。" },
      requestedSchema: { type: "object", properties: {} },
    }),
  );
  assert.equal(p.title, "读取项目协作状态");
  assert.equal(p.supported, true);
  assert.ok(!JSON.stringify(p).includes("hidden"));
  assert.equal(
    approvalPresentation("item/permissions/requestApproval", "{}").supported,
    false,
  );
  assert.equal(
    approvalPresentation(
      "mcpServer/elicitation/request",
      JSON.stringify({
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      }),
    ).supported,
    false,
  );
});

test("analysis submission fails on worktree or original-file writes under full access", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { until } = await import("./helpers.ts");
  const f = await fixture();
  t.after(f.cleanup);
  const id = f.agent();
  f.store.mutate((s) => {
    s.agents[0].permissionMode = "full";
  });
  const taskId = f.service.addTask({
    ownerId: id,
    title: "分析",
    description: "只分析",
    acceptance: "引用文件",
    dependencies: [],
  }).id;
  f.store.mutate((s) => {
    s.tasks[0].kind = "analysis";
  });
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await until(() => f.store.state.tasks[0].status === "running");
  const task = f.store.state.tasks[0];
  await writeFile(join(f.repo, "hello.txt"), "unauthorized analysis write");
  await assert.rejects(
    f.service.submit(id, taskId, task.runId!, "report", "hello.txt:1"),
    /分析任务修改了项目文件/,
  );
  assert.equal(f.store.state.tasks[0].status, "failed");
  assert.equal(f.store.state.tasks[0].commit, undefined);
});

test("running and queued teams reject permission edits; saved settings and historical snapshots survive reload", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.service.collaboration.configureTeam({
    members: [{ provider: "codex", model: "custom", reasoningEffort: "high" }],
    permissionMode: "full",
  });
  const a = f.store.state.agents[0];
  const request = f.service.collaboration.submit("分析");
  await assert.rejects(
    f.service.collaboration.configureTeam({
      members: [{ id: a.id, provider: "codex" }],
      permissionMode: "native",
    }),
    /执行或排队/,
  );
  await f.service.collaboration.stop();
  await f.service.collaboration.configureTeam({
    members: [{ id: a.id, provider: "codex", model: "new" }],
    permissionMode: "native",
  });
  const history = f.store.state.userRequests.find((r) => r.id === request.id)!;
  assert.equal(history.members?.[0].model, "custom");
  assert.equal(history.members?.[0].permissionMode, "full");
  const { Store } = await import("../src/server/store.ts");
  const { join } = await import("node:path");
  const reopened = new Store(join(f.data, "state.sqlite"));
  try {
    assert.equal(reopened.state.agents[0].model, "new");
    assert.equal(reopened.state.permissionMode, "native");
    assert.equal(
      reopened.state.userRequests[0].members?.[0].reasoningEffort,
      "high",
    );
  } finally {
    reopened.close();
  }
});

test("fresh generation clears old native identity and stopping resolves obsolete approvals", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = f.agent();
  f.store.mutate((s) => {
    s.agents[0].sessionId = "old-session";
  });
  f.runtime.emit("event", {
    agentId: id,
    type: "connected",
    awaitingTurn: true,
    pid: 9999999,
    generation: crypto.randomUUID(),
  });
  assert.equal(f.store.state.agents[0].sessionId, undefined);
  f.runtime.emit("event", {
    agentId: id,
    type: "approval",
    request: {
      id: crypto.randomUUID(),
      method: "item/commandExecution/requestApproval",
      params: { command: "pwd" },
    },
  });
  const token = f.service.auth.issue(id);
  assert.equal(f.service.auth.actor(token), id);
  assert.equal(f.store.state.approvals[0].status, "pending");
  await f.service.stopAgent(id);
  assert.equal(f.store.state.approvals[0].status, "resolved");
  assert.equal(f.service.auth.actor(token), undefined);
  const lateToken = f.service.auth.issue(id);
  f.runtime.emit("event", { agentId: id, type: "exit" });
  assert.equal(f.service.auth.actor(lateToken), undefined);
});
