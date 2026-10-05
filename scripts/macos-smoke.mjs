import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyNodeRuntime } from "./package-macos.mjs";

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resources = resolve(
  process.argv[2] ?? resolve(repo, "dist-macos/Relay.app"),
  "Contents/Resources",
);
const node = resolve(resources, "node/bin/node");
const root = resolve(resources, "server");
await mkdir(resolve(repo, ".local"), { recursive: true });
const evidenceDir = await mkdtemp(resolve(repo, ".local/macos-smoke-"));
const data = resolve(evidenceDir, "data");
const readyPath = resolve(evidenceDir, "ready.json");
const env = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: process.env.HOME,
  NODE_ENV: "production",
};
const runtime = await verifyNodeRuntime(node);
const child = spawn(
  node,
  [
    "--import",
    resolve(root, "node_modules/tsx/dist/loader.mjs"),
    resolve(root, "src/server/main.ts"),
    "--port",
    "0",
    "--data-dir",
    data,
    "--ready-file",
    readyPath,
    "--root",
    root,
  ],
  { cwd: evidenceDir, env, stdio: ["ignore", "pipe", "pipe"] },
);
const exit = once(child, "exit");
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});
let ready, hookServer;
async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("打包 smoke 等待超时");
}
const evidence = { passed: false, runtime, inference: false };
try {
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("打包服务提前退出");
    try {
      ready = JSON.parse(await readFile(readyPath, "utf8"));
      return true;
    } catch {
      return false;
    }
  });
  assert.equal(ready.pid, child.pid);
  assert.equal(ready.protocolVersion, 1);
  assert.equal(ready.url, `http://127.0.0.1:${ready.port}`);
  assert.notEqual(ready.port, 4317);
  assert.equal((await stat(readyPath)).mode & 0o777, 0o600);
  const headers = { Authorization: `Bearer ${ready.token}` };
  assert.equal((await fetch(ready.url + "/api/state")).status, 401);
  const state = await (
    await fetch(ready.url + "/api/state", { headers })
  ).json();
  assert.equal(state.project, undefined);
  assert.equal(state.agents.length, 0);
  assert.equal(state.userRequests.length, 0);
  const page = await fetch(ready.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await fetch(ready.url + asset)).status, 200);
  assert.deepEqual(
    await (
      await fetch(
        ready.url +
          "/api/desktop/origin?origin=" +
          encodeURIComponent(ready.url),
        { headers },
      )
    ).json(),
    { allowed: true },
  );
  assert.deepEqual(
    await (
      await fetch(
        ready.url + "/api/desktop/origin?origin=http%3A%2F%2F127.0.0.1%3A1",
        { headers },
      )
    ).json(),
    { allowed: false },
  );
  // Exercise the packaged native module and spawn-helper using the embedded runtime.
  const ptyCode = String.raw`
    import { createRequire } from 'node:module';
    import assert from 'node:assert/strict';
    const require = createRequire(process.argv[1] + '/package.json');
    const pty = require('node-pty');
    const term = pty.spawn('/bin/cat', [], { cols: 80, rows: 24, cwd: process.cwd(), env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' } });
    let text = '', stopped = false;
    const timeout = setTimeout(() => { term.kill(); process.exitCode = 1; }, 5000);
    term.onData(chunk => { text += chunk; if (!stopped && text.includes('打包 PTY ok')) { stopped = true; term.resize(100, 28); term.kill(); } });
    term.onExit(() => { clearTimeout(timeout); assert.ok(stopped); assert.ok(text.includes('打包 PTY ok')); console.log('PTY passed'); });
    term.write('打包 PTY ok\n');
  `;
  const ptyResult = await exec(
    node,
    ["--input-type=module", "-e", ptyCode, root],
    { cwd: evidenceDir, env, timeout: 10000 },
  );
  assert.match(ptyResult.stdout, /PTY passed/);
  let hooks = 0;
  hookServer = createServer((req, res) => {
    assert.equal(req.url, "/api/hooks");
    hooks++;
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ messages: [] }));
  });
  await new Promise((done) => hookServer.listen(0, "127.0.0.1", done));
  const hookUrl = `http://127.0.0.1:${hookServer.address().port}`;
  const pendingHook = exec(
    node,
    [resolve(root, "scripts/agent-hook.mjs"), "start", "claude"],
    {
      cwd: evidenceDir,
      env: {
        ...env,
        RELAY_URL: hookUrl,
        RELAY_AGENT_TOKEN: "isolated-fixture-token",
      },
      timeout: 5000,
    },
  );
  pendingHook.child.stdin.end("{}");
  const hook = await pendingHook;
  assert.deepEqual(JSON.parse(hook.stdout), {});
  assert.equal(hooks, 1);
  assert.ok(!output.includes(ready.token));
  evidence.startup = {
    readyPidMatches: true,
    privateReadyFile: true,
    authenticatedHttp: true,
    assets: true,
    noAutomaticImport: true,
    noAgents: true,
  };
  evidence.pty = { real: true, chineseOutput: true, resize: true, exit: true };
  evidence.hook = { packagedScript: true, fixtureEndpoint: true };
  child.kill("SIGTERM");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  const [code, signal] = await exit;
  assert.equal(code, 0);
  assert.equal(signal, null);
  await assert.rejects(stat(readyPath));
  await assert.rejects(stat(resolve(data, "server.lock")));
  await assert.rejects(fetch(ready.url));
  evidence.shutdown = {
    exitCode: code,
    readyRemoved: true,
    lockRemoved: true,
    portReleased: true,
  };
  evidence.passed = true;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
    ).catch(() => child.kill("SIGKILL"));
    await exit;
  }
  if (hookServer) await new Promise((done) => hookServer.close(done));
  await writeFile(
    resolve(evidenceDir, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
}
console.log(
  `打包服务 smoke 通过：${evidenceDir}/evidence.json（真实 Node/PTY；Hook 为夹具；未调用模型）。`,
);
