import test from "node:test";
import assert from "node:assert/strict";
import { fixture, until } from "./helpers.ts";

test("completed chat remains archivable after restart with dead idle native sessions", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = f.agent();
  const chatId = f.store.state.defaultConversationId;
  const request = f.service.collaboration.submit("已经完成的分析");
  f.store.mutate((s) => {
    const r = s.userRequests.find((r) => r.id === request.id)!;
    r.status = "completed";
    r.summary = "最终结论";
    r.control = undefined;
    s.activeRequestId = undefined;
    Object.assign(s.agents[0], {
      status: "idle",
      pid: 9999999,
      boundSessionId: "retained",
      sessionCwd: f.repo,
    });
  });
  f.service.recover();
  assert.doesNotThrow(() =>
    f.service.collaboration.archiveConversation(chatId, true),
  );
  assert.equal(f.store.state.agents[0].boundSessionId, "retained");
  assert.equal(f.runtime.starts.length, 0);
  // Existing installations already have stale recovery flags from the old restart path.
  f.service.collaboration.archiveConversation(chatId, false);
  f.store.mutate((s) => {
    s.agents.find((a) => a.id === id)!.status = "recovery";
  });
  assert.doesNotThrow(() =>
    f.service.collaboration.archiveConversation(chatId, true),
  );
});

test("settled-session cleanup retains live processes, unknown outcomes and active work guards", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const agentId = f.agent();
  const chatId = f.store.state.defaultConversationId;
  const request = f.service.collaboration.submit("分析");
  f.store.mutate((s) => {
    s.userRequests[0].status = "completed";
    s.activeRequestId = undefined;
    Object.assign(s.agents[0], { status: "recovery", pid: process.pid });
  });
  const archive = () =>
    f.service.collaboration.archiveConversation(chatId, true);
  assert.throws(archive, /停止/);
  f.store.mutate((s) => {
    s.agents[0].pid = 9999999;
    s.runs.push({
      id: "unknown",
      taskId: "uncertain",
      agentId,
      status: "unknown",
      startedAt: new Date().toISOString(),
    });
  });
  assert.throws(archive, /停止/);
  f.store.mutate((s) => {
    s.runs = [];
    s.agents[0].manual = true;
  });
  assert.throws(archive, /停止/);
  f.store.mutate((s) => {
    s.agents[0].manual = false;
    s.agents[0].sessionError = "原生身份待核对";
  });
  assert.throws(archive, /停止/);
  f.store.mutate((s) => {
    s.agents[0].sessionError = undefined;
    s.userRequests.find((r) => r.id === request.id)!.status = "queued";
  });
  assert.throws(archive, /停止/);
  assert.equal(f.runtime.starts.length, 0);
});

test("new conversation clones settings without inference and isolates routing/archive/delete", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent();
  const first = f.store.state.defaultConversationId;
  f.store.mutate((s) => {
    Object.assign(s.agents[0], {
      model: "selected",
      sessionId: "original-native",
    });
  });
  const next = f.service.collaboration.createConversation(first);
  const cloned = f.store.state.agents.find(
    (a) => a.conversationId === next.id,
  )!;
  assert.ok(cloned && cloned.id !== a);
  assert.equal(cloned.model, "selected");
  assert.equal(cloned.sessionId, undefined);
  assert.equal(f.runtime.starts.length, 0);
  const request = f.service.collaboration.submit(
    "second conversation",
    next.id,
  );
  assert.equal(
    f.store.state.userRequests.find((r) => r.id === request.id)!.conversationId,
    next.id,
  );
  assert.deepEqual(f.store.state.userRequests[0].agentIds, [cloned.id]);
  await until(() => f.store.state.activeRequestId === request.id);
  await assert.rejects(
    f.service.collaboration.supplement("wrong target", first),
    /对话/,
  );
  assert.throws(
    () => f.service.collaboration.archiveConversation(next.id, true),
    /停止/,
  );
  await f.service.collaboration.stop(next.id);
  f.service.collaboration.archiveConversation(next.id, true);
  assert.ok(
    f.store.state.conversations.find((c) => c.id === next.id)!.archivedAt,
  );
  f.service.collaboration.archiveConversation(next.id, false);
  await f.service.collaboration.deleteConversation(next.id);
  assert.equal(
    f.store.state.conversations.some((c) => c.id === next.id),
    false,
  );
  assert.equal(
    f.store.state.agents.some((x) => x.id === a),
    true,
  );
});

