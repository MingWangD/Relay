/** Opt-in real model test. Creates its own Git fixture; never edits the user's project. */
import { mkdir, writeFile, readFile, lstat, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { GitService, git } from "../src/server/git.ts";
import { Store } from "../src/server/store.ts";
import { Auth } from "../src/server/auth.ts";
import type { Provider } from "../src/shared/types.ts";
import { NativeRuntime } from "../src/server/runtime.ts";
import { Service } from "../src/server/service.ts";
import { createHttp } from "../src/server/http.ts";

if (!process.argv.includes("--inference"))
  throw new Error("This test calls real models. Pass --inference to run.");
const taskMode = process.argv.includes("--task");
const resumeAt = process.argv.indexOf("--resume-dir");
const resumeDir = resumeAt >= 0 ? process.argv[resumeAt + 1] : undefined;
const followup = process.argv.includes("--followup");
if (followup && !resumeDir) throw Error("--followup requires --resume-dir");
if (resumeDir && !/^\.local\/request-\d+$/.test(resumeDir))
  throw Error("Resume is limited to isolated request fixtures");
const root = resumeDir
  ? resolve(resumeDir)
  : resolve(".local", `request-${Date.now()}`);
const repo = join(root, "repo");
if (!resumeDir) {
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Relay Smoke");
  await git(repo, "config", "user.email", "relay@localhost");
  await writeFile(
    join(repo, "README.md"),
    "# Isolated native collaboration test\n",
  );
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "fixture");
}
const store = new Store(join(root, "state.sqlite"));
const auth = new Auth(root);
const runtime = new NativeRuntime(root);
const service = new Service(
  store,
  auth,
  new GitService(root),
  runtime,
  taskMode,
);
const http = await createHttp(service, { port: 0, root: resolve(".") });
if (!store.state.project)
  await service.createProject(
    repo,
    taskMode
      ? "验证真实派单、代码提交、独立测试与跨 Agent 评审。仅允许修改隔离测试工作区。"
      : "验证 Anti 发信、Codex 原生会话接收并回复、Anti 确认。禁止执行 shell 或修改文件。",
  );
const codex =
  store.state.agents.find((a) => a.provider === "codex")?.id ??
  (await service.addAgent("Codex 1", "codex", "团队成员")).id;
const anti =
  store.state.agents.find((a) => a.provider === "antigravity")?.id ??
  (await service.addAgent("Antigravity 1", "antigravity", "团队成员")).id;
// Explicit settings apply only to these isolated Relay sessions.
if (!resumeDir) {
  const team = process.argv
    .find((x) => x.startsWith("--team="))
    ?.slice(7)
    .split(",") as Provider[] | undefined;
  if (team) {
    if (team.some((p) => !["codex", "antigravity", "claude"].includes(p)))
      throw new Error("Unknown provider");
    await service.collaboration.configureTeam({
      members: team.map((provider) => ({ provider })),
      permissionMode: process.argv.includes("--native") ? "native" : "full",
    });
  } else
    store.mutate((s) => {
      s.permissionMode = process.argv.includes("--native") ? "native" : "full";
      for (const a of s.agents) a.permissionMode = s.permissionMode;
    });
}
if (!resumeDir)
  store.mutate((s) => {
    for (const a of s.agents) {
      a.model = process.argv
        .find((x) => x.startsWith(`--model-${a.provider}=`))
        ?.split("=")[1];
      a.reasoningEffort = process.argv
        .find((x) => x.startsWith(`--effort-${a.provider}=`))
        ?.split("=")[1] as typeof a.reasoningEffort;
    }
  });
