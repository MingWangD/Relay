import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { AppError, ensure } from "./store.ts";

export type LocalPathKind = "file" | "folder";
export interface LocalPathSelection {
  path: string;
  name: string;
  kind: LocalPathKind;
}
const exec = promisify(execFile);

// Constant AppleScript only: user-selected paths never enter executable code.
export async function pickLocalPath(
  kind: LocalPathKind,
  run = (script: string) =>
    exec("/usr/bin/osascript", ["-e", script], {
      timeout: 180000,
      maxBuffer: 64000,
      signal,
    }).then((r) => r.stdout),
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<LocalPathSelection | null> {
  ensure(platform === "darwin", "PLATFORM", "本机选择器目前仅支持 macOS");
  const script =
    kind === "file"
      ? 'POSIX path of (choose file with prompt "选择本机文件")'
      : 'POSIX path of (choose folder with prompt "选择本机文件夹")';
  let output: string;
  try {
    output = await run(script);
  } catch (error) {
    const detail = String(
      (error as { stderr?: string }).stderr ?? (error as Error).message,
    );
    if (/\(-128\)|User canceled/i.test(detail)) return null;
    throw new AppError(
      "LOCAL_PICKER",
      "无法打开 macOS 选择器；请检查本机系统授权后重试",
      409,
    );
  }
  return validateLocalPath(output.replace(/\r?\n$/, ""), kind);
}

export async function validateLocalPath(
  selected: string,
  kind: LocalPathKind,
): Promise<LocalPathSelection> {
  const path = await realpath(selected);
  const info = await stat(path);
  ensure(
    kind === "file" ? info.isFile() : info.isDirectory(),
    "LOCAL_PATH_TYPE",
    "所选路径类型不匹配",
  );
  return { path, name: basename(path), kind };
}
