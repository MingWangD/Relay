import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DESKTOP_PROTOCOL_VERSION,
  type RelayReadyEnvelope,
} from "../shared/desktop.ts";

export type ServerOptions = {
  port: number;
  dataDir: string;
  readyFile?: string;
  root: string;
  dev: boolean;
};

function valueAfter(args: string[], index: number, name: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
  return value;
}

function integer(value: string, name: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} 无效：${value}`);
  return parsed;
}

/** Parse desktop flags while keeping the existing npm start environment contract. */
export function parseServerOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultRoot = resolve(import.meta.dirname, "../.."),
): ServerOptions {
  let port = env.PORT ?? "4317";
  let dataDir = env.RELAY_DATA_DIR ?? resolve(defaultRoot, ".local");
  let readyFile = env.RELAY_READY_FILE;
  let root = env.RELAY_ROOT ?? defaultRoot;
  let dev = false;
  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case "--dev":
        dev = true;
        break;
      case "--port":
        port = valueAfter(args, i++, "--port");
        break;
      case "--data-dir":
        dataDir = valueAfter(args, i++, "--data-dir");
        break;
      case "--ready-file":
        readyFile = valueAfter(args, i++, "--ready-file");
        break;
      case "--root":
        root = valueAfter(args, i++, "--root");
        break;
      default:
        throw new Error(`未知启动参数：${args[i]}`);
    }
  }
  return {
    port: integer(port, "端口", 0, 65535),
    dataDir: resolve(dataDir),
    readyFile: readyFile ? resolve(readyFile) : undefined,
    root: resolve(root),
    dev,
  };
}

export async function writeReadyFile(
  path: string,
  envelope: RelayReadyEnvelope,
) {
  if (envelope.protocolVersion !== DESKTOP_PROTOCOL_VERSION)
    throw new Error("不支持的 Relay 桌面协议版本");
  const url = new URL(envelope.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) !== envelope.port ||
    !Number.isInteger(envelope.port) ||
    envelope.port < 1 ||
    envelope.port > 65535 ||
    !Number.isInteger(envelope.pid) ||
    envelope.pid < 1 ||
    !envelope.token ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("ready URL 必须是本机地址");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(envelope)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function removeReadyFile(path?: string) {
  if (path) await unlink(path).catch(() => {});
}
