import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, until } from "./helpers.ts";
import type { UserRequest, PlannedTask } from "../src/shared/types.ts";
const end = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.runtime.emit("event", { agentId: id, type: "turn-ended" });
const current = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.store.state.userRequests.find(
    (r) => r.id === f.store.state.activeRequestId,
  )!;

test("one prompt automatically plans, independently reviews analysis and returns one final answer", async () => {
  const f = await fixture();
  try {
    const coordinator = f.agent("Codex 1"),
      worker = f.agent("Antigravity 1");
    const { id } = f.service.collaboration.submit("审查项目并说明功能");
    await until(() => Boolean(current(f)?.control));
    assert.equal(current(f).status, "planning");
    const planned: PlannedTask[] = [
      {
        key: "analysis",
        title: "审查项目",
        description: "说明 hello.txt",
        acceptance: "引用文件并说明用途",
        ownerId: worker,
        dependencies: [],
        kind: "analysis",
      },
    ];
    await f.service.collaboration.publish(coordinator, 0, planned);
    end(f, coordinator);
    await until(() =>
      f.store.state.tasks.some(
        (t) => t.requestId === id && t.status === "running",
      ),
    );
    const t = f.store.state.tasks.find((t) => t.requestId === id)!;
    await f.service.submit(
      worker,
      t.id,
      t.runId!,
      "项目含 hello.txt，内容为 base",
      "hello.txt:1 提供基础文本",
    );
    end(f, worker);
    await until(() => current(f)?.control?.kind === "review");
    assert.notEqual(
      f.store.state.agents.find((a) => a.id === coordinator)!.cwd,
      t.worktree,
    );
    await f.service.collaboration.review(
      coordinator,
      t.id,
      t.base!,
      true,
      "文件依据正确",
    );
    end(f, coordinator);
    await until(() => current(f)?.control?.kind === "summary");
    f.service.collaboration.summary(
      coordinator,
      "已完成审查：项目提供基础文本。未执行自动测试。",
    );
    await f.runtime.stop(worker);
    const leftover = await f.service.sendMessage(coordinator, {
      targetId: worker,
      text: "已结束需求的晚到消息",
    });
    end(f, coordinator);
    await until(() => f.store.state.userRequests[0].status === "completed");
    assert.equal(
      f.store.state.messages.find((m) => m.id === leftover.id)!.status,
      "failed",
    );
    assert.deepEqual(f.service.agentState(worker).inbox, []);
    assert.equal(
      f.store.state.messages.find((m) => m.id === leftover.id)!.status,
      "failed",
    );
    assert.equal(
      f.store.state.chat.filter((m) => m.role === "assistant").length,
      1,
    );
    assert.deepEqual(f.store.state.userRequests[0].changedFiles, []);
    assert.equal(f.store.state.tests.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("code delivery preserves existing changes and queued request snapshots start after delivery", async () => {
  const f = await fixture();
  const { writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { git } = await import("../src/server/git.ts");
  try {
    const member = f.agent("Codex 1");
    await writeFile(join(f.repo, "hello.txt"), "user change\n");
    const first = f.service.collaboration.submit("新增 result.txt");
    const next = f.service.collaboration.submit("再审查成果");
    await until(() => Boolean(current(f)?.control));
    await f.service.collaboration.publish(member, 0, [
      {
        key: "code",
        title: "新增文件",
        description: "创建 result.txt",
        acceptance: "内容正确",
        ownerId: member,
        dependencies: [],
        kind: "code",
      },
    ]);
    end(f, member);
    await until(() => f.store.state.tasks.some((t) => t.status === "running"));
    const t = f.store.state.tasks.find((t) => t.requestId === first.id)!;
    await writeFile(join(t.worktree!, "result.txt"), "delivered\n");
    // Native workspace sandboxes may forbid Git metadata writes; platform saves the artifact.
    await f.service.submit(member, t.id, t.runId!, "新增成果文件");
    const artifact = f.store.state.tasks.find(
      (task) => task.id === t.id,
    )!.artifact!;
    assert.deepEqual(artifact.files, ["result.txt"]);
    assert.match(artifact.diff, /delivered/);
    assert.equal(artifact.truncated, false);
    end(f, member);
    await until(() => current(f)?.control?.kind === "summary");
    assert.equal(
      await readFile(join(f.repo, "result.txt"), "utf8"),
      "delivered\n",
    );
    assert.equal(
      await readFile(join(f.repo, "hello.txt"), "utf8"),
      "user change\n",
    );
    f.service.collaboration.summary(
      member,
      "已交付 result.txt。未执行自动测试，无交叉评审。",
    );
    end(f, member);
    await until(
      () =>
        f.store.state.activeRequestId === next.id &&
        Boolean(current(f)?.snapshot),
    );
    assert.equal(f.store.state.userRequests[0].status, "completed");
    assert.equal(
      await git(f.repo, "show", `${current(f).snapshot!.commit}:result.txt`),
      "delivered",
    );
  } finally {
    await f.cleanup();
  }
});

test("plans reject cycles and stale versions; cancellation and supplements preserve ownership", async () => {
  const f = await fixture();
  try {
    const a = f.agent("Codex 1"),
      b = f.agent("Codex 2");
    f.service.collaboration.submit("分析");
    await until(() => Boolean(current(f)?.control));
    const task = (key: string, dependencies: string[] = []) => ({
      key,
      title: key,
      description: "分析",
      acceptance: "依据文件",
      ownerId: b,
      dependencies,
      kind: "analysis" as const,
    });
    await assert.rejects(
      f.service.collaboration.publish(a, 0, [
        task("a", ["b"]),
        task("b", ["a"]),
      ]),
      /依赖环/,
    );
    assert.equal(current(f).version, 0);
    assert.equal(f.store.state.tasks.length, 0);
    await f.service.collaboration.publish(a, 0, [task("a"), task("b", ["a"])]);
    await assert.rejects(
      f.service.collaboration.publish(a, 0, [task("a")]),
      /版本已改变/,
    );
    await assert.rejects(
      f.service.collaboration.publish(a, 1, [task("c")], ["a"]),
      /调整下游/,
    );
    await f.service.collaboration.publish(a, 1, [task("b"), task("c")], ["a"]);
    assert.equal(
      f.store.state.tasks.find((t) => t.key === "a")!.status,
      "cancelled",
    );
    await f.service.collaboration.supplement("只解释用途");
    assert.match(current(f).answer!, /只解释用途/);
    assert.ok(
      f.runtime.sent.some((m) => m.id === a && m.text.includes("只解释用途")),
    );
    f.service.collaboration.transfer(a, b);
    assert.equal(current(f).coordinatorId, b);
    await assert.rejects(
      f.service.collaboration.publish(a, 2, [task("b")]),
      /只有当前协调者/,
    );
  } finally {
    await f.cleanup();
  }
});

test("independent test failure automatically repairs; failed evidence cannot count as completion", async () => {
  const f = await fixture();
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { git } = await import("../src/server/git.ts");
  try {
    const a = f.agent();
    await writeFile(
      join(f.repo, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"if(require('fs').readFileSync('hello.txt','utf8').trim()!=='fixed')process.exit(1)\"",
        },
      }),
    );
    f.service.collaboration.submit("修复文本");
    await until(() => Boolean(current(f)?.control));
    await f.service.collaboration.publish(a, 0, [
      {
        key: "fix",
        title: "修复",
        description: "文本正确",
        acceptance: "测试通过",
        ownerId: a,
        dependencies: [],
        kind: "code",
      },
    ]);
    end(f, a);
    await until(() => f.store.state.tasks[0]?.status === "running");
    let t = f.store.state.tasks[0];
    await writeFile(join(t.worktree!, "hello.txt"), "wrong\n");
    await git(t.worktree!, "add", "hello.txt");
    await git(t.worktree!, "commit", "-m", "attempt");
    await f.service.submit(a, t.id, t.runId!, "错误成果");
    end(f, a);
    await until(() => f.store.state.tasks[0].attempts === 2);
    assert.ok(f.store.state.tests.some((t) => t.status === "failed"));
    assert.notEqual(current(f).status, "completed");
    t = f.store.state.tasks[0];
    await until(() => f.store.state.tasks[0].status === "running");
    await writeFile(join(t.worktree!, "hello.txt"), "fixed\n");
    await git(t.worktree!, "add", "hello.txt");
    await git(t.worktree!, "commit", "-m", "repair");
    await f.service.submit(a, t.id, t.runId!, "修复成果");
    end(f, a);
    await until(() => current(f)?.control?.kind === "summary");
    assert.equal(f.store.state.tasks[0].status, "completed");
    assert.ok(
      f.store.state.tests.filter((t) => t.status === "passed").length >= 2,
    );
  } finally {
    await f.cleanup();
  }
});

test("stopped request resumes saved workspace only after explicit user action", async () => {
  const f = await fixture();
  const { writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const member = f.agent();
    const { id } = f.service.collaboration.submit("修改文本");
    await until(() => Boolean(current(f)?.control));
    await f.service.collaboration.publish(member, 0, [
      {
        key: "code",
        title: "文本",
        description: "修改",
        acceptance: "内容正确",
        ownerId: member,
        dependencies: [],
        kind: "code",
      },
    ]);
    end(f, member);
    await until(() => f.store.state.tasks[0]?.status === "running");
    const path = f.store.state.tasks[0].worktree!;
    await writeFile(join(path, "hello.txt"), "saved progress\n");
    await f.service.collaboration.stop();
    assert.equal(f.store.state.userRequests[0].status, "stopped");
    assert.equal(f.store.state.activeRequestId, undefined);
    const starts = f.runtime.starts.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(f.runtime.starts.length, starts);
    await f.service.collaboration.resume(id);
    await until(() => f.store.state.tasks[0].status === "running");
    assert.equal(f.store.state.tasks[0].worktree, path);
    assert.equal(
      await readFile(join(path, "hello.txt"), "utf8"),
      "saved progress\n",
    );
    assert.equal(await readFile(join(f.repo, "hello.txt"), "utf8"), "base\n");
  } finally {
    await f.cleanup();
  }
});

test("platform checkpoint rejects a worktree redirected to the original repository", async () => {
  const f = await fixture();
  const { writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { git } = await import("../src/server/git.ts");
  try {
    const id = f.agent("Codex 1");
    f.service.collaboration.submit("修改文件");
    await until(() => Boolean(current(f)?.control));
    await f.service.collaboration.publish(id, 0, [
      {
        key: "code",
        title: "修改",
        description: "修改 hello.txt",
        acceptance: "保留原目录",
        ownerId: id,
        dependencies: [],
        kind: "code",
      },
    ]);
    end(f, id);
    await until(() => f.store.state.tasks.some((t) => t.status === "running"));
    const t = f.store.state.tasks.find((t) => t.status === "running")!;
    const head = await git(f.repo, "rev-parse", "HEAD");
    const index = await readFile(join(f.repo, ".git/index"));
    await writeFile(
      join(t.worktree!, ".git"),
      `gitdir: ${join(f.repo, ".git")}\n`,
    );
    await writeFile(join(t.worktree!, "hello.txt"), "hostile change\n");
    await assert.rejects(
      f.service.submit(id, t.id, t.runId!, "done"),
      /工作区 Git 身份/,
    );
    assert.equal(await git(f.repo, "rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(join(f.repo, ".git/index")), index);
    assert.equal(await readFile(join(f.repo, "hello.txt"), "utf8"), "base\n");
  } finally {
    await f.cleanup();
  }
});

test("a reviewer exit preserves the checked artifact and retries another non-author", async () => {
  const f = await fixture();
  try {
    const author = f.agent("Codex 1"),
      first = f.agent("Codex 2"),
      replacement = f.agent("Codex 3");
    f.service.collaboration.submit("分析项目");
    await until(() => Boolean(current(f)?.control));
    await f.service.collaboration.publish(author, 0, [
      {
        key: "analysis",
        title: "分析",
        description: "读取文件",
        acceptance: "提供依据",
        ownerId: author,
        dependencies: [],
        kind: "analysis",
      },
    ]);
    end(f, author);
    await until(() => f.store.state.tasks.some((t) => t.status === "running"));
    const task = f.store.state.tasks.find((t) => t.status === "running")!;
    await f.service.submit(
      author,
      task.id,
      task.runId!,
      "基础文本",
      "hello.txt:1",
    );
    end(f, author);
    await until(() => current(f)?.control?.kind === "review");
    assert.equal(current(f).control!.agentId, first);
    await f.service.stopAgent(first, "native session exited");
    await until(() => current(f)?.control?.agentId === replacement);
    assert.equal(
      f.store.state.tasks.find((t) => t.id === task.id)!.checked,
      true,
    );
    assert.equal(
      f.store.state.tasks.find((t) => t.id === task.id)!.reviewRounds,
      2,
    );
    assert.equal(current(f).status, "running");
  } finally {
    await f.cleanup();
  }
});

test("dependency replanning creates a distinct branch and checkpoints literal filenames", async () => {
  const f = await fixture();
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { git } = await import("../src/server/git.ts");
  try {
    const key = crypto.randomUUID();
    const first = await f.service.work.taskWorkspace(
      f.store.state.project!,
      `${key}-v1`,
    );
    const next = await f.service.work.taskWorkspace(
      f.store.state.project!,
      `${key}-v2`,
    );
    assert.notEqual(first.branch, next.branch);
    const name = " leading [literal].txt";
    await writeFile(join(next.worktree, name), "version 2\n");
    const task = {
      ...f.store.state.tasks[0],
      ...next,
      id: key,
    } as import("../src/shared/types.ts").Task;
    await f.service.work.checkpointTask(task);
    assert.equal(await git(next.worktree, "show", `HEAD:${name}`), "version 2");
    assert.equal(await git(first.worktree, "rev-parse", "HEAD"), first.base);
  } finally {
    await f.cleanup();
  }
});

test("communication uses the same execution deadline and stops after three delivery attempts", async () => {
  const f = await fixture();
  try {
    const coordinator = f.agent("Codex 1"),
      member = f.agent("Codex 2");
    f.service.collaboration.submit("分析项目");
    await until(() => Boolean(current(f)?.control));
    await f.runtime.start({
      agent: f.store.state.agents.find((a) => a.id === member)!,
      cwd: f.repo,
      url: f.service.url,
      token: "fixture",
      readOnly: true,
    });
    end(f, member);
    f.runtime.send = async (id) => {
      // Native CLI resume stops the old process before starting the same conversation.
      f.runtime.emit("event", { agentId: id, type: "exit" });
      f.runtime.emit("event", { agentId: id, type: "started" });
      return true;
    };
    const message = await f.service.sendMessage(coordinator, {
      targetId: member,
      text: "讨论分工",
    });
    await until(() =>
      Boolean(f.store.state.agents.find((a) => a.id === member)?.messageTurn),
    );
    f.store.mutate((s) => {
      s.agents.find((a) => a.id === member)!.messageTurn!.startedAt = new Date(
        Date.now() - 31 * 60000,
      ).toISOString();
      s.messages.find((m) => m.id === message.id)!.deliveryAttempts = 3;
    });
    await until(
      () =>
        f.store.state.messages.find((m) => m.id === message.id)?.status ===
        "failed",
    );
    assert.equal(
      f.store.state.agents.find((a) => a.id === member)!.status,
      "stopped",
    );
    assert.equal(
      f.store.state.agents.find((a) => a.id === member)!.messageTurn,
      undefined,
    );
    assert.equal(current(f).control!.agentId, coordinator);
  } finally {
    await f.cleanup();
  }
});

test("reassignment waits for an in-flight artifact save before switching the owner", async () => {
  const f = await fixture();
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { git } = await import("../src/server/git.ts");
  let release!: () => void;
  try {
    const author = f.agent("Codex 1"),
      replacement = f.agent("Codex 2");
    f.service.collaboration.submit("修改文本");
    await until(() => Boolean(current(f)?.control));
    const plan: PlannedTask = {
      key: "code",
      title: "修改",
      description: "保存成果",
      acceptance: "文件正确",
      ownerId: author,
      dependencies: [],
      kind: "code",
    };
    await f.service.collaboration.publish(author, 0, [plan]);
    end(f, author);
    await until(() => f.store.state.tasks.some((t) => t.status === "running"));
    const task = f.store.state.tasks[0];
    await writeFile(
      join(task.worktree!, "result.txt"),
      "saved before transfer\n",
    );
    const checkpoint = f.service.work.checkpointTask.bind(f.service.work);
    let entered = false;
    const gate = new Promise<void>((r) => (release = r));
    f.service.work.checkpointTask = async (t) => {
      entered = true;
      await gate;
      await checkpoint(t);
    };
    const saving = f.service
      .submit(author, task.id, task.runId!, "成果")
      .catch(() => undefined);
    await until(() => entered);
    let changed = false;
    const transfer = f.service.collaboration
      .publish(author, 1, [{ ...plan, ownerId: replacement }])
      .then(() => {
        changed = true;
      });
    await until(() => !f.runtime.has(author));
    assert.equal(changed, false);
    assert.equal(f.store.state.tasks[0].ownerId, author);
    release();
    await saving;
    await transfer;
    assert.equal(f.store.state.tasks[0].ownerId, replacement);
    assert.equal(
      await git(task.worktree!, "show", "HEAD:result.txt"),
      "saved before transfer",
    );
  } finally {
    release?.();
    await f.cleanup();
  }
});
