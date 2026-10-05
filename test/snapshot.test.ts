import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.ts";
import { git, GitService } from "../src/server/git.ts";
import { captureSnapshot, writeBack } from "../src/server/snapshot.ts";

test("read-only project inspection preserves index bytes after a clean file timestamp changes", async () => {
  const f = await fixture();
  try {
    const index = await readFile(join(f.repo, ".git/index"));
    const older = new Date(Date.now() - 120000);
    await utimes(join(f.repo, "hello.txt"), older, older);
    const info = await new GitService(f.data).inspect(f.repo);
    assert.equal(info.dirty, false);
    assert.deepEqual(await readFile(join(f.repo, ".git/index")), index);
  } finally {
    await f.cleanup();
  }
});

test("snapshot includes current files, preserves index; delivery writes only new delta", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, "hello.txt"), "staged\n");
    await git(f.repo, "add", "hello.txt");
    await writeFile(join(f.repo, "hello.txt"), "current\n");
    await writeFile(join(f.repo, "new.txt"), "untracked\n");
    const index = await git(f.repo, "diff", "--cached");
    const snap = await captureSnapshot(f.repo, f.data, crypto.randomUUID());
    assert.equal(
      await git(f.repo, "show", `${snap.commit}:hello.txt`),
      "current",
    );
    assert.equal(
      await git(f.repo, "show", `${snap.commit}:new.txt`),
      "untracked",
    );
    assert.equal(await git(f.repo, "diff", "--cached"), index);
    const ws = join(f.root, "result");
    await git(f.repo, "worktree", "add", "--detach", ws, snap.commit);
    await writeFile(join(ws, "hello.txt"), "current\nagent change\n");
    await git(ws, "add", "hello.txt");
    await git(ws, "commit", "-m", "result");
    await writeBack(snap, await git(ws, "rev-parse", "HEAD"), f.data);
    assert.equal(
      await readFile(join(f.repo, "hello.txt"), "utf8"),
      "current\nagent change\n",
    );
    assert.equal(
      await readFile(join(f.repo, "new.txt"), "utf8"),
      "untracked\n",
    );
    assert.equal(await git(f.repo, "diff", "--cached"), index);
    assert.equal(await git(f.repo, "rev-parse", "HEAD"), snap.head);
  } finally {
    await f.cleanup();
  }
});

test("writeback rejects concurrent edits and new path collisions without partial writes", async () => {
  const f = await fixture();
  try {
    const snap = await captureSnapshot(f.repo, f.data, crypto.randomUUID());
    const ws = join(f.root, "result");
    await git(f.repo, "worktree", "add", "--detach", ws, snap.commit);
    await writeFile(join(ws, "hello.txt"), "agent\n");
    await writeFile(join(ws, "new.txt"), "agent\n");
    await git(ws, "add", ".");
    await git(ws, "commit", "-m", "result");
    const commit = await git(ws, "rev-parse", "HEAD");
    await writeFile(join(f.repo, "new.txt"), "user file\n");
    await assert.rejects(writeBack(snap, commit, f.data), /不会覆盖人工修改/);
    assert.equal(await readFile(join(f.repo, "hello.txt"), "utf8"), "base\n");
    assert.equal(
      await readFile(join(f.repo, "new.txt"), "utf8"),
      "user file\n",
    );
  } finally {
    await f.cleanup();
  }
});

test("snapshot excludes credentials; file deletion and failed write rollback preserve original index", async () => {
  const f = await fixture();
  const { mkdir, rm } = await import("node:fs/promises");
  try {
    await writeFile(join(f.repo, ".env"), "SECRET=private");
    await writeFile(join(f.repo, "delete.txt"), "delete me");
    const snap = await captureSnapshot(f.repo, f.data, crypto.randomUUID());
    await assert.rejects(git(f.repo, "show", `${snap.commit}:.env`));
    const ws = join(f.root, "result");
    await git(f.repo, "worktree", "add", "--detach", ws, snap.commit);
    await rm(join(ws, "delete.txt"));
    await writeFile(join(ws, "hello.txt"), "agent");
    await git(ws, "add", ".");
    await git(ws, "commit", "-m", "result");
    const commit = await git(ws, "rev-parse", "HEAD");
    // Force an actual filesystem write failure after the first (deletion) succeeds.
    const temp = join(f.repo, `hello.txt.relay-${snap.id}.tmp`);
    await mkdir(temp);
    await assert.rejects(writeBack(snap, commit, f.data));
    assert.equal(
      await readFile(join(f.repo, "delete.txt"), "utf8"),
      "delete me",
    );
    assert.equal(await readFile(join(f.repo, "hello.txt"), "utf8"), "base\n");
    await rm(temp, { recursive: true });
    await writeBack(snap, commit, f.data);
    await assert.rejects(readFile(join(f.repo, "delete.txt")));
    assert.equal(
      await readFile(join(f.repo, ".env"), "utf8"),
      "SECRET=private",
    );
    assert.equal(await git(f.repo, "rev-parse", "HEAD"), snap.head);
    // Replaying delivery after a lost state update does not reapply or duplicate it.
    assert.deepEqual(await writeBack(snap, commit, f.data), [
      "delete.txt",
      "hello.txt",
    ]);
    const journalPath = join(f.data, "delivery", snap.id, "journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    await writeFile(
      journalPath,
      JSON.stringify({ ...journal, status: "prepared" }),
    );
    await writeBack(snap, commit, f.data);
    assert.equal(await readFile(join(f.repo, "hello.txt"), "utf8"), "agent");
  } finally {
    await f.cleanup();
  }
});

