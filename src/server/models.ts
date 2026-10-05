import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  MemberConfig,
  ModelCatalog,
  Provider,
  ReasoningEffort,
} from "../shared/types.ts";
import { ensure, redact } from "./store.ts";
import {
  claudeEnvironment,
  withClaudeEnvironment,
} from "./claude-environment.ts";

const cache = new Map<string, { at: number; value: ModelCatalog }>();
const pending = new Map<string, Promise<ModelCatalog>>();
const effortNames: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const keyFor = (provider: Provider, root?: string) =>
  `${provider}:${root ?? ""}`;

async function codexModels(): Promise<ModelCatalog["models"]> {
  // Catalog-only process: initialize and list, never create a thread or inference turn.
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sequence = 0,
    buffer = "";
  const requests = new Map<
    number,
    { resolve: (value: any) => void; reject: (e: Error) => void }
  >();
  const fail = (e: Error) => {
    for (const p of requests.values()) p.reject(e);
    requests.clear();
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("模型目录进程已退出")));
  child.stdin.on("error", fail);
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const m = JSON.parse(line),
          p = requests.get(m.id);
        if (p) {
          requests.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        }
      } catch {
        /* Ignore non-protocol startup output. */
      }
    }
  });
  const timeout = setTimeout(() => {
    fail(new Error("模型目录读取超时"));
    child.kill();
  }, 15000);
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      requests.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    await call("initialize", {
      clientInfo: { name: "relay-model-picker", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const models: ModelCatalog["models"] = [];
    let cursor: string | undefined;
    do {
      const result = await call("model/list", {
        limit: 100,
        includeHidden: false,
        cursor,
      });
      for (const m of result.data ?? [])
        models.push({
          id: m.model ?? m.id,
          name: m.displayName ?? m.model ?? m.id,
          efforts: (m.supportedReasoningEfforts ?? [])
            .map((e: any) => e.reasoningEffort)
            .filter((e: ReasoningEffort) => effortNames.includes(e)),
          defaultEffort: m.defaultReasoningEffort,
        });
      cursor = result.nextCursor ?? undefined;
    } while (cursor && models.length < 500);
    return models;
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

export async function modelCatalog(
  provider: Provider,
  root?: string,
  refresh = false,
): Promise<ModelCatalog> {
  const key = keyFor(provider, root),
    cached = cache.get(key);
  if (!refresh && cached && Date.now() - cached.at < 60000) return cached.value;
  if (pending.has(key)) return pending.get(key)!;
  const read = (async (): Promise<ModelCatalog> => {
    try {
      let result: ModelCatalog;
      const configured =
        provider === "claude"
          ? await claudeEnvironment.resolve(process.env, refresh)
          : undefined;
      const cliEnvironment = configured
        ? withClaudeEnvironment(process.env, configured.environment)
        : process.env;
      if (provider === "codex")
        result = {
          provider,
          models: await codexModels(),
          source: "Codex 原生模型目录",
        };
      else if (provider === "antigravity") {
        const { stdout } = await promisify(execFile)("agy", ["models"], {
          timeout: 15000,
          maxBuffer: 256000,
        });
        result = {
          provider,
          source: "Antigravity 原生模型目录",
          models: stdout.split("\n").flatMap((line) => {
            const m = /^([\w./:-]+)\t(.+)$/.exec(line.trim());
            return m ? [{ id: m[1], name: m[2] }] : [];
          }),
        };
      } else {
        const models: ModelCatalog["models"] = [
          { id: "opus", name: "Opus（CLI 别名）" },
          { id: "sonnet", name: "Sonnet（CLI 别名）" },
          { id: "haiku", name: "Haiku（CLI 别名）" },
          { id: "fable", name: "Fable（CLI 别名）" },
        ];
        const addConfigured = (id: unknown) => {
          if (typeof id === "string" && id && !models.some((m) => m.id === id))
            models.push({ id, name: `${id}（已配置）` });
        };
        for (const key of [
          "ANTHROPIC_MODEL",
          "ANTHROPIC_DEFAULT_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          "ANTHROPIC_DEFAULT_FABLE_MODEL",
        ])
          addConfigured(cliEnvironment[key]);
        for (const path of [
          join(
            cliEnvironment.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
            "settings.json",
          ),
          ...(root
            ? [
                join(root, ".claude", "settings.json"),
                join(root, ".claude", "settings.local.json"),
              ]
            : []),
        ]) {
          try {
            const settings = JSON.parse(await readFile(path, "utf8"));
            const ids = [
              settings.model,
              ...[
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_FABLE_MODEL",
              ].map((key) => settings.env?.[key]),
              ...(Array.isArray(settings.availableModels)
                ? settings.availableModels
                : []),
            ];
            for (const id of ids)
              if (typeof id === "string" && !models.some((m) => m.id === id))
                models.push({ id, name: `${id}（已配置）` });
          } catch {
            /* Missing settings leave native aliases available. */
          }
        }
        result = {
          provider,
          models,
          source:
            "CLI 别名与本机配置；实际可用性由 CLI 确认" +
            (configured?.warning ? `。${configured.warning}` : ""),
        };
      }
      if (provider !== "codex") {
        const { stdout } = await promisify(execFile)(
          provider === "claude" ? "claude" : "agy",
          ["--help"],
          { timeout: 8000, maxBuffer: 256000, env: cliEnvironment },
        );
        const match = /--effort[^\n]*(?:\n[^\n]*)?/.exec(stdout)?.[0] ?? "";
        result.cliEfforts = effortNames.filter((e) =>
          new RegExp(`\\b${e}\\b`).test(match),
        );
      }
      cache.set(key, { at: Date.now(), value: result });
      return result;
    } catch (e) {
      return {
        provider,
        models: [],
        source: "原生 CLI",
        error: redact((e as Error).message).slice(0, 300),
      };
    }
  })();
  pending.set(key, read);
  try {
    return await read;
  } finally {
    pending.delete(key);
  }
}

export async function validateMemberConfig(
  member: MemberConfig,
  root?: string,
) {
  ensure(
    !member.model || /^[^\s\x00-\x1f]{1,160}$/.test(member.model),
    "INVALID_MODEL",
    "模型 ID 不能包含空白或控制字符",
  );
  ensure(
    !member.reasoningEffort || effortNames.includes(member.reasoningEffort),
    "INVALID_EFFORT",
    "不支持此思考强度",
  );
  if (member.provider === "antigravity" && member.reasoningEffort) {
    const catalog = cache.get(keyFor(member.provider, root))?.value;
    const suffix = member.model?.match(/-(low|medium|high|max)$/)?.[1];
    ensure(
      !suffix || suffix === member.reasoningEffort,
      "ANTI_MODEL_CONFLICT",
      "Antigravity 模型与旧强度冲突，请重新选择完整模型 ID",
    );
    const full = suffix
      ? member.model
      : member.model
        ? member.model + "-" + member.reasoningEffort
        : undefined;
    ensure(
      full && catalog?.models.some((m) => m.id === full),
      "ANTI_MODEL_MIGRATION",
      "无法匹配 Antigravity 旧强度，请重新选择完整模型 ID",
    );
    member.model = full;
    member.reasoningEffort = undefined;
  }
  const known = cache
    .get(keyFor(member.provider, root))
    ?.value.models.find((m) => m.id === member.model);
  ensure(
    !member.reasoningEffort ||
      !known?.efforts ||
      known.efforts.includes(member.reasoningEffort),
    "INVALID_EFFORT",
    "所选模型不支持此思考强度",
  );
}