test("one native identity survives planning, a task and summarizing in fixed startup directory", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent();
  const request = f.service.collaboration.submit("分析项目");
  await until(
    () =>
      f.runtime.starts.length === 1 &&
      f.store.state.agents[0].status === "running",
  );
  const first = f.runtime.starts[0];
  f.runtime.emit("event", { agentId: a, type: "turn-ended" });
  await f.service.collaboration.publish(a, 0, [
    {
      key: "analysis",
      title: "分析",
      description: "只读",
      ownerId: a,
      dependencies: [],
      acceptance: "引用文件",
      kind: "analysis",
    },
  ]);
  await until(() => f.runtime.starts.length >= 2);
  assert.equal(f.runtime.starts[1].resumeSessionId, "session-" + a);
  assert.equal(f.runtime.starts[1].cwd, first.cwd);
  assert.notEqual(f.store.state.tasks[0].worktree, first.cwd);
  assert.ok(
    f.runtime.starts[1].prompt!.includes(f.store.state.tasks[0].worktree!),
  );
  const task = f.store.state.tasks[0];
  await f.service.submit(a, task.id, task.runId!, "报告", "hello.txt:1");
  f.runtime.emit("event", { agentId: a, type: "turn-ended" });
  await until(() => f.store.state.userRequests[0].control?.kind === "summary");
  f.service.collaboration.summary(a, "总结");
  f.runtime.emit("event", { agentId: a, type: "turn-ended" });
  await until(() => f.store.state.userRequests[0].status === "completed");
  f.service.collaboration.submit("后续问题");
  await until(() => f.runtime.starts.length === 4);
  assert.ok(
    f.runtime.starts
      .slice(1)
      .every(
        (start) =>
          start.resumeSessionId === "session-" + a && start.cwd === first.cwd,
      ),
  );
  assert.equal(f.store.state.agents[0].boundSessionId, "session-" + a);
});

test("resume failure and missing native identity never fall back to a new conversation", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = f.agent();
  f.store.mutate((s) => {
    Object.assign(s.agents[0], {
      boundSessionId: "missing",
      sessionCwd: f.repo,
    });
  });
  const calls: string[] = [];
  f.runtime.start = async (options) => {
    calls.push(options.resumeSessionId!);
    throw Error("not found");
  };
  const start = () =>
    f.service.startSession({
      agent: f.store.state.agents[0],
      cwd: f.repo,
      readOnly: true,
      url: f.service.url,
      token: "fixture",
    });
  await assert.rejects(start(), /not found/);
  await assert.rejects(start(), /接续失败/);
  assert.deepEqual(calls, ["missing"]);
  f.store.mutate((s) =>
    Object.assign(s.agents[0], {
      sessionError: undefined,
      boundSessionId: undefined,
      sessionStarted: true,
    }),
  );
  await assert.rejects(start(), /尚未确认/);
  assert.deepEqual(calls, ["missing"]);
  f.store.mutate((s) =>
    Object.assign(s.agents[0], {
      boundSessionId: "retained",
      sessionStarted: true,
      sessionError: undefined,
    }),
  );
  f.runtime.start = async (options) => {
    f.runtime.sessions.set(id, options);
    return { pid: 9999999, sessionId: "unexpected" };
  };
  await assert.rejects(start(), /身份不一致/);
  assert.equal(f.runtime.has(id), false);
  assert.equal(f.store.state.agents[0].boundSessionId, "retained");
  assert.match(f.store.state.agents[0].sessionError!, /身份不一致/);
  await assert.rejects(start(), /接续失败/);
});

test("cross-chat tools, resume and configuration cannot affect another chat; additions retain identities", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const first = f.agent();
  const next = f.service.collaboration.createConversation();
  const other = f.store.state.agents.find((a) => a.conversationId === next.id)!;
  await assert.rejects(
    f.service.sendMessage(first, { targetId: other.id, text: "leak" }),
    /跨对话/,
  );
  assert.deepEqual(
    f.service.agentState(first).agents.map((a) => a.id),
    [first],
  );
  f.store.mutate((s) => {
    Object.assign(
      s.agents.find((a) => a.id === first)!,
      { boundSessionId: "retained", sessionCwd: f.repo },
    );
  });
  await f.service.collaboration.configureTeam({
    members: [{ id: first, provider: "codex" }, { provider: "claude" }],
    permissionMode: "native",
  });
  assert.equal(
    f.store.state.agents.find((a) => a.id === first)!.boundSessionId,
    "retained",
  );
  assert.equal(
    f.store.state.agents.find((a) => a.id === other.id)!.conversationId,
    next.id,
  );
  const request = f.service.collaboration.submit("isolated", next.id);
  await assert.rejects(
    f.service.collaboration.resume(
      request.id,
      f.store.state.defaultConversationId,
    ),
    /对话/,
  );
});

test("archive and deletion wait for stopping, and deleting never removes native global history", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.agent();
  const id = f.store.state.defaultConversationId;
  let release!: () => void;
  f.runtime.stop = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const stopping = f.service.collaboration.stop(id);
  assert.throws(
    () => f.service.collaboration.archiveConversation(id, true),
    /停止/,
  );
  await assert.rejects(f.service.collaboration.deleteConversation(id), /停止/);
  release();
  await stopping;
  f.runtime.stop = async () => {};
  await f.service.collaboration.deleteConversation(id);
  assert.equal(f.store.state.conversations.length, 1);
  assert.equal(f.store.state.agents.length, 0);
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(f.repo + "/hello.txt", "utf8"), "base\n");
});
