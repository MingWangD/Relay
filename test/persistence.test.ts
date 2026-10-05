import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture } from "./helpers.ts";
import { Store } from "../src/server/store.ts";
import { Service } from "../src/server/service.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("SQLite reopen preserves requests, tasks and unknown outcomes without redispatch", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = f.task(f.agent());
  const response = await f.service.request(
    "user",
    "persisted",
    { name: "a" },
    async () => ({ id }),
  );
  f.store.mutate((s) => {
    // Emulate the previous JSON schema with its former concurrency range.
    delete (s as Partial<typeof s>).userRequests;
    delete (s as Partial<typeof s>).chat;
    s.concurrency = 8;
    s.requests["user:interrupted"] = {
      hash: "anything",
      result: { pending: true },
    };
  });
  const reopened = new Store(join(f.data, "state.sqlite"));
  t.after(() => reopened.close());
  const service = new Service(
    reopened,
    f.service.auth,
    f.service.work,
    f.runtime,
    false,
  );
  service.recover();
  const again = await service.request(
    "user",
    "persisted",
    { name: "a" },
    async () => {
      throw new Error("must not execute");
    },
  );
  assert.deepEqual(again, response);
  assert.equal(reopened.state.tasks[0].id, id);
  assert.equal(reopened.state.paused, true);
  assert.equal(reopened.state.concurrency, 4);
  assert.deepEqual(reopened.state.userRequests, []);
  assert.deepEqual(reopened.state.chat, []);
  assert.equal(f.runtime.starts.length, 0);
  assert.deepEqual(reopened.state.requests["user:interrupted"].result, {
    pending: true,
  });
});

test("legacy chat migration persists one identity immediately and binds only reported native sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "legacy.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE state(id INTEGER PRIMARY KEY,data TEXT NOT NULL)");
  db.prepare("INSERT INTO state VALUES(1,?)").run(
    JSON.stringify({
      revision: 0,
      userRequests: [
        {
          id: "old-request",
          text: "历史",
          status: "completed",
          createdAt: new Date().toISOString(),
          agentIds: ["old-agent"],
          version: 1,
          rounds: 1,
        },
      ],
      chat: [],
      agents: [
        {
          id: "old-agent",
          name: "旧成员",
          provider: "claude",
          role: "团队成员",
          status: "stopped",
          manual: false,
          sessionId: "reported-native",
          cwd: "/old/stable/path",
        },
      ],
      tasks: [],
      messages: [],
      runs: [],
      tests: [],
      events: [],
      approvals: [],
      requests: {},
      paused: true,
      concurrency: 4,
    }),
  );
  db.close();
  const first = new Store(path);
  const id = first.state.defaultConversationId;
  assert.equal(first.state.conversations[0].title, "现有对话");
  assert.equal(first.state.conversations[0].permissionMode, "native");
  assert.equal(first.state.agents[0].boundSessionId, "reported-native");
  assert.equal(first.state.agents[0].sessionCwd, "/old/stable/path");
  assert.equal(first.state.userRequests[0].conversationId, id);
  first.close();
  const second = new Store(path);
  assert.equal(second.state.defaultConversationId, id);
  assert.equal(second.state.conversations.length, 1);
  assert.deepEqual(second.state.userRequests[0].members, [
    { id: "old-agent", provider: "claude" },
  ]);
  second.close();
});