test("in-project Relay storage with a dot-dot-prefixed name stays out of the snapshot", async () => {
  const f = await fixture();
  const { mkdir } = await import("node:fs/promises");
  try {
    const data = join(f.repo, "..relay-data");
    await mkdir(data);
    await writeFile(join(data, "console-token"), "fixture-private-token");
    const snapshot = await captureSnapshot(f.repo, data, crypto.randomUUID());
    const files = await git(
      f.repo,
      "ls-tree",
      "-rz",
      "--name-only",
      snapshot.commit,
    );
    assert.equal(files.includes("..relay-data/"), false);
    assert.equal(files.includes("console-token"), false);
    assert.equal(
      await readFile(join(data, "console-token"), "utf8"),
      "fixture-private-token",
    );
  } finally {
    await f.cleanup();
  }
});

test("even an Agent-created commit cannot write excluded dependencies or Relay data back", async () => {
  const f = await fixture();
  const { mkdir } = await import("node:fs/promises");
  try {
    const snapshot = await captureSnapshot(f.repo, f.data, crypto.randomUUID());
    const ws = join(f.root, "result");
    await git(f.repo, "worktree", "add", "--detach", ws, snapshot.commit);
    await mkdir(join(ws, "node_modules/dependency"), { recursive: true });
    await writeFile(
      join(ws, "node_modules/dependency/private.txt"),
      "must stay isolated",
    );
    await writeFile(join(ws, "hello.txt"), "agent\n");
    await git(ws, "add", "-f", ".");
    await git(ws, "commit", "-m", "untrusted artifact");
    await assert.rejects(
      writeBack(snapshot, await git(ws, "rev-parse", "HEAD"), f.data),
      /不能自动回写/,
    );
    assert.equal(await readFile(join(f.repo, "hello.txt"), "utf8"), "base\n");
    await assert.rejects(
      readFile(join(f.repo, "node_modules/dependency/private.txt")),
      /ENOENT/,
    );
  } finally {
    await f.cleanup();
  }
});

test("stop during writeback rolls back installed files and preserves the original index", async () => {
  const f = await fixture();
  const { watch } = await import("node:fs");
  let watcher: import("node:fs").FSWatcher | undefined;
  try {
    const snapshot = await captureSnapshot(f.repo, f.data, crypto.randomUUID());
    const ws = join(f.root, "result");
    await git(f.repo, "worktree", "add", "--detach", ws, snapshot.commit);
    for (let i = 0; i < 20; i++)
      await writeFile(join(ws, `a${i}.txt`), "agent\n");
    await git(ws, "add", ".");
    await git(ws, "commit", "-m", "delivery");
    const index = await readFile(join(f.repo, ".git/index")),
      controller = new AbortController();
    watcher = watch(f.repo, (_, name) => {
      if (name === "a0.txt") controller.abort(new Error("stop requested"));
    });
    await assert.rejects(
      writeBack(
        snapshot,
        await git(ws, "rev-parse", "HEAD"),
        f.data,
        controller.signal,
      ),
      /stop requested/,
    );
    for (let i = 0; i < 20; i++)
      await assert.rejects(readFile(join(f.repo, `a${i}.txt`)), /ENOENT/);
    assert.deepEqual(await readFile(join(f.repo, ".git/index")), index);
  } finally {
    watcher?.close();
    await f.cleanup();
  }
});