const outputs = new Map<string, string>();
const outputTimer = setInterval(() => {
  for (const [id, output] of outputs)
    void writeFile(join(root, `${id}.terminal.txt`), output);
}, 2000);
const trusted = new Set<string>();
const approvals = new Map<string, string>();
const events: unknown[] = [];
runtime.on("terminal", (p) => {
  const value = ((outputs.get(p.agentId) ?? "") + p.data).slice(-300_000);
  outputs.set(p.agentId, value);
  const screen = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s/g, "")
    .toLowerCase();
  if (
    store.state.agents.find((a) => a.id === p.agentId)?.provider === "claude" &&
    !trusted.has(p.agentId) &&
    screen.includes("isthisaprojectyoucreatedoroneyoutrust")
  ) {
    trusted.add(p.agentId);
    setTimeout(() => runtime.write(p.agentId, "\x1b[B\r"), 200);
  }
  if (
    !trusted.has(p.agentId) &&
    (screen.includes("trustthisfolder?") ||
      screen.includes("doyoutrustthecontentsofthisproject?"))
  ) {
    trusted.add(p.agentId);
    setTimeout(() => runtime.write(p.agentId, "\r"), 200);
  }
  const fileAt = screen.lastIndexOf("allowaccesstothisfile?");
  const readAt = screen.slice(0, fileAt).lastIndexOf("read:");
  const file = screen.slice(readAt + 5, fileAt);
  const fileSignature = `file:${fileAt}`;
  if (
    p.agentId === anti &&
    fileAt >= 0 &&
    readAt >= 0 &&
    file.startsWith(root.toLowerCase() + "/workspaces/") &&
    /\/(check\.cjs|package\.json|readme\.md|native-result\.txt)$/.test(file) &&
    approvals.get(p.agentId) !== fileSignature
  ) {
    approvals.set(p.agentId, fileSignature);
    setTimeout(() => runtime.write(p.agentId, "\r"), 200);
  }
  const commandAt = screen.lastIndexOf("runthiscommand?");
  const prefix = screen.slice(0, commandAt);
  const commandStart = prefix.lastIndexOf("requestingpermissionfor:");
  const command = prefix.slice(
    commandStart + "requestingpermissionfor:".length,
  );
  const reads = new Set([
    "ls",
    "ls-la",
    "pwd",
    "catreadme.md",
    "catpackage.json",
    "catcheck.cjs",
    "nl-bacheck.cjs",
    "gitstatus--short",
    "npmruntest",
    "catnative-result.txt|wc-c&&xxdnative-result.txt",
    "gitstatus--short--untracked-files=all&&gitdiff--exit-code",
    "gitdiff--stat",
    "gitstatus;gitdiffhead;catcheck.cjs",
    "ls-la&&catcheck.cjspackage.jsonreadme.md&&gitstatus",
    "nodecheck.cjs",
    "gitlog-n3--oneline&&gitstatus",
    "gitstatus--short--untracked-files=all",
    "gitdiff--exit-code",
  ]);
  const knownPaths = [
    ...store.state.tasks.map((t) => t.worktree),
    ...store.state.agents.map((a) => a.cwd),
  ].filter((path): path is string =>
    Boolean(path?.startsWith(root + "/workspaces/")),
  );
  const knownReads = knownPaths.flatMap((path) =>
    ["ls", "ls -la"].map((cmd) =>
      (cmd + path).replace(/\s/g, "").toLowerCase(),
    ),
  );
  const brainPrefix =
    "grep-iartifact" +
    homedir().toLowerCase() +
    "/.gemini/antigravity-cli/brain/" +
    store.state.agents.find((a) => a.id === p.agentId)?.sessionId +
    "/.system_generated/steps/";
  const brainRead =
    command.startsWith(brainPrefix) &&
    /^\d+\/output\.txt$/.test(command.slice(brainPrefix.length));
  const commandSignature = `command:${commandAt}`;
  if (
    p.agentId === anti &&
    commandAt >= 0 &&
    commandStart >= 0 &&
    (brainRead ||
      reads.has(command) ||
      knownReads.includes(command) ||
      (/^gitshow[0-9a-f]{7,40}$/.test(command) &&
        store.state.tasks.some((t) =>
          t.commit?.startsWith(command.slice(7)),
        ))) &&
    approvals.get(p.agentId) !== commandSignature
  ) {
    approvals.set(p.agentId, commandSignature);
    setTimeout(() => runtime.write(p.agentId, "\r"), 200);
  }
  // Only approve these explicitly requested communication tools in this fixture.
  const tail = screen.slice(-7000);
  const position = tail.lastIndexOf("allowcallingthistool?");
  if (p.agentId === anti && position >= 0) {
    const context = tail.slice(Math.max(0, position - 3000), position);
    const allowed =
      /relay\/(send_message|ack_message|get_project_state|send_task|report_progress|submit_result|review_result|publish_plan|transfer_coordinator|ask_user|complete_request)/.test(
        context,
      );
    const signature = String(screen.lastIndexOf("allowcallingthistool?"));
    const afterPrompt = tail.slice(position);
    if (
      allowed &&
      !afterPrompt.includes("callingmcptool") &&
      approvals.get(p.agentId) !== signature
    ) {
      approvals.set(p.agentId, signature);
      setTimeout(() => runtime.write(p.agentId, "\r"), 250);
    }
  }
});
runtime.on("event", (e) => {
  if (e.type === "connected") {
    approvals.delete(e.agentId);
    trusted.delete(e.agentId);
    const previous = outputs.get(e.agentId);
    if (previous)
      void writeFile(
        join(root, `${e.agentId}-${events.length}.terminal.txt`),
        previous,
      );
    outputs.set(e.agentId, "");
  }
  events.push(e);
  console.log(
    JSON.stringify({
      agentId: e.agentId,
      type: e.type,
      sessionId: e.sessionId,
    }),
  );
  if (
    e.type === "approval" &&
    e.request?.method === "mcpServer/elicitation/request" &&
    /"(send_message|ack_message|get_project_state|send_task|report_progress|submit_result|review_result|publish_plan|transfer_coordinator|ask_user|complete_request)"/.test(
      e.request.params?.message ?? "",
    )
  )
    service.approveRequest(e.request.id, true);
  if (
    taskMode &&
    e.type === "approval" &&
    e.request?.method === "item/commandExecution/requestApproval"
  ) {
    const params = e.request.params;
    const workspace = store.state.tasks.find(
      (t) => t.ownerId === e.agentId && t.status === "running",
    )?.worktree;
    const command = String(params.command ?? "").replace(
      /^\/bin\/(?:zsh|bash|sh) -lc (["'])(.*)\1$/,
      "$2",
    );
    const safe =
      params.cwd === workspace &&
      typeof params.command === "string" &&
      /^git (?:add native-result\.txt|commit -m [\w '"-]+|status(?: --short)?|diff(?: --stat)?)(?: && git commit -m [\w '"-]+)?$/.test(
        command,
      );
    if (safe) service.approveRequest(e.request.id, true);
    else
      console.log(
        JSON.stringify({
          approvalNeedsReview: true,
          method: e.request.method,
          command: params.command,
          cwd: params.cwd,
        }),
      );
  }
});
try {
  if (!resumeDir) {
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "node check.cjs" } }),
    );
    await writeFile(
      join(repo, "check.cjs"),
      "const fs=require('fs');if(fs.readFileSync('native-result.txt','utf8')!=='relay native task ok\\n') process.exit(1)\n",
    );
  }
  const originalHead = await git(repo, "rev-parse", "HEAD");
  const { id } =
    resumeDir && !followup
      ? { id: store.state.activeRequestId! }
      : service.collaboration.submit(
          taskMode
            ? "仅创建 native-result.txt，内容精确为 relay native task ok 加换行。团队自行协商分工，必须让另一成员交叉评审，自动测试并回写。完成后直接 submit_result，由平台保存隔离分支版本，无需手动 Git 提交。不得修改其他文件，不推送。"
            : "审查当前项目并说明每个文件功能，只分析，不修改任何业务文件。两位成员协商分工并交叉评审。必须通过 send_message 交流一次并 ack_message 确认，不循环等待。最后给出中文报告。分析结果通过 submit_result 提交 summary 和 evidence。",
        );
  if (resumeDir && !followup) {
    service.recover();
    await service.collaboration.resume();
  }
  const deadline =
    Date.now() +
    Number(
      process.argv.find((x) => x.startsWith("--timeout="))?.slice(10) ?? 600000,
    );
  let passed = false;
  let audit: unknown;
  while (Date.now() < deadline) {
    const request = store.state.userRequests.find((r) => r.id === id)!;
    if (request.status === "completed") {
      let inputUnchanged = Boolean(request.snapshot);
      for (const [file, expected] of Object.entries(
        request.snapshot?.fingerprints ?? {},
      )) {
        try {
          const path = join(repo, file),
            stat = await lstat(path);
          const mode = stat.isSymbolicLink()
            ? "120000"
            : stat.mode & 0o111
              ? "100755"
              : "100644";
          const bytes = stat.isSymbolicLink()
            ? Buffer.from(await readlink(path))
            : await readFile(path);
          inputUnchanged &&=
            createHash("sha256")
              .update(mode)
              .update("\0")
              .update(bytes)
              .digest("hex") === expected;
        } catch {
          inputUnchanged = false;
        }
      }
      const originalIndexUnchanged = !(await git(
        repo,
        "diff",
        "--cached",
        "--name-only",
      ));
      const currentFiles = (
        await git(
          repo,
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        )
      )
        .split("\0")
        .filter(Boolean);
      const addedFiles = currentFiles.filter(
        (file) => !(file in (request.snapshot?.fingerprints ?? {})),
      );
      let exactResult = !taskMode;
      if (taskMode)
        try {
          exactResult = (
            await readFile(join(repo, "native-result.txt"))
          ).equals(Buffer.from("relay native task ok\n"));
        } catch {}
      audit = {
        inputUnchanged,
        originalIndexUnchanged,
        addedFiles,
        exactResult,
      };
      passed =
        inputUnchanged &&
        originalIndexUnchanged &&
        exactResult &&
        (taskMode
          ? addedFiles.length === 1 && addedFiles[0] === "native-result.txt"
          : !addedFiles.length) &&
        (await git(repo, "rev-parse", "HEAD")) === originalHead &&
        (taskMode
          ? Boolean(
              request.delivered &&
              request.changedFiles?.includes("native-result.txt") &&
              store.state.tests.length &&
              store.state.tests.every((t) => t.status === "passed"),
            )
          : Boolean(request.summary && !request.changedFiles?.length));
      break;
    }
    if (request.status === "waiting" && request.error) {
      console.log(JSON.stringify({ blocked: request.error }));
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const nativeSessions = store.state.agents.map((a) => ({
    provider: a.provider,
    id: a.id,
    boundSessionId: a.boundSessionId,
    cwd: a.sessionCwd,
    observedIds: [
      ...new Set(
        events
          .filter((e: any) => e.agentId === a.id && e.sessionId)
          .map((e: any) => e.sessionId),
      ),
    ],
    launches: events.filter(
      (e: any) => e.agentId === a.id && e.type === "connected",
    ).length,
  }));
  passed &&= nativeSessions.every(
    (a) =>
      a.observedIds.length <= 1 &&
      a.observedIds.every((id) => id === a.boundSessionId),
  );
  const evidence = {
    nativeSessions,
    passed,
    audit,
    versions: store.state.agents.map((a) => ({
      provider: a.provider,
      permissionMode: a.permissionMode,
      model: a.model,
      effort: a.reasoningEffort,
      effectiveModel: a.effectiveModel,
      version: a.probe?.version,
      sessionId: a.sessionId,
    })),
    userRequests: store.state.userRequests,
    chat: store.state.chat,
    tasks: store.state.tasks,
    tests: store.state.tests,
    messages: store.state.messages,
    events,
    requests: Object.keys(store.state.requests).length,
  };
  await writeFile(
    join(root, resumeDir ? "continuation-evidence.json" : "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  for (const [id, output] of outputs)
    await writeFile(join(root, `${id}.terminal.txt`), output);
  console.log(
    JSON.stringify({
      passed,
      evidence: root,
      messages: evidence.messages.map((m) => ({
        sourceId: m.sourceId,
        targetId: m.targetId,
        status: m.status,
      })),
      requests: evidence.requests,
    }),
  );
  if (!passed) process.exitCode = 1;
} finally {
  clearInterval(outputTimer);
  for (const [id, output] of outputs)
    await writeFile(join(root, `${id}.terminal.txt`), output);
  console.log(`Evidence directory: ${root}`);
  await service.stopAll();
  await http.close();
  store.close();
}
