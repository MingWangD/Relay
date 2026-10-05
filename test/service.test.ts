import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, until } from "./helpers.ts";
import { git } from "../src/server/git.ts";

test("未批准不能执行；旧计划不能获批；同一 Agent 不重复领取", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const owner = f.agent();
  f.task(owner);
  await assert.rejects(() => f.service.setPaused(false), /先批准/);
  const old = f.store.state.project!.plan.version;
  f.task(owner, "第二项");
  assert.throws(() => f.service.approvePlan(old), /版本已改变/);
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await until(() => f.runtime.starts.length === 1);
  await Promise.all([f.service.schedule(), f.service.schedule()]);
  assert.equal(f.runtime.starts.length, 1);
  assert.equal(
    f.store.state.tasks.filter((t) => t.status === "running").length,
    1,
  );
});
test("并发 4、依赖门槛和独立工作区", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const first = f.task(f.agent("上游"));
  const downstream = f.task(f.agent("下游"), "依赖任务", [first]);
  for (let i = 0; i < 6; i++) f.task(f.agent(`agent-${i}`), `并行 ${i}`);
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await until(() => f.runtime.starts.length === 4);
  assert.equal(
    f.store.state.tasks.find((x) => x.id === downstream)!.status,
    "queued",
  );
  assert.equal(new Set(f.runtime.starts.map((x) => x.cwd)).size, 4);
  assert.ok(f.runtime.starts.every((x) => x.cwd !== f.repo));
  await f.service.setPaused(true);
  await f.service.stopAgent(f.runtime.starts[0].agent.id);
  await f.service.schedule();
  assert.equal(f.runtime.starts.length, 4);
});
test("请求重投去重，标识不能复用于另一请求", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent();
  let called = 0;
  const run = () =>
    f.service.request("user", "same", { name: "task" }, async () => {
      called++;
      return f.service.addTask({
        title: "一次",
        description: "test",
        acceptance: "test",
        ownerId: a,
        dependencies: [],
      });
    });
  const [one, two] = await Promise.all([run(), run()]);
  assert.deepEqual(one, two);
  assert.equal(called, 1);
  assert.equal(f.store.state.tasks.length, 1);
  await assert.rejects(
    () =>
      f.service.request("user", "same", { different: true }, async () => {}),
    /不同内容/,
  );
});
test("消息路由及 ACK 必须匹配目标身份", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent("A"),
    b = f.agent("B");
  const result = await f.service.sendMessage(a, {
    targetId: b,
    text: "请检查接口",
  });
  assert.equal(result.status, "queued");
  const inbox = f.service.agentState(b).inbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].status, "delivered");
  assert.throws(() => f.service.ackMessage(a, result.id), /他人/);
  f.service.ackMessage(b, result.id);
  assert.equal(f.service.agentState(b).inbox.length, 0);
  await assert.rejects(
    () => f.service.sendMessage(a, { targetId: a, text: "loop" }),
    /自己/,
  );
});
test("成果须有独立测试与评审，整合后下游获得实际代码", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent("A"),
    b = f.agent("B");
  const id = f.task(a),
    dependent = f.task(b, "下游", [id]);
  f.service.updatePlan(
    "目标",
    [
      {
        executable: process.execPath,
        args: [
          "-e",
          "const fs=require('fs');if(!fs.existsSync('feature.txt'))process.exit(1)",
        ],
      },
    ],
    30,
    4,
  );
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await until(() => f.store.state.tasks[0].status === "running");
  const task = f.store.state.tasks.find((t) => t.id === id)!;
  await writeFile(join(task.worktree!, "feature.txt"), "implemented\n");
  await git(task.worktree!, "add", "feature.txt");
  await git(task.worktree!, "commit", "-m", "feature");
  await f.service.submit(a, id, task.runId!, "已实现");
  f.runtime.emit("event", { agentId: a, type: "turn-ended" });
  assert.equal(f.store.state.tasks[0].status, "review");
  assert.throws(() => f.service.review(id, true), /检查未通过/);
  await f.service.verifyTask(id);
  f.service.review(id, true);
  await f.service.integrate(id);
  await until(
    () =>
      f.store.state.tasks.find((t) => t.id === dependent)!.status === "running",
  );
  const next = f.store.state.tasks.find((t) => t.id === dependent)!;
  assert.equal(
    await readFile(join(next.worktree!, "feature.txt"), "utf8"),
    "implemented\n",
  );
  await assert.rejects(() => readFile(join(f.repo, "feature.txt")));
  assert.equal(f.store.state.tasks[0].status, "completed");
});
test("失败测试不能完成；旧执行令牌不能更新任务", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const owner = f.agent(),
    id = f.task(owner);
  f.service.updatePlan(
    "目标",
    [{ executable: process.execPath, args: ["-e", "process.exit(7)"] }],
    30,
    4,
  );
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await until(() => f.store.state.tasks[0].status === "running");
  const task = f.store.state.tasks[0];
  assert.throws(
    () => f.service.report(owner, id, crypto.randomUUID(), "done", "", false),
    /过期/,
  );
  await f.service.submit(owner, id, task.runId!, "无代码修改");
  f.runtime.emit("event", { agentId: owner, type: "turn-ended" });
  const result = await f.service.verifyTask(id);
  assert.equal(result[0].status, "failed");
  assert.equal(result[0].exitCode, 7);
  assert.throws(() => f.service.review(id, true), /检查未通过/);
  await assert.rejects(() => f.service.integrate(id), /评审/);
});
test("服务重启不盲目重跑，人工接管阻止派发", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent(),
    id = f.task(a);
  await f.service.manual(a, true);
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await f.service.schedule();
  assert.equal(f.runtime.starts.length, 0);
  await f.service.manual(a, false);
  await until(() => f.runtime.starts.length === 1);
  f.service.recover();
  assert.equal(f.store.state.paused, true);
  assert.equal(f.store.state.tasks[0].status, "blocked");
  assert.equal(f.store.state.agents[0].status, "recovery");
  await f.service.schedule();
  assert.equal(f.runtime.starts.length, 1);
});

