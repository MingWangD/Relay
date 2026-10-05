import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { git, GitService } from "../src/server/git.ts";
import { Store } from "../src/server/store.ts";
import { Auth } from "../src/server/auth.ts";
import { NativeRuntime } from "../src/server/runtime.ts";
import { Service } from "../src/server/service.ts";
import { createHttp } from "../src/server/http.ts";
import type { Provider } from "../src/shared/types.ts";

const provider = (process.argv
  .find((x) => x.startsWith("--provider="))
  ?.split("=")[1] ?? "codex") as Provider;
const reuseAt = process.argv.indexOf("--reuse-dir");
const reuseDir = reuseAt >= 0 ? process.argv[reuseAt + 1] : undefined;
if (reuseDir && !/^\.local\/request-\d+$/.test(reuseDir))
  throw Error("Only isolated request fixtures may be reused");
const root = reuseDir
  ? resolve(reuseDir)
  : resolve(".local", "smoke-" + provider + "-" + Date.now());
await mkdir(root, { recursive: true });
const repo = join(root, "repo");
if (!reuseDir) {
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Relay Smoke");
  await git(repo, "config", "user.email", "relay@localhost");
  await writeFile(join(repo, "README.md"), "# Native CLI smoke test\\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "smoke fixture");
}
const store = new Store(join(root, "state.sqlite"));
const auth = new Auth(root);
const runtime = new NativeRuntime(root);
const service = new Service(store, auth, new GitService(root), runtime);
const app = await createHttp(service, { port: 0, root: resolve(".") });
if (!reuseDir)
  await service.createProject(repo, "原生终端接入验证，不修改业务文件");
const id = reuseDir
  ? store.state.agents.find((a) => a.provider === provider)!.id
  : (await service.addAgent(provider, provider, "验证者")).id;
const a = store.state.agents.find((a) => a.id === id)!;
if (!reuseDir)
  a.permissionMode = process.argv.includes("--native") ? "native" : "full";
a.model =
  process.argv.find((x) => x.startsWith("--model="))?.slice(8) ?? a.model;
a.reasoningEffort =
  (process.argv
    .find((x) => x.startsWith("--effort="))
    ?.slice(9) as typeof a.reasoningEffort) ?? a.reasoningEffort;
store.mutate((s) =>
  Object.assign(
    s.agents.find((member) => member.id === id)!,
    a,
  ),
);
// A direct adapter check does not submit a collaboration request. Give the browser
// an explicitly stopped display fixture so its terminal controls are available.
if (!reuseDir && process.argv.includes("--scroll-check"))
  store.mutate((s) => {
    s.userRequests.push({
      id: crypto.randomUUID(),
      conversationId: s.defaultConversationId,
      text: "原生终端滚动与排版检查（展示夹具）",
      status: "stopped",
      createdAt: new Date().toISOString(),
      agentIds: [id],
      version: 0,
      rounds: 0,
    });
  });
const cwd = await service.work.planningWorkspace(store.state.project!, id);
let output = "";
let trusted = false;
let approvedTool = false;
let resumed = false;
const events: unknown[] = [];
runtime.on("terminal", (p) => {
  output += p.data;
  const screen = output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s/g, "")
    .toLowerCase();
  // Only the isolated fixture authored by this script may be trusted automatically.
  if (
    provider === "claude" &&
    process.argv.includes("--trust-fixture") &&
    !trusted &&
    screen.includes("isthisaprojectyoucreatedoroneyoutrust")
  ) {
    trusted = true;
    setTimeout(() => runtime.write(id, "\x1b[B\r"), 250);
  }
  if (
    process.argv.includes("--trust-fixture") &&
    !trusted &&
    (screen.includes("trustthisfolder?") ||
      screen.includes("doyoutrustthecontentsofthisproject?"))
  ) {
    trusted = true;
    setTimeout(() => runtime.write(id, "\r"), 250);
  }
  if (
    process.argv.includes("--trust-fixture") &&
    !approvedTool &&
    screen.includes("allowcallingthistool?") &&
    screen.includes("relay/get_project_state")
  ) {
    approvedTool = true;
    setTimeout(() => runtime.write(id, "\r"), 250);
  }
});
runtime.on("event", (e) => {
  events.push(e);
  console.log(
    JSON.stringify({
      type: e.type,
      sessionConfirmed: Boolean(e.sessionId),
      model: e.model,
      effort: e.effort,
      detail:
        e.type === "error" || e.type === "connection-warning"
          ? e.detail
          : undefined,
    }),
  );
  if (
    process.argv.includes("--trust-fixture") &&
    e.type === "approval" &&
    e.request?.method === "mcpServer/elicitation/request" &&
    e.request.params?.message?.includes('"get_project_state"')
  )
    runtime.approve(id, e.request.id, true);
  if (
    process.argv.includes("--resume-check") &&
    e.type === "turn-ended" &&
    !resumed
  ) {
    resumed = true;
    approvedTool = false;
    output = "";
    setTimeout(
      () =>
        void service
          .sendMessage("user", {
            targetId: id,
            text: "这是接续验证，只回复“接续成功”。不要调用工具，不要修改文件。",
          })
          .then(console.log),
      300,
    );
  }
});
try {
  await service.startSession({
    agent: a,
    cwd,
    url: service.url,
    token: auth.issue(id),
    readOnly: true,
    prompt: process.argv.includes("--scroll-check")
      ? "请回复 1 到 60 的数字，每个数字单独一行并附上‘中文排版测试’。最后原样显示一条长命令示例：node steps/lint-markers.mjs && node steps/docs-sync.mjs --check && node steps/run.mjs 1 --demo。这只是文字示例，不要执行命令，不要修改文件，不要调用工具。此为原生历史滚动与排版验证。"
      : process.argv.includes("--inference")
        ? "只调用 relay.get_project_state 获取项目目标，然后回复“原生会话验证成功”。不要修改文件，不要执行 shell，不要使用其他工具。"
        : undefined,
  });
  if (process.argv.includes("--scroll-check")) {
    const deadline = Date.now() + 300000;
    while (
      !events.some((e: any) => e.type === "turn-ended") &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 500));
    if (!events.some((e: any) => e.type === "turn-ended"))
      throw Error("Native turn did not finish");
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.goto(app.url + "/#token=" + auth.consoleToken);
      await page.locator(".process > summary").last().click();
      await page
        .getByRole("button", { name: "查看真实终端", exact: true })
        .click();
      const panel = page.locator('[data-agent="' + id + '"]');
      await panel.locator('[data-action="expand"]').click();
      await new Promise((r) => setTimeout(r, 1000));
      const generation = (await runtime.snapshot(id)).generation;
      let scrolls = 0;
      let scrollBytes = 0;
      const original = runtime.scroll.bind(runtime);
      runtime.scroll = (...args) => {
        if (args[0] === id) scrolls++;
        const bytes = original(...args);
        scrollBytes += bytes;
        return bytes;
      };
      const { TerminalScreen } =
        await import("../src/server/terminal-screen.ts");
      const visible = async () => {
        const screen = new TerminalScreen();
        const snapshot = await runtime.snapshot(id);
        screen.resize(snapshot.cols, snapshot.rows);
        await new Promise<void>((r) => screen.write(snapshot.data, () => r()));
        const text = screen.text();
        screen.dispose();
        return text;
      };
      const before = await visible();
      const rows = panel.locator(".xterm-rows");
      const browserBefore = await rows.innerText();
      await panel.locator(".xterm-screen").hover();
      await page.mouse.wheel(0, -480);
      await new Promise((r) => setTimeout(r, 1000));
      const after = await visible();
      const browserAfter = await rows.innerText();
      await page.screenshot({
        path: join(root, "scroll-" + provider + ".png"),
      });
      const bound = store.state.agents.find((a) => a.id === id)!.boundSessionId;
      const observed = [
        ...new Set(
          events
            .filter((e: any) => e.agentId === id && e.sessionId)
            .map((e: any) => e.sessionId),
        ),
      ];
      const result = {
        provider,
        passed:
          (scrolls > 0
            ? scrollBytes > 0 && before !== after
            : browserBefore !== browserAfter) &&
          observed.length === 1 &&
          observed[0] === bound,
        restrictedScrolls: scrolls,
        nativeScrollBytes: scrollBytes,
        nativeViewportChanged: before !== after,
        browserViewportChanged: browserBefore !== browserAfter,
        oneNativeId: observed.length === 1,
        generationUnchanged:
          (await runtime.snapshot(id)).generation === generation,
        keyboardLocked: !store.state.agents.find((a) => a.id === id)!.manual,
      };
      await writeFile(
        join(root, "scroll-" + provider + "-evidence.json"),
        JSON.stringify(result, null, 2),
      );
      await writeFile(
        join(root, "scroll-" + provider + "-events.json"),
        JSON.stringify(events, null, 2),
      );
      console.log(JSON.stringify(result));
      if (!result.passed) process.exitCode = 1;
    } finally {
      await browser.close();
    }
  } else
    await new Promise((r) =>
      setTimeout(
        r,
        process.argv.includes("--resume-check")
          ? 80000
          : process.argv.includes("--inference")
            ? 60000
            : 6000,
      ),
    );
  await writeFile(
    join(
      root,
      reuseDir ? "scroll-" + provider + "-terminal.txt" : "terminal.txt",
    ),
    output,
  );
  await writeFile(
    join(
      root,
      reuseDir ? "scroll-" + provider + "-events.json" : "events.json",
    ),
    JSON.stringify(events, null, 2),
  );
  console.log(`Evidence: ${root}`);
} finally {
  await service.stopAll();
  await app.close();
  store.close();
}
