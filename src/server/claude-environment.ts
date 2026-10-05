import { spawn } from "node:child_process";
import { userInfo } from "node:os";

// Only these values may cross from a login shell. Never log shell output or secrets.
export const claudeEnvironmentKeys = [
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_EFFORT_LEVEL",
] as const;
type Environment = NodeJS.ProcessEnv;
export interface ClaudeEnvironment {
  environment: Record<string, string>;
  warning?: string;
}
const warning =
  "未能读取终端中的 Claude 配置；暂用启动环境与配置文件，可刷新重试。";
const marker = "\u001eRELAY_CLAUDE_ENV:";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function allowed(environment: Environment): Record<string, string> {
  return Object.fromEntries(
    claudeEnvironmentKeys.flatMap((key) =>
      typeof environment[key] === "string" ? [[key, environment[key]!]] : [],
    ),
  );
}

export function readClaudeShellEnvironment(
  environment: Environment,
  timeout = 5000,
): Promise<Record<string, string>> {
  const shell = environment.SHELL || userInfo().shell || "/bin/zsh";
  const code = `process.stdout.write(${JSON.stringify(marker)}+JSON.stringify(Object.fromEntries(${JSON.stringify(claudeEnvironmentKeys)}.filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]))))`;
  const command = `NODE_OPTIONS= NODE_PATH= exec ${quote(process.execPath)} -e ${quote(code)}`;
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-ilc", command], {
      env: { ...environment, TERM: "dumb", NODE_OPTIONS: "", NODE_PATH: "" },
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "",
      bytes = 0,
      finished = false;
    const stop = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (error?: Error, value?: Record<string, string>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value!);
    };
    const timer = setTimeout(() => {
      stop();
      finish(new Error(warning));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) {
        stop();
        finish(new Error(warning));
        return;
      }
      output += chunk;
    });
    child.on("error", () => finish(new Error(warning)));
    child.on("close", (status) => {
      if (finished) return;
      try {
        if (status !== 0 || !output.includes(marker)) throw new Error();
        const data = JSON.parse(
          output.slice(output.lastIndexOf(marker) + marker.length),
        );
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error();
        finish(undefined, allowed(data));
      } catch {
        finish(new Error(warning));
      }
    });
  });
}

export class ClaudeEnvironmentResolver {
  private cached?: { at: number; value: ClaudeEnvironment };
  private pending?: Promise<ClaudeEnvironment>;
  constructor(private read = readClaudeShellEnvironment) {}
  async resolve(
    environment: Environment = process.env,
    refresh = false,
  ): Promise<ClaudeEnvironment> {
    const explicit = allowed(environment);
    if (environment.RELAY_DESKTOP !== "1") return { environment: explicit };
    if (refresh || !this.cached || Date.now() - this.cached.at >= 60000) {
      if (!this.pending) {
        const shellInput =
          environment.RELAY_CLAUDE_ENV_EXPLICIT === "0"
            ? withClaudeEnvironment(environment, {})
            : environment;
        this.pending = this.read(shellInput)
          .then((value) => ({ environment: allowed(value) }))
          .catch(() => ({ environment: {}, warning }))
          .then((value) => {
            this.cached = { at: Date.now(), value };
            return value;
          });
      }
      try {
        await this.pending;
      } finally {
        this.pending = undefined;
      }
    }
    const shell = this.cached!.value;
    return {
      ...shell,
      // LaunchServices may retain environment from a much older terminal session.
      // A directly launched App keeps explicit overrides; a Finder launch uses the current shell.
      environment:
        environment.RELAY_CLAUDE_ENV_EXPLICIT === "0" && !shell.warning
          ? { ...shell.environment }
          : { ...shell.environment, ...explicit },
    };
  }
}
export const claudeEnvironment = new ClaudeEnvironmentResolver();

export function withClaudeEnvironment(
  base: NodeJS.ProcessEnv,
  environment: Record<string, string>,
): Record<string, string> {
  const result = Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const key of claudeEnvironmentKeys) delete result[key];
  return Object.assign(result, environment);
}
