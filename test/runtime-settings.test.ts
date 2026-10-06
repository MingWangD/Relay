import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { NativeRuntime, nativeAttention } from "../src/server/runtime.ts";
import { TerminalScreen } from "../src/server/terminal-screen.ts";
import { fixture, until } from "./helpers.ts";
import { createHttp } from "../src/server/http.ts";
import type { Provider, PermissionMode } from "../src/shared/types.ts";

// Real child processes and PTYs, fake CLI protocol only. Never invokes a model or changes CLI settings.
test("three native adapters launch and resume with session-scoped permissions/model/effort", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-launch-"));
  await mkdir(join(root, ".agents"));
  await writeFile(
    join(root, ".agents/hooks.json"),
    JSON.stringify({
      relay: {
        PreInvocation: [
          { command: "node /old/scripts/agent-hook.mjs start" },
          { command: "echo user-hook" },
        ],
      },
      custom: { Stop: [{ command: "echo keep" }] },
    }),
  );
  await writeFile(join(root, "same-session.db"), "fixture");
  const bin = join(root, "bin");
  await mkdir(bin);
  const capture = join(root, "capture.jsonl");
  const requireCapture = () =>
    readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const wsPath = resolve("node_modules/ws/index.js");
  const script = `#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2);
if(args.includes('--version')){console.log('fixture 1.2.16');process.exit(0)}
if(args.includes('--help')){console.log('--remote --conversation --resume --prompt-interactive --effort low medium high');process.exit(0)}
const record=value=>fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(value)+'\\n');
if(args[0]==='plugin'){record({plugin:args});process.exit(0)}
if(args[0]==='app-server'){
 const {WebSocketServer}=require(${JSON.stringify(wsPath)});
 const url=new URL(args[args.indexOf('--listen')+1]);
 const server=new WebSocketServer({port:Number(url.port),host:'127.0.0.1'});
 server.on('connection',s=>s.on('message',raw=>{
  const m=JSON.parse(raw); if(!m.id)return;
  record({method:m.method,params:m.params});
  const path=${JSON.stringify(join(root, "rollout.json"))};fs.writeFileSync(path,'{}');
  const result=(m.method==='thread/start'||m.method==='thread/resume')?{thread:{id:'fixture-session',path},model:m.params.model,reasoningEffort:m.params.config?.model_reasoning_effort}:{turn:{id:'fixture-turn'}};
  s.send(JSON.stringify({id:m.id,result}));
 }));
}else{
 record({args,token:process.env.RELAY_AGENT_TOKEN,generation:process.env.RELAY_SESSION_GENERATION,modelEnv:process.env.ANTHROPIC_MODEL,effortEnv:process.env.CLAUDE_CODE_EFFORT_LEVEL,shellCredential:process.env.ANTHROPIC_AUTH_TOKEN==='fixture-shell-token',shellEndpoint:process.env.ANTHROPIC_BASE_URL==='https://fixture.invalid'});
 process.stdout.write(String.fromCharCode(27)+"[?1049h"+String.fromCharCode(27)+"[?1000h"+String.fromCharCode(27)+"[?1006hfixture-screen");
 process.stdin.setRawMode(true); process.stdin.on('data',data=>record({inputHex:data.toString('hex')}));
 setInterval(()=>{},1000);
}
`;
  for (const executable of ["codex", "agy", "claude"])
    await writeFile(join(bin, executable), script, { mode: 0o755 });
  const oldPath = process.env.PATH,
    oldModel = process.env.ANTHROPIC_MODEL,
    oldEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.ANTHROPIC_MODEL = "inherited-model";
  process.env.CLAUDE_CODE_EFFORT_LEVEL = "low";
  const shell = join(root, "shell");
  await writeFile(
    shell,
    '#!/bin/sh\nexport ANTHROPIC_AUTH_TOKEN=fixture-shell-token\nexport ANTHROPIC_BASE_URL=https://fixture.invalid\nexec /bin/sh -c "$2"\n',
    { mode: 0o755 },
  );
  const shellKeys = [
    "SHELL",
    "RELAY_DESKTOP",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  ];
  const oldShellEnvironment = Object.fromEntries(
    shellKeys.map((key) => [key, process.env[key]]),
  );
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  process.env.SHELL = shell;
  process.env.RELAY_DESKTOP = "1";
  t.after(async () => {
    for (const key of shellKeys) {
      if (oldShellEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = oldShellEnvironment[key];
    }
    process.env.PATH = oldPath;
    if (oldModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = oldModel;
    if (oldEffort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = oldEffort;
    await rm(root, { recursive: true, force: true });
  });
  for (const provider of ["codex", "antigravity", "claude"] as Provider[])
    for (const permissionMode of ["full", "native"] as PermissionMode[]) {
      await writeFile(capture, "");
      const runtime = new NativeRuntime(
        join(root, provider, permissionMode),
        20,
        root,
      );
      const agent = {
        id: randomUUID(),
        name: provider,
        role: "test",
        provider,
        status: "offline" as const,
        manual: false,
        permissionMode,
        model: "selected-model",
        reasoningEffort: "high" as const,
      };
      const options = {
        agent,
        cwd: root,
        url: "http://127.0.0.1:1",
        token: "fixture",
        readOnly: true,
        prompt: "fixture",
      };
      const events: any[] = [];
      runtime.on("event", (e) => events.push(e));
      try {
        await runtime.start(options);
        await until(() => events.some((e) => e.type === "connected"));
        // Headless diagnostic timeout: keep the process; never automatically restart it.
        await until(() => events.some((e) => e.type === "connection-warning"));
        assert.ok(events.some((e) => e.type === "connection-warning"));
        assert.equal(runtime.has(agent.id), true);

        if (provider !== "codex") {
          const deadline = Date.now() + 3000;
          while (
            !(await readFile(capture, "utf8"))
              .split("\n")
              .filter((x) => x && JSON.parse(x).args).length
          ) {
            assert.ok(
              Date.now() < deadline,
              "PTY must actually start before resuming",
            );
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        let terminalSnapshot = await runtime.snapshot(agent.id);
        if (provider === "claude") {
          const launch = requireCapture().find((record) => record.args);
          assert.equal(launch.modelEnv, "selected-model");
          assert.equal(launch.shellCredential, true);
          assert.equal(launch.shellEndpoint, true);
        }
        const snapshotDeadline = Date.now() + 3000;
        while (!terminalSnapshot.data.includes("fixture-screen")) {
          assert.ok(Date.now() < snapshotDeadline, "terminal snapshot missing");
          await new Promise((r) => setTimeout(r, 20));
          terminalSnapshot = await runtime.snapshot(agent.id);
        }
        const generation = terminalSnapshot.generation;
        assert.throws(
          () => runtime.scroll(agent.id, randomUUID(), "up", 1, 1, 1),
          /变化/,
        );
        assert.throws(
          () => runtime.scroll(agent.id, generation, "up", 100, 1, 1),
          /无效/,
        );
        // The server must track Codex's fullscreen screen too, not just Anti/Claude hints.
        // Let the headless VT parser process the mouse-mode update before scrolling.
        await until(
          () => runtime.scroll(agent.id, generation, "up", 2, 3, 4) === 20,
        );
        await until(() => {
          const records = requireCapture();
          return records
            .map((x) => x.inputHex ?? "")
            .join("")
            .includes(
              Buffer.from("\x1b[<64;3;4M\x1b[<64;3;4M").toString("hex"),
            );
        });
        runtime.emit("event", { agentId: agent.id, type: "activity" });
        runtime.observeLifecycle(agent.id, "same-session", true);
        assert.equal(
          await runtime.send(
            agent.id,
            "continuation",
            "fresh-continuation-token",
            [join(root, "supplement.png")],
          ),
          true,
        );
        if (provider !== "codex") {
          const deadline = Date.now() + 3000;
          while (
            (await readFile(capture, "utf8"))
              .split("\n")
              .filter((x) => x && JSON.parse(x).args).length < 2
          ) {
            assert.ok(Date.now() < deadline, "Resumed PTY must start");
            await new Promise((r) => setTimeout(r, 20));
          }
        } else await new Promise((r) => setTimeout(r, 80));
        if (provider !== "codex")
          assert.equal(
            requireCapture()
              .filter((x) => x.args)
              .at(-1).token,
            "fresh-continuation-token",
          );
        const lines = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((x) => JSON.parse(x));
        if (provider === "codex") {
          const continuation = lines
            .filter((x) => ["turn/start", "turn/steer"].includes(x.method))
            .at(-1);
          assert.ok(
            continuation.params.input.some(
              (x: any) =>
                x.type === "localImage" &&
                x.path === join(root, "supplement.png"),
            ),
          );
          const thread = lines.find((x) => x.method === "thread/start").params;
          assert.equal(
            thread.approvalPolicy,
            permissionMode === "full" ? "never" : "on-request",
          );
          assert.equal(
            thread.sandbox,
            permissionMode === "full" ? "danger-full-access" : "read-only",
          );
          assert.equal(thread.model, "selected-model");
          assert.equal(thread.config.model_reasoning_effort, "high");
          const turns = lines.filter((x) => x.method === "turn/start");
          assert.equal(turns.length, 2);
          assert.ok(
            turns.every(
              (x) =>
                x.params.model === "selected-model" &&
                x.params.effort === "high",
            ),
          );
          assert.ok(
            !lines
              .find((x) => x.args)
              ?.args.includes("--dangerously-bypass-approvals-and-sandbox"),
          );
        } else {
          const launches = lines.filter((x) => x.args);
          assert.equal(launches.length, 2);
          assert.ok(
            launches.every(
              (x) =>
                x.args.includes("--model") &&
                x.args[x.args.indexOf("--model") + 1] === "selected-model" &&
                (provider === "antigravity"
                  ? !x.args.includes("--effort")
                  : x.args[x.args.indexOf("--effort") + 1] === "high"),
            ),
          );
          assert.ok(
            launches.every(
              (x) =>
                x.args.includes("--dangerously-skip-permissions") ===
                (permissionMode === "full"),
            ),
          );
          assert.equal(launches[0].generation, generation);
          assert.notEqual(launches[1].generation, generation);
          if (provider === "antigravity") {
            assert.equal(
              launches[0].args.includes("--sandbox"),
              permissionMode === "native",
            );
            assert.ok(launches[1].args.includes("--conversation"));
            const hook = JSON.parse(
              await readFile(
                join(
                  root,
                  provider,
                  permissionMode,
                  "plugins/relay-codex2anti/hooks.json",
                ),
                "utf8",
              ),
            );
            assert.ok(hook.relay.PreInvocation && hook.relay.Stop);
            const workspaceHooks = JSON.parse(
              await readFile(join(root, ".agents/hooks.json"), "utf8"),
            );
            assert.deepEqual(workspaceHooks.relay.PreInvocation, [
              { command: "echo user-hook" },
            ]);
            assert.ok(workspaceHooks.custom.Stop);
          } else {
            assert.equal(
              launches[0].args[
                launches[0].args.indexOf("--permission-mode") + 1
              ],
              permissionMode === "full" ? "bypassPermissions" : "plan",
            );
            assert.equal(launches[0].modelEnv, "selected-model");
            assert.equal(launches[0].effortEnv, "high");
            const settings = JSON.parse(
              await readFile(
                launches[0].args[launches[0].args.indexOf("--settings") + 1],
                "utf8",
              ),
            );
            assert.equal(
              settings.sandbox?.enabled,
              permissionMode === "full" ? false : undefined,
            );
            assert.ok(settings.hooks.SessionStart && settings.hooks.Stop);
            assert.ok(launches[1].args.includes("--resume"));
          }
        }
      } finally {
        await runtime.stop(agent.id);
      }
    }
  assert.equal(process.env.ANTHROPIC_MODEL, "inherited-model");
  assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, "low");
});

test("split permission prompts and VT redraw use the current screen", async () => {
  const screen = new TerminalScreen();
  const write = (data: string) =>
    new Promise<string>((r) => screen.write(data, r));
  try {
    await write("Allow calling this ");
    assert.ok(nativeAttention(await write("tool?")));
    assert.equal(
      nativeAttention(await write("\x1b[2J\x1b[HGenerating...")),
      undefined,
    );
    await write("\x1b[?1049hRun this command?");
    assert.ok(nativeAttention(screen.text()));
    assert.equal(nativeAttention(await write("\x1b[?1049l")), undefined);
  } finally {
    screen.dispose();
  }
});

test("terminal scroll uses mouse reports or cursor keys only in fullscreen", async () => {
  const screen = new TerminalScreen();
  const write = (text: string) =>
    new Promise<void>((done) => screen.write(text, () => done()));
  assert.equal(screen.scroll("up", 2, 1, 1), "");
  await write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
  assert.equal(screen.scroll("up", 2, 3, 4), "\x1b[<64;3;4M\x1b[<64;3;4M");
  assert.equal(screen.scroll("down", 1, 3, 4), "\x1b[<65;3;4M");
  assert.equal(screen.scroll("down", 1, 300, 4), "");
  await write("\x1b[?1000l");
  assert.equal(screen.scroll("up", 2, 3, 4), "\x1b[A\x1b[A");
  await write("\x1b[?1h");
  assert.equal(screen.scroll("down", 1, 3, 4), "\x1bOB");
  await write("\x1b[?1049l");
  assert.equal(screen.scroll("down", 1, 3, 4), "");
  screen.dispose();
});

test("terminal snapshot restores Chinese, ANSI positioning and fullscreen modes", async () => {
  const screen = new TerminalScreen();
  try {
    await new Promise<void>((done) =>
      screen.write(
        "旧输出\r\n".repeat(60) +
          "\x1b[?1049h\x1b[2J\x1b[4;12H中文排版\x1b[?1000h\x1b[?1006h",
        () => done(),
      ),
    );
    const snapshot = screen.snapshot();
    assert.equal(snapshot.cols, 100);
    assert.equal(snapshot.rows, 28);
    assert.ok(snapshot.data.includes("中文排版"));
    const restored = new TerminalScreen();
    try {
      restored.resize(snapshot.cols, snapshot.rows);
      await new Promise<void>((done) =>
        restored.write(snapshot.data, () => done()),
      );
      assert.equal(restored.text(), screen.text());
      assert.equal(restored.scroll("up", 1, 3, 4), "\x1b[<64;3;4M");
    } finally {
      restored.dispose();
    }
  } finally {
    screen.dispose();
  }
});

test("terminal capture waits for queued output before serializing", async () => {
  const screen = new TerminalScreen();
  try {
    screen.write("输出\r\n".repeat(2000) + "最终画面", () => {});
    const snapshot = await screen.capture(() => 7);
    assert.equal(snapshot?.seq, 7);
    assert.ok(snapshot?.data.includes("最终画面"));
  } finally {
    screen.dispose();
  }
});

test("old lifecycle and MCP generations are rejected; valid hooks record native identity", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = f.agent();
  const generation = randomUUID();
  f.store.mutate((s) => {
    s.agents[0].provider = "antigravity";
    s.agents[0].generation = generation;
    s.agents[0].status = "starting";
  });
  const app = await createHttp(f.service, { port: 0, root: resolve(".") });
  t.after(app.close);
  const headers = {
    Authorization: `Bearer ${f.service.auth.issue(id)}`,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown) =>
    fetch(app.url + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post("/api/hooks", {
        event: "start",
        generation: randomUUID(),
        sessionId: "old",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post("/api/tools", {
        tool: "get_project_state",
        requestId: "stale",
        arguments: {},
        generation: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post("/api/hooks", {
        event: "start",
        generation,
        sessionId: "native-session",
        model: "actual-model",
      })
    ).status,
    200,
  );
  assert.equal(f.store.state.agents[0].sessionId, "native-session");
  assert.equal(f.store.state.agents[0].effectiveModel, "actual-model");
  assert.equal(f.store.state.agents[0].status, "running");
  assert.equal(
    (
      await post("/api/hooks", {
        event: "stop",
        generation,
        sessionId: "native-session",
      })
    ).status,
    200,
  );
  assert.equal(f.store.state.agents[0].status, "idle");
});

test("hook failures leave a private reason without leaking credentials", async (t) => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "relay-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(409);
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const address = server.address() as import("node:net").AddressInfo;
  const log = join(root, "hook-errors.jsonl");
  const child = spawn(
    process.execPath,
    [resolve("scripts/agent-hook.mjs"), "start"],
    {
      env: {
        ...process.env,
        RELAY_URL: `http://127.0.0.1:${address.port}`,
        RELAY_AGENT_TOKEN: "sk-fixture-secret",
        RELAY_HOOK_LOG: log,
        RELAY_SESSION_GENERATION: randomUUID(),
      },
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(JSON.stringify({ conversationId: "fixture" }));
  await new Promise<void>((r, reject) => {
    child.on("exit", () => r());
    child.on("error", reject);
  });
  assert.equal(stdout.trim(), "{}");
  assert.match(stderr, /HTTP 409/);
  const written = await readFile(log, "utf8");
  assert.match(written, /HTTP 409/);
  assert.ok(!written.includes("sk-fixture-secret"));
});