test("任务交接只排队；不得注入规划会话或绕过依赖", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent("Anti"),
    b = f.agent("Codex");
  const up = f.task(a),
    down = f.task(b, "下游", [up]);
  await f.runtime.start({
    agent: f.store.state.agents[1],
    cwd: f.repo,
    url: f.service.url,
    token: "test",
    readOnly: true,
  });
  f.runtime.emit("event", { agentId: b, type: "turn-ended" });
  f.service.approvePlan(f.store.state.project!.plan.version);
  const m = await f.service.sendTask(a, down, b);
  assert.equal(m.status, "queued");
  assert.equal(f.runtime.sent.length, 0);
  assert.equal(f.service.agentState(b).inbox.length, 0);
  await f.service.setPaused(false);
  await until(() => f.store.state.tasks[0].status === "running");
  assert.equal(f.store.state.tasks[1].status, "queued");
  assert.equal(f.runtime.sent.length, 0);
  assert.equal(f.store.state.messages[0].status, "queued");
});

test("消息唤醒占用并发席位，目标错误不会显示送达", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent("A"),
    b = f.agent("B");
  for (const id of [a, b]) {
    await f.runtime.start({
      agent: f.store.state.agents.find((x) => x.id === id)!,
      cwd: f.repo,
      url: f.service.url,
      token: "test",
      readOnly: true,
    });
    f.runtime.emit("event", { agentId: id, type: "turn-ended" });
  }
  f.store.mutate((s) => {
    s.concurrency = 1;
  });
  const result = await Promise.all([
    f.service.sendMessage("user", { targetId: a, text: "first" }),
    f.service.sendMessage("user", { targetId: b, text: "second" }),
  ]);
  assert.equal(result[0].status, "delivered");
  assert.equal(result[1].status, "queued");
  assert.equal(f.runtime.sent.length, 1);
  f.runtime.emit("event", { agentId: a, type: "turn-ended" });
  f.runtime.send = async () => {
    throw new Error("connection lost");
  };
  const failed = await f.service.sendMessage("user", {
    targetId: a,
    text: "failure",
  });
  assert.equal(failed.status, "failed");
  assert.equal(f.store.state.messages.at(-1)?.status, "failed");
});

