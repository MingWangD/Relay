import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fixture } from "./helpers.ts";
import { pickLocalPath } from "../src/server/local-picker.ts";
import { LocalProjects } from "../src/server/local-projects.ts";
import { createHttp } from "../src/server/http.ts";

// No native dialogs or model calls in these tests.
test("macOS picker handles paths, cancellation and errors without interpolating paths", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const folder = join(f.root, "中文 folder `echo` $x");
  await mkdir(folder);
  let script = "";
  const picked = await pickLocalPath(
    "folder",
    async (s) => {
      script = s;
      return folder + "/\n";
    },
    "darwin",
  );
  assert.equal(picked?.path, await realpath(folder));
  assert.match(script, /choose folder/);
  assert.ok(!script.includes(folder));
  assert.equal(
    await pickLocalPath(
      "folder",
      async () => {
        throw { stderr: "User canceled. (-128)" };
      },
      "darwin",
    ),
    null,
  );
  await assert.rejects(
    pickLocalPath(
      "folder",
      async () => {
        throw { stderr: "not authorized (-1743)" };
      },
      "darwin",
    ),
    /系统授权/,
  );
  await assert.rejects(
    pickLocalPath("folder", async () => folder, "linux"),
    /macOS/,
  );
  const file = join(folder, "test.txt");
  await writeFile(file, "x");
  await assert.rejects(
    pickLocalPath("folder", async () => file + "\n", "darwin"),
    /类型不匹配/,
  );
});

test("folder endpoint requires user and chat, serializes dialog, cancels without stored secrets or model calls", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let calls = 0,
    release!: (value: null) => void;
  const app = await createHttp(f.service, {
    port: 0,
    root: resolve("."),
    pickFolder: () => {
      calls++;
      return new Promise((r) => {
        release = r;
      });
    },
  });
  t.after(app.close);
  const body = { conversationId: f.store.state.defaultConversationId };
  const post = (token: string, data: unknown = body) =>
    fetch(app.url + "/api/project-folder", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  assert.equal((await post("invalid")).status, 401);
  assert.equal((await post(f.service.auth.issue("agent"))).status, 403);
  assert.equal(
    (await post(f.service.auth.consoleToken, { conversationId: "missing" }))
      .status,
    400,
  );
  assert.equal(
    (
      await post(f.service.auth.consoleToken, {
        conversationId: crypto.randomUUID(),
      })
    ).status,
    404,
  );
  assert.equal(calls, 0);
  const pending = post(f.service.auth.consoleToken);
  while (!release) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await post(f.service.auth.consoleToken)).status, 409);
  release(null);
  assert.deepEqual(await (await pending).json(), { cancelled: true });
  assert.equal(calls, 1);
  assert.equal(f.runtime.starts.length, 0);
  assert.deepEqual(f.store.state.requests, {});
});

test("native-selected folder endpoint validates paths and keeps user-only project isolation", async (t) => {
  const f = await fixture();
  const app = await createHttp(f.service, {
    port: 0,
    root: resolve("."),
    pickFolder: async () => {
      throw new Error("native path must bypass AppleScript");
    },
  });
  t.after(async () => {
    await app.close();
    await f.cleanup();
  });
  const post = (path: string, token = f.service.auth.consoleToken) =>
    fetch(app.url + "/api/project-folder", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversationId: f.store.state.defaultConversationId,
        path,
      }),
    });
  assert.equal((await post(f.repo, f.service.auth.issue("agent"))).status, 403);
  assert.equal((await post("invalid\0path")).status, 400);
  const file = join(f.root, "a.txt");
  await writeFile(file, "preserve");
  assert.equal((await post(file)).status, 400);
  assert.equal((await post(f.root)).status, 400);
  const selected = await post(f.repo);
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).url, app.url);
  assert.equal(f.runtime.starts.length, 0);
});

