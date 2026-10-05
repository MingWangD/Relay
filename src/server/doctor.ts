import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { Probe, Provider } from "../shared/types.ts";
const exec = promisify(execFile);
export const executables: Record<Provider, string> = {
  codex: "codex",
  antigravity: "agy",
  claude: "claude",
};
export async function probe(provider: Provider): Promise<Probe> {
  const executable = executables[provider];
  try {
    const [version, help] = await Promise.all([
      exec(executable, ["--version"], { timeout: 8000 }),
      exec(executable, ["--help"], { timeout: 8000 }),
    ]);
    const text = help.stdout + help.stderr;
    return {
      provider,
      executable,
      installed: true,
      version: version.stdout.trim(),
      nativeTerminal: true,
      initialPrompt:
        provider !== "antigravity" || text.includes("--prompt-interactive"),
      sessionControl:
        provider === "codex"
          ? text.includes("--remote")
          : provider === "antigravity"
            ? text.includes("--conversation")
            : text.includes("--resume"),
      verified: false,
      notes:
        provider === "codex"
          ? ["原生 TUI + App Server；连接时验证会话控制。"]
          : [
              "使用原生生命周期 Hook 与同一会话接续；本次连接尚待验证。权限请求在原生终端处理。",
            ],
    };
  } catch (error) {
    return {
      provider,
      executable,
      installed: false,
      version: "",
      nativeTerminal: false,
      initialPrompt: false,
      sessionControl: false,
      verified: false,
      notes: [(error as Error).message.split("\n")[0]],
    };
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(
    JSON.stringify(
      await Promise.all(
        (["codex", "antigravity", "claude"] as Provider[]).map(probe),
      ),
      null,
      2,
    ),
  );
}