test("同一消息链最多三轮，拒绝伪造回复关联", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent("A"),
    b = f.agent("B");
  let previous = await f.service.sendMessage(a, { targetId: b, text: "start" });
  for (let i = 1; i < 6; i++)
    previous = await f.service.sendMessage(i % 2 ? b : a, {
      targetId: i % 2 ? a : b,
      text: `round ${i}`,
      replyTo: previous.id,
    });
  await assert.rejects(
    () =>
      f.service.sendMessage(a, {
        targetId: b,
        text: "too many",
        replyTo: previous.id,
      }),
    /3 轮/,
  );
  await assert.rejects(
    () =>
      f.service.sendMessage(a, {
        targetId: b,
        text: "fake",
        replyTo: crypto.randomUUID(),
      }),
    /原消息/,
  );
});

test("冲突生成处理任务；修复、检查、整合后解除上游阻塞", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent("A"),
    b = f.agent("B");
  const first = f.task(a, "第一处修改"),
    second = f.task(b, "第二处修改");
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await until(() => f.store.state.tasks.every((t) => t.status === "running"));
  for (const [id, text] of [
    [first, "one"],
    [second, "two"],
  ]) {
    const task = f.store.state.tasks.find((t) => t.id === id)!;
    await writeFile(join(task.worktree!, "hello.txt"), text);
    await git(task.worktree!, "add", "hello.txt");
    await git(task.worktree!, "commit", "-m", text);
    await f.service.submit(task.ownerId, id, task.runId!, text);
    f.runtime.emit("event", { agentId: task.ownerId, type: "turn-ended" });
    f.service.review(id, true);
  }
  await f.service.integrate(first);
  const conflict = await f.service.integrate(second);
  assert.ok("conflict" in conflict && conflict.conflict);
  assert.equal(await readFile(join(f.repo, "hello.txt"), "utf8"), "base\n");
  assert.equal(f.store.state.paused, true);
  const fix = f.store.state.tasks.find((t) => t.resolvesTaskId === second)!;
  assert.ok(fix);
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await until(
    () =>
      f.store.state.tasks.find((t) => t.id === fix.id)!.status === "running",
  );
  await writeFile(join(fix.worktree!, "hello.txt"), "one and two\n");
  await git(fix.worktree!, "add", "hello.txt");
  await git(fix.worktree!, "commit", "-m", "resolve");
  const run = f.store.state.tasks.find((t) => t.id === fix.id)!.runId!;
  await f.service.submit(b, fix.id, run, "resolved");
  f.runtime.emit("event", { agentId: b, type: "turn-ended" });
  f.service.review(fix.id, true);
  await f.service.integrate(fix.id);
  assert.ok(f.store.state.tasks.every((t) => t.status === "completed"));
  await f.service.finalize();
  assert.equal(
    await readFile(join(f.repo, "hello.txt"), "utf8"),
    "one and two\n",
  );
});

