import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, Task, CommandSpec, TestRun } from "../shared/types.ts";
import { now } from "../shared/types.ts";
import { ensure, redact } from "./store.ts";
const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  const result = await exec(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_MERGE_AUTOEDIT: "no",
        // Read-only status/diff checks must not refresh the user's index on disk.
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
  return args.some((arg) => arg === "-z" || arg === "-rz")
    ? result.stdout
    : result.stdout.trim();
}
export class GitService {
  constructor(public dataDir: string) {}
  async inspect(path: string) {
    const canonical = await realpath(path);
    const root = await git(canonical, "rev-parse", "--show-toplevel");
    const base = await git(root, "rev-parse", "--verify", "HEAD");
    const branch = await git(root, "branch", "--show-current");
    const dirty = await git(root, "status", "--porcelain");
    return { root, base, branch, dirty: Boolean(dirty) };
  }
  async createProject(path: string, goal: string): Promise<Project> {
    const info = await this.inspect(path);
    const id = randomUUID();
    const integrationPath = join(this.dataDir, "workspaces", id, "integration");
    const integrationBranch = `codex/relay-${id.slice(0, 8)}`;
    await mkdir(join(this.dataDir, "workspaces", id), { recursive: true });
    await git(
      info.root,
      "worktree",
      "add",
      "-b",
      integrationBranch,
      integrationPath,
      info.base,
    );
    return {
      id,
      name: info.root.split("/").at(-1)!,
      root: info.root,
      base: info.base,
      branch: info.branch,
      integrationPath,
      integrationBranch,
      integratedHead: info.base,
      dirtyOriginal: info.dirty,
      plan: { version: 1, goal, checks: [], maxMinutes: 30, retryLimit: 3 },
      createdAt: now(),
    };
  }
  async taskWorkspace(project: Project, taskId: string) {
    const path = join(this.dataDir, "workspaces", project.id, `task-${taskId}`);
    const branch = `codex/relay-${project.id.slice(0, 8)}-${taskId}`;
    await git(
      project.root,
      "worktree",
      "add",
      "-b",
      branch,
      path,
      project.integratedHead,
    );
    return {
      worktree: path,
      branch,
      base: project.integratedHead,
      gitDir: await realpath(
        await git(path, "rev-parse", "--absolute-git-dir"),
      ),
    };
  }
  async planningWorkspace(project: Project, agentId: string) {
    const path = join(
      this.dataDir,
      "workspaces",
      project.id,
      `agent-${agentId}-${project.integratedHead.slice(0, 12)}`,
    );
    try {
      await git(path, "rev-parse", "--verify", "HEAD");
      return path;
    } catch {}
    await git(
      project.root,
      "worktree",
      "add",
      "--detach",
      path,
      project.integratedHead,
    );
    return path;
  }
  async checkpointTask(task: Task) {
    ensure(task.worktree && task.base, "NO_WORKTREE", "任务没有工作副本");
    ensure(
      task.gitDir && task.branch,
      "WORKTREE_IDENTITY",
      "工作区缺少原始 Git 身份记录，不能自动保存成果",
    );
    const actualDir = await git(
      task.worktree,
      "rev-parse",
      "--absolute-git-dir",
    );
    ensure(
      (await realpath(actualDir)) === task.gitDir &&
        (await git(task.worktree, "branch", "--show-current")) === task.branch,
      "WORKTREE_IDENTITY",
      "工作区 Git 身份或分支已改变，不能自动保存成果",
    );
    const taskGit = (...args: string[]) =>
      git(
        task.worktree!,
        `--git-dir=${task.gitDir}`,
        `--work-tree=${task.worktree}`,
        ...args,
      );
    await taskGit("merge-base", "--is-ancestor", task.base, "HEAD");
    const paths = (
      await taskGit(
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      )
    )
      .split("\0")
      .filter(Boolean);
    const forbidden = (path: string) =>
      /(^|\/)(node_modules|\.local|\.env(?:\..*)?|credentials\.json|id_rsa|id_ed25519)(\/|$)/.test(
        path,
      ) || path === ".agents/hooks.json";
    const staged = (await taskGit("diff", "--cached", "--name-only", "-z"))
      .split("\0")
      .filter(Boolean);
    ensure(
      !staged.some(forbidden),
      "SENSITIVE_FILE",
      "成果暂存区包含敏感或生成文件，请先移除",
    );
    const files = paths.filter((path) => !forbidden(path));
    for (let i = 0; i < files.length; i += 100)
      await taskGit(
        "--literal-pathspecs",
        "add",
        "-A",
        "--",
        ...files.slice(i, i + 100),
      );
    if (await taskGit("diff", "--cached", "--name-only"))
      await taskGit(
        "-c",
        "user.name=Relay",
        "-c",
        "user.email=relay@localhost",
        "commit",
        "-m",
        `Relay task ${task.id}`,
      );
  }
  async verifyArtifact(task: Task) {
    ensure(task.worktree && task.base, "NO_WORKTREE", "任务没有工作副本");
    const commit = await git(task.worktree, "rev-parse", "HEAD");
    await git(task.worktree, "merge-base", "--is-ancestor", task.base, commit);
    const dirty = await git(
      task.worktree,
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--",
      ".",
      ":(exclude).agents/hooks.json",
    );
    ensure(!dirty, "DIRTY_WORKTREE", "请先提交任务工作区的修改，再提交成果");
    const files = (
      await git(task.worktree, "diff", "--name-only", `${task.base}..${commit}`)
    )
      .split("\n")
      .filter(Boolean);
    ensure(
      !files.includes(".agents/hooks.json"),
      "GENERATED_CONFIG",
      "请勿提交 Relay 生成的 Hook 配置",
    );
    ensure(
      !files.some((f) =>
        /(^|\/)(node_modules|\.local|\.env(?:\..*)?|id_rsa|id_ed25519|credentials\.json)(\/|$)/.test(
          f,
        ),
      ),
      "SENSITIVE_FILE",
      "成果包含敏感配置文件，需先移除",
    );
    const diff = await git(task.worktree, "diff", task.base, commit);
    return {
      commit,
      files,
      diff: diff.slice(0, 32000),
      truncated: diff.length > 32000,
    };
  }
  async candidate(project: Project, task: Task) {
    ensure(task.commit, "NO_COMMIT", "缺少成果版本");
    const id = randomUUID().slice(0, 8);
    const path = join(this.dataDir, "workspaces", project.id, `merge-${id}`);
    const branch = `codex/relay-${project.id.slice(0, 8)}-merge-${id}`;
    await git(
      project.root,
      "worktree",
      "add",
      "-b",
      branch,
      path,
      project.integratedHead,
    );
    const gitDir = await realpath(
      await git(path, "rev-parse", "--absolute-git-dir"),
    );
    try {
      await git(
        path,
        "-c",
        "user.name=Relay",
        "-c",
        "user.email=relay@localhost",
        "merge",
        "--no-ff",
        "--no-edit",
        task.commit,
      );
      return {
        path,
        branch,
        gitDir,
        commit: await git(path, "rev-parse", "HEAD"),
        conflict: false,
      };
    } catch (error) {
      const files = await git(path, "diff", "--name-only", "--diff-filter=U");
      if (!files) throw error;
      return { path, branch, gitDir, commit: "", conflict: true, files };
    }
  }
  async advance(project: Project, candidateCommit: string) {
    ensure(
      (await git(project.integrationPath, "rev-parse", "HEAD")) ===
        project.integratedHead,
      "INTEGRATION_CHANGED",
      "集成分支被外部修改，需要检查",
    );
    ensure(
      !(await git(project.integrationPath, "status", "--porcelain")),
      "INTEGRATION_DIRTY",
      "集成工作区有额外改动",
    );
    await git(project.integrationPath, "merge", "--ff-only", candidateCommit);
  }
  async finalize(project: Project) {
    const current = await this.inspect(project.root);
    ensure(!current.dirty, "ORIGINAL_DIRTY", "原始目录有未提交改动，不能合入");
    ensure(
      current.base === project.base && current.branch === project.branch,
      "ORIGINAL_CHANGED",
      "原始分支已经变化，请人工检查并合并",
    );
    await git(project.root, "merge", "--ff-only", project.integratedHead);
  }
}

export async function runCheck(
  taskId: string,
  commit: string,
  cwd: string,
  command: CommandSpec,
  scope: TestRun["scope"],
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<TestRun> {
  const record: TestRun = {
    id: randomUUID(),
    taskId,
    commit,
    cwd,
    command,
    scope,
    startedAt: now(),
    log: "",
    status: "running",
  };
  await new Promise<void>((resolve) => {
    let finished = false;
    const child = spawn(command.executable, command.args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk: Buffer) => {
      record.log = (record.log + redact(chunk.toString())).slice(-150_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      record.log += "\n测试超时，已停止。";
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    const abort = () => {
      record.log += "\n用户停止验证。";
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    function finish(code: number | null, error?: string) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      record.exitCode = code;
      record.endedAt = now();
      record.status =
        code === 0 && !error && !signal?.aborted ? "passed" : "failed";
      signal?.removeEventListener("abort", abort);
      if (error) record.log += redact(error);
      resolve();
    }
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
  return record;
}
