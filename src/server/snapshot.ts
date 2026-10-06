import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  readlink,
  mkdir,
  writeFile,
  rename,
  rm,
  symlink,
  chmod,
  realpath,
} from "node:fs/promises";
import { join, dirname, resolve, relative, sep } from "node:path";
import { git } from "./git.ts";
import { ensure } from "./store.ts";
import type { Snapshot } from "../shared/types.ts";
const exec = promisify(execFile);
const excluded = (p: string) =>
  /(^|\/)(node_modules|\.local|\.git|\.env(?:\..*)?|credentials\.json|id_rsa|id_ed25519)(\/|$)/.test(
    p,
  ) || p === ".agents/hooks.json";
async function command(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
) {
  return (
    await exec("git", ["-C", root, ...args], {
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
}
async function tree(root: string, commit: string) {
  const records: Record<string, { mode: string; blob: string }> = {};
  const raw = (await command(root, ["ls-tree", "-rz", commit])).toString();
  for (const entry of raw.split("\0").filter(Boolean)) {
    const at = entry.indexOf("\t");
    const [mode, type, blob] = entry.slice(0, at).split(" ");
    ensure(type === "blob", "SUBMODULE", "当前快照暂不支持嵌套子模块");
    records[entry.slice(at + 1)] = { mode, blob };
  }
  return records;
}
async function bytes(path: string) {
  try {
    const st = await lstat(path);
    ensure(
      st.isFile() || st.isSymbolicLink(),
      "UNSUPPORTED_FILE",
      `不能回写目录：${path}`,
    );
    return {
      data: st.isSymbolicLink()
        ? Buffer.from(await readlink(path))
        : await readFile(path),
      mode: st.isSymbolicLink()
        ? "120000"
        : st.mode & 0o111
          ? "100755"
          : "100644",
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
const digest = (data: Buffer, mode: string) =>
  createHash("sha256").update(mode).update("\0").update(data).digest("hex");
// Hash-only paths never retain a whole regular file. Write-back still needs bytes().
export async function fingerprintFile(
  path: string,
): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    ensure(
      stat.isFile() || stat.isSymbolicLink(),
      "UNSUPPORTED_FILE",
      `不能读取目录：${path}`,
    );
    const mode = stat.isSymbolicLink()
      ? "120000"
      : stat.mode & 0o111
        ? "100755"
        : "100644";
    const hash = createHash("sha256").update(mode).update("\0");
    if (stat.isSymbolicLink()) hash.update(await readlink(path));
    else
      for await (const chunk of createReadStream(path, {
        highWaterMark: 128 * 1024,
      }))
        hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function safePath(root: string, file: string) {
  const path = resolve(root, file);
  ensure(
    path.startsWith(`${resolve(root)}${sep}`) && !excluded(file),
    "UNSAFE_PATH",
    `拒绝回写路径：${file}`,
  );
  let parent = dirname(path);
  while (parent !== resolve(root)) {
    try {
      ensure(
        !(await lstat(parent)).isSymbolicLink(),
        "SYMLINK_PARENT",
        `父目录是符号链接：${file}`,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    parent = dirname(parent);
  }
  return path;
}
export async function captureSnapshot(
  root: string,
  dataDir: string,
  id: string,
): Promise<Snapshot> {
  const head = await git(root, "rev-parse", "HEAD");
  const branch = await git(root, "branch", "--show-current");
  const dir = join(dataDir, "snapshots", id);
  await mkdir(dir, { recursive: true });
  const index = join(dir, "index");
  const env = { GIT_INDEX_FILE: index };
  await command(root, ["read-tree", head], env);
  const listed = (
    await command(root, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const dataRelative = relative(await realpath(root), await realpath(dataDir));
  ensure(
    dataRelative !== "",
    "DATA_LOCATION",
    "Relay 数据目录不能是项目根目录",
  );
  const headFiles = (
    await command(root, ["ls-tree", "-rz", "--name-only", head])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const files = [...new Set([...listed, ...headFiles])].filter(
    (p) =>
      !excluded(p) &&
      (dataRelative === ".." ||
        dataRelative.startsWith(`..${sep}`) ||
        (!p.startsWith(`${dataRelative}/`) && p !== dataRelative)),
  );
  const fingerprints: Record<string, string> = {};
  for (const f of files) {
    const fingerprint = await fingerprintFile(join(root, f));
    if (fingerprint) fingerprints[f] = fingerprint;
  }
  // Never even stage excluded secrets or Relay data into Git's object store.
  const tracked = (await command(root, ["ls-files", "-z"], env))
    .toString()
    .split("\0")
    .filter(Boolean);
  const allowed = new Set(files);
  for (const file of tracked)
    if (!allowed.has(file))
      await command(root, ["update-index", "--force-remove", "--", file], env);
  for (let i = 0; i < files.length; i += 100)
    await command(root, ["add", "-A", "--", ...files.slice(i, i + 100)], {
      ...env,
      GIT_LITERAL_PATHSPECS: "1",
    });
  for (const file of files) {
    const fingerprint = await fingerprintFile(join(root, file));
    ensure(
      fingerprint === fingerprints[file],
      "SNAPSHOT_CHANGED",
      "读取快照时项目文件发生变化，请重新发送",
    );
  }
  ensure(
    (await git(root, "rev-parse", "HEAD")) === head &&
      (await git(root, "branch", "--show-current")) === branch,
    "SNAPSHOT_CHANGED",
    "读取快照时分支发生变化",
  );
  const treeId = (await command(root, ["write-tree"], env)).toString().trim();
  const commit = (
    await command(
      root,
      ["commit-tree", treeId, "-p", head, "-m", `Relay request snapshot ${id}`],
      {
        ...env,
        GIT_AUTHOR_NAME: "Relay",
        GIT_AUTHOR_EMAIL: "relay@localhost",
        GIT_COMMITTER_NAME: "Relay",
        GIT_COMMITTER_EMAIL: "relay@localhost",
      },
    )
  )
    .toString()
    .trim();
  await git(root, "update-ref", `refs/relay/snapshots/${id}`, commit);
  const snapshot = { root, head, branch, commit, fingerprints, id };
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(snapshot, null, 2),
    { mode: 0o600 },
  );
  await rm(index, { force: true });
  return snapshot;
}
export async function writeBack(
  snapshot: Snapshot,
  finalCommit: string,
  dataDir: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { root } = snapshot;
  ensure(
    (await git(root, "rev-parse", "HEAD")) === snapshot.head &&
      (await git(root, "branch", "--show-current")) === snapshot.branch,
    "ORIGINAL_CHANGED",
    "原项目分支或 HEAD 已变化，成果已保留，等待处理",
  );
  const files = (
    await command(root, [
      "diff",
      "--name-only",
      "-z",
      snapshot.commit,
      finalCommit,
    ])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const relativeData = relative(await realpath(root), await realpath(dataDir));
  const dataInside =
    relativeData !== ".." && !relativeData.startsWith(`..${sep}`);
  ensure(
    !files.some(
      (file) =>
        excluded(file) ||
        (dataInside &&
          (file === relativeData || file.startsWith(`${relativeData}/`))),
    ),
    "FILE_SCOPE",
    "成果包含凭据、依赖或 Relay 数据路径，不能自动回写",
  );
  const finalTree = await tree(root, finalCommit);
  const backup = join(dataDir, "delivery", snapshot.id);
  const journalPath = join(backup, "journal.json");
  async function install(
    file: string,
    value: { data: Buffer; mode: string } | undefined,
  ) {
    const target = await safePath(root, file);
    if (!value) {
      await rm(target, { force: true });
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.relay-${snapshot.id}.tmp`;
    let created = false;
    try {
      if (value.mode === "120000") await symlink(value.data.toString(), temp);
      else await writeFile(temp, value.data, { flag: "wx" });
      created = true;
      if (value.mode !== "120000")
        await chmod(temp, value.mode === "100755" ? 0o755 : 0o644);
      await rename(temp, target);
    } catch (error) {
      if (created) await rm(temp, { force: true });
      throw error;
    }
  }
  const finalValues = new Map<
    string,
    { data: Buffer; mode: string } | undefined
  >();
  for (const file of files) {
    const record = finalTree[file];
    finalValues.set(
      file,
      record
        ? {
            data: await command(root, ["cat-file", "blob", record.blob]),
            mode: record.mode,
          }
        : undefined,
    );
  }
  let saved:
    | {
        status: string;
        commit: string;
        files: string[];
        modes: Record<string, string>;
      }
    | undefined;
  try {
    saved = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (saved && ["prepared", "completed"].includes(saved.status)) {
    ensure(
      saved.commit === finalCommit,
      "DELIVERY_CHANGED",
      "回写版本已变化，保留备份待处理",
    );
    for (const file of files) {
      const value = await bytes(await safePath(root, file)),
        final = finalValues.get(file);
      const actual = value ? digest(value.data, value.mode) : undefined;
      const expected = final ? digest(final.data, final.mode) : undefined;
      ensure(
        actual === expected ||
          (saved.status === "prepared" &&
            actual === snapshot.fingerprints[file]),
        "WRITE_CONFLICT",
        `恢复回写时发现人工修改：${file}；备份已保留`,
      );
    }
    if (saved.status === "completed") return files;
    // A process died between writes. Restore only after all paths pass the check.
    for (const file of files) {
      await rm(`${await safePath(root, file)}.relay-${snapshot.id}.tmp`, {
        force: true,
      });
      await install(
        file,
        saved.modes[file]
          ? {
              data: await readFile(join(backup, "original", file)),
              mode: saved.modes[file],
            }
          : undefined,
      );
    }
    await writeFile(
      journalPath,
      JSON.stringify({ ...saved, status: "rolled-back" }),
    );
  }
  const originals = new Map<string, Awaited<ReturnType<typeof bytes>>>();
  for (const file of files) {
    const path = await safePath(root, file);
    const before = await bytes(path);
    ensure(
      (before ? digest(before.data, before.mode) : undefined) ===
        snapshot.fingerprints[file],
      "WRITE_CONFLICT",
      `原文件已变化：${file}；不会覆盖人工修改`,
    );
    originals.set(file, before);
  }
  await mkdir(backup, { recursive: true });
  for (const [file, value] of originals)
    if (value) {
      const path = join(backup, "original", file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value.data, { mode: 0o600 });
    }
  const written: string[] = [];
  const journal = {
    status: "prepared",
    files,
    commit: finalCommit,
    modes: Object.fromEntries(
      [...originals].filter(([, v]) => v).map(([f, v]) => [f, v!.mode]),
    ),
  };
  await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const current = await bytes(await safePath(root, file));
      ensure(
        (current ? digest(current.data, current.mode) : undefined) ===
          snapshot.fingerprints[file],
        "WRITE_CONFLICT",
        `回写前文件变化：${file}`,
      );
      const record = finalTree[file];
      await install(
        file,
        record
          ? {
              data: await command(root, ["cat-file", "blob", record.blob]),
              mode: record.mode,
            }
          : undefined,
      );
      written.push(file);
      signal?.throwIfAborted();
    }
    await writeFile(
      join(backup, "journal.json"),
      JSON.stringify({ ...journal, status: "completed" }),
    );
    signal?.throwIfAborted();
    return files;
  } catch (error) {
    for (const file of written.reverse()) {
      const value = await bytes(await safePath(root, file)),
        final = finalValues.get(file);
      ensure(
        (value ? digest(value.data, value.mode) : undefined) ===
          (final ? digest(final.data, final.mode) : undefined),
        "ROLLBACK_CONFLICT",
        `撤回时发现人工修改：${file}；备份已保留`,
      );
      await install(file, originals.get(file));
    }
    await writeFile(
      join(backup, "journal.json"),
      JSON.stringify({
        status: "rolled-back",
        files,
        error: (error as Error).message,
      }),
    );
    throw error;
  }
}

// Audit hashes only: includes ignored project files, never persists their contents.
// Dependency caches and Relay metadata are outside this audit; full access is not isolation.
export async function auditProjectFiles(
  root: string,
  dataDir?: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        dataDir &&
        (resolve(root, path) === resolve(dataDir) ||
          resolve(root, path).startsWith(`${resolve(dataDir)}${sep}`))
      )
        continue;
      if (
        [".git", ".local", "node_modules"].includes(entry.name) ||
        path === ".agents/hooks.json"
      )
        continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else {
        const fingerprint = await fingerprintFile(join(root, path));
        if (fingerprint) result[path] = fingerprint;
      }
    }
  }
  await walk(root);
  result["$git.head"] = await git(root, "rev-parse", "HEAD");
  result["$git.branch"] = await git(root, "branch", "--show-current");
  return result;
}
export async function assertAnalysisAudit(
  audit: Record<string, Record<string, string>>,
  dataDir?: string,
) {
  const changed: string[] = [];
  for (const [root, before] of Object.entries(audit)) {
    const after = await auditProjectFiles(root, dataDir);
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (before[path] !== after[path]) changed.push(`${root}/${path}`);
  }
  ensure(
    !changed.length,
    "ANALYSIS_MODIFIED",
    `分析任务修改了项目文件，验收失败：${changed.slice(0, 10).join("、")}`,
  );
}