test("作者不能自评；其他 Agent 只能评审通过独立检查的版本", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent("A"),
    b = f.agent("Reviewer"),
    id = f.task(a);
  f.service.updatePlan(
    "review",
    [{ executable: process.execPath, args: ["-e", "process.exit(0)"] }],
    30,
    4,
  );
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await until(() => f.store.state.tasks[0].status === "running");
  const task = f.store.state.tasks[0];
  await f.service.submit(a, id, task.runId!, "unchanged");
  f.runtime.emit("event", { agentId: a, type: "turn-ended" });
  const commit = f.store.state.tasks[0].commit!;
  await assert.rejects(
    () => f.service.peerReview(a, id, commit, true, "self"),
    /自己通过评审/,
  );
  await assert.rejects(
    () => f.service.peerReview(b, id, commit, true, "no checks"),
    /测试/,
  );
  await f.service.verifyTask(id);
  assert.equal(f.service.agentState(b).tests.length, 1);
  await f.service.peerReview(b, id, commit, true, "检查通过");
  assert.equal(f.store.state.tasks[0].status, "completed");
});

test("修改任务需要新批准，拒绝依赖环，取消先处理下游", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent(),
    first = f.task(a),
    second = f.task(a, "downstream", [first]);
  f.service.approvePlan(f.store.state.project!.plan.version);
  const fields = {
    title: "updated",
    description: "updated scope",
    ownerId: a,
    acceptance: "new evidence",
    dependencies: [second],
  };
  assert.throws(() => f.service.updateTask(first, fields), /循环/);
  f.service.updateTask(second, { ...fields, dependencies: [first] });
  assert.equal(f.store.state.project!.plan.approvedVersion, undefined);
  assert.equal(f.store.state.paused, true);
  assert.throws(() => f.service.cancelTask(first), /下游/);
  f.service.cancelTask(second);
  f.service.cancelTask(first);
  assert.ok(f.store.state.tasks.every((t) => t.status === "cancelled"));
});

test("修改验证命令使旧测试和评审失效", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const owner = f.agent(),
    id = f.task(owner);
  f.service.updatePlan(
    "goal",
    [{ executable: process.execPath, args: ["-e", "process.exit(0)"] }],
    30,
    4,
  );
  f.service.approvePlan(f.store.state.project!.plan.version);
  await f.service.setPaused(false);
  await until(() => f.store.state.tasks[0].status === "running");
  await f.service.submit(
    owner,
    id,
    f.store.state.tasks[0].runId!,
    "no changes",
  );
  f.runtime.emit("event", { agentId: owner, type: "turn-ended" });
  await f.service.verifyTask(id);
  f.service.review(id, true);
  f.service.updatePlan(
    "new checks",
    [{ executable: process.execPath, args: ["-e", "process.exit(1)"] }],
    30,
    4,
  );
  assert.equal(f.store.state.tasks[0].review, undefined);
  assert.equal(f.store.state.tasks[0].testIds.length, 0);
  assert.throws(() => f.service.review(id, true), /检查未通过/);
  await assert.rejects(() => f.service.integrate(id), /批准当前计划/);
});

// Completed requests revoke execution credentials while an idle native CLI can remain.
test("idle native message continuation receives fresh credentials after request completion", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = f.agent("Claude");
  f.store.mutate((s) => {
    const a = s.agents.find((a) => a.id === id)!;
    a.provider = "claude";
    a.status = "idle";
  });
  const a = f.store.state.agents.find((a) => a.id === id)!;
  const oldToken = f.service.auth.issue(id);
  await f.runtime.start({
    agent: a,
    cwd: f.repo,
    token: oldToken,
    url: f.service.url,
    readOnly: true,
  });
  f.store.mutate((s) => {
    s.agents.find((a) => a.id === id)!.status = "idle";
  });
  f.service.auth.revoke(id);
  let resumedToken: string | undefined;
  f.runtime.send = async (_id: string, _text: string, token?: string) => {
    resumedToken = token;
    return true;
  };
  const result = await f.service.sendMessage("user", {
    targetId: id,
    text: "follow up",
  });
  assert.equal(result.status, "delivered");
  assert.equal(f.service.auth.actor(oldToken), undefined);
  assert.ok(resumedToken, "resumed CLI needs fresh execution credentials");
  assert.equal(f.service.auth.actor(resumedToken!), id);
});