test("local projects isolate identities and authentication, reuse consoles and restore persisted history", async (t) => {
  const f = await fixture(),
    other = await fixture();
  f.agent("Codex 1");
  f.store.mutate((s) => {
    s.agents[0].model = "chosen";
    s.agents[0].boundSessionId = "old-native-id";
    s.agents[0].sessionCwd = f.repo;
    s.teamConfigured = true;
    s.conversations[0].teamConfigured = true;
  });
  const original = structuredClone(f.store.state);
  const projects = new LocalProjects(f.data, resolve("."));
  const app = await createHttp(f.service, {
    port: 0,
    root: resolve("."),
    projects,
  });
  let restoredProjects: LocalProjects | undefined;
  t.after(async () => {
    await restoredProjects?.close();
    await projects.close();
    await app.close();
    await other.cleanup();
    await f.cleanup();
  });
  const chatId = f.store.state.defaultConversationId;
  await assert.rejects(
    projects.open(other.root, f.service, chatId),
    /已有 Git 提交/,
  );
  assert.equal((await projects.open(f.repo, f.service, chatId)).url, app.url);
  const [a, b] = await Promise.all([
    projects.open(other.repo, f.service, chatId),
    projects.open(other.repo, f.service, chatId),
  ]);
  assert.equal(a.url, b.url);
  assert.notEqual(a.token, f.service.auth.consoleToken);
  const get = (token: string) =>
    fetch(a.url + "/api/state", {
      headers: { Authorization: "Bearer " + token },
    });
  assert.equal((await get(f.service.auth.consoleToken)).status, 401);
  const state = await (await get(a.token)).json();
  const checkOrigin = (origin: string, token = f.service.auth.consoleToken) =>
    fetch(
      app.url + "/api/desktop/origin?origin=" + encodeURIComponent(origin),
      {
        headers: { Authorization: "Bearer " + token },
      },
    );
  assert.equal((await checkOrigin(a.url, "invalid")).status, 401);
  assert.equal(
    (await checkOrigin(a.url, f.service.auth.issue("agent"))).status,
    403,
  );
  for (const origin of [app.url, a.url])
    assert.deepEqual(await (await checkOrigin(origin)).json(), {
      allowed: true,
    });
  for (const origin of [
    "http://127.0.0.1:1",
    "http://localhost:1",
    "https://example.com",
    a.url + "/",
    a.url + "?token=invalid",
  ])
    assert.deepEqual(await (await checkOrigin(origin)).json(), {
      allowed: false,
    });
  assert.equal(state.project.root, await realpath(other.repo));
  assert.equal(state.agents[0].model, "chosen");
  assert.notEqual(state.agents[0].id, original.agents[0].id);
  assert.ok(!state.agents[0].boundSessionId);
  assert.equal(state.userRequests.length, 0);
  assert.equal(state.runs.length, 0);
  assert.deepEqual(f.store.state, original);
  assert.equal(f.runtime.starts.length, 0);
  const create = await fetch(a.url + "/api/action", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + a.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId: "new-chat",
      action: "conversation-create",
      data: { conversationId: state.defaultConversationId },
    }),
  });
  assert.equal(create.status, 200);
  const added = await create.json();
  await assert.rejects(
    new LocalProjects(f.data, resolve(".")).open(other.repo, f.service, chatId),
    /已有服务/,
  );
  await projects.close();
  assert.deepEqual(await (await checkOrigin(a.url)).json(), { allowed: false });
  await assert.rejects(
    projects.open(other.repo, f.service, chatId),
    /服务正在关闭/,
  );
  restoredProjects = new LocalProjects(f.data, resolve("."));
  const restored = await restoredProjects.open(other.repo, f.service, chatId);
  const restoredState = await (
    await fetch(restored.url + "/api/state", {
      headers: { Authorization: "Bearer " + restored.token },
    })
  ).json();
  assert.equal(restoredState.project.id, state.project.id);
  assert.equal(restoredState.agents[0].id, state.agents[0].id);
  assert.ok(
    restoredState.conversations.some((c: { id: string }) => c.id === added.id),
  );
});

test("successful folder endpoint retains root project and returns authenticated isolated console", async (t) => {
  const f = await fixture(),
    other = await fixture();
  const app = await createHttp(f.service, {
    port: 0,
    root: resolve("."),
    pickFolder: async () => ({
      path: other.repo,
      name: "repo",
      kind: "folder",
    }),
  });
  t.after(async () => {
    await app.close();
    await other.cleanup();
    await f.cleanup();
  });
  const before = structuredClone(f.store.state);
  const response = await fetch(app.url + "/api/project-folder", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.service.auth.consoleToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversationId: f.store.state.defaultConversationId,
    }),
  });
  assert.equal(response.status, 200);
  const selected = await response.json();
  assert.notEqual(selected.url, app.url);
  const state = await (
    await fetch(selected.url + "/api/state", {
      headers: { Authorization: "Bearer " + selected.token },
    })
  ).json();
  assert.equal(state.project.root, await realpath(other.repo));
  assert.deepEqual(f.store.state, before);
  assert.equal(f.runtime.starts.length, 0);
});
