import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { writeFile, readFile, rm, symlink, cp } from "node:fs/promises";
import { fixture, until } from "./helpers.ts";
import { visionChallenge } from "../src/server/vision.ts";
import { imageType, IMAGE_LIMIT } from "../src/server/attachments.ts";
import { createHttp } from "../src/server/http.ts";
import { Store } from "../src/server/store.ts";
import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";
const png = () => visionChallenge().bytes;

test("failed attachment commit publishes nothing and removes newly written binary", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const db = new DatabaseSync(join(f.data, "state.sqlite"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_image BEFORE UPDATE ON state BEGIN SELECT RAISE(FAIL,'fixture image failure'); END",
  );
  const before = f.store.publicMessage();
  let events = 0;
  f.store.on("change", () => events++);
  await assert.rejects(
    () =>
      f.service.attachments.upload(
        f.store.state.defaultConversationId,
        "image.png",
        png(),
      ),
    /fixture image failure/,
  );
  assert.equal(events, 0);
  assert.equal(f.store.publicMessage(), before);
  assert.deepEqual(await readdir(join(f.data, "attachments")), []);
  db.exec("DROP TRIGGER fail_image");
});

test("binary upload requires user credentials and actual supported image format", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const app = await createHttp(f.service, { port: 0, root: resolve(".") });
  t.after(app.close);
  const url =
    app.url +
    "/api/attachments?conversationId=" +
    f.store.state.defaultConversationId;
  const headers = {
    Authorization: `Bearer ${f.service.auth.consoleToken}`,
    "Content-Type": "application/octet-stream",
    "X-Relay-Filename": encodeURIComponent("截图.png"),
  };
  assert.equal((await fetch(url, { method: "POST", body: png() })).status, 401);
  const bytes = png(),
    response = await fetch(url, { method: "POST", headers, body: bytes });
  assert.equal(response.status, 201);
  const item = await response.json();
  assert.equal(item.filename, "截图.png");
  assert.equal(item.mimeType, "image/png");
  assert.equal(item.path, `attachments/${item.id}`);
  const read = await fetch(
    app.url +
      `/api/attachments/${item.id}?conversationId=${item.conversationId}`,
    { headers },
  );
  assert.equal(read.headers.get("content-type"), "image/png");
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers,
        body: Buffer.from('<svg onload="x"/>'),
      })
    ).status,
    400,
  );
  const agent = f.agent();
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          Authorization: `Bearer ${f.service.auth.issue(agent)}`,
        },
        body: bytes,
      })
    ).status,
    403,
  );
  assert.throws(() => imageType(Buffer.alloc(IMAGE_LIMIT + 1)), /10 MiB/);
  assert.throws(() => imageType(Buffer.from([255, 216, 255, 217])), /PNG/);
  assert.throws(() => imageType(bytes.subarray(0, -1)), /完整/);
});

test("binding is atomic, scoped, limited and sent images survive restart and import", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const chat = f.store.state.defaultConversationId,
    id = f.agent();
  const bytes = png(),
    item = await f.service.attachments.upload(chat, "../../image.png", bytes);
  const other = f.service.collaboration.createConversation().id;
  assert.throws(
    () =>
      f.store.mutate((s) =>
        f.service.attachments.bind(s, other, [item.id], "bad"),
      ),
    /当前聊天/,
  );
  assert.throws(
    () =>
      f.store.mutate((s) =>
        f.service.attachments.bind(s, chat, [item.id, item.id], "bad"),
      ),
    /重复/,
  );
  assert.throws(
    () => f.service.collaboration.submit("图", chat, [item.id]),
    /视觉成员/,
  );
  const request = f.service.collaboration.submit("图", chat, [item.id], id);
  f.store.mutate((s) => (s.paused = true));
  assert.deepEqual(f.store.state.chat[0].attachmentIds, [item.id]);
  assert.equal(f.store.state.attachments![0].requestId, request.id);
  await assert.rejects(
    () =>
      f.service.collaboration.supplement(
        "duplicate image",
        chat,
        [item.id],
        id,
      ),
    /已发送/,
  );
  await assert.rejects(
    () => f.service.attachments.remove(item.id, chat),
    /不能单独删除/,
  );
  assert.throws(
    () => f.service.collaboration.submit("再次", chat, [item.id], id),
    /已发送/,
  );
  assert.equal(f.store.state.userRequests.length, 1);
  const copy = join(f.root, "imported");
  await cp(f.data, copy, { recursive: true });
  const store = new Store(join(copy, "state.sqlite"));
  t.after(() => store.close());
  const { Attachments } = await import("../src/server/attachments.ts");
  const attachments = new Attachments(store, copy);
  assert.deepEqual((await attachments.read(item.id, chat)).bytes, bytes);
  assert.equal(store.state.agents[0].id, id);
  const reopened = new Store(join(f.data, "state.sqlite"));
  t.after(() => reopened.close());
  assert.deepEqual(reopened.state.userRequests[0].attachmentIds, [item.id]);
});

test("file tampering, symlinks, expired uploads and committed chat deletion are handled", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const chat = f.store.state.defaultConversationId;
  const item = await f.service.attachments.upload(chat, "image.png", png());
  const path = join(f.data, item.path);
  await writeFile(path, Buffer.alloc(item.size));
  await assert.rejects(
    () => f.service.attachments.read(item.id, chat),
    /校验失败/,
  );
  await rm(path);
  await symlink(join(f.repo, "hello.txt"), path);
  await assert.rejects(() => f.service.attachments.read(item.id, chat), /替换/);
  await rm(path);
  const expired = await f.service.attachments.upload(
    chat,
    "expired.png",
    png(),
  );
  f.store.mutate((s) => {
    s.attachments!.find((a) => a.id === expired.id)!.createdAt = new Date(
      Date.now() - 90000000,
    ).toISOString();
  });
  await f.service.attachments.cleanup();
  assert.ok(!f.store.state.attachments!.some((a) => a.id === expired.id));
  await assert.rejects(() => readFile(join(f.data, expired.path)));
  const current = await f.service.attachments.upload(
    chat,
    "current.png",
    png(),
  );
  await f.service.collaboration.deleteConversation(chat);
  assert.deepEqual(f.store.state.attachments, []);
  await assert.rejects(() => readFile(join(f.data, current.path)));
});

test("vision stage gates planning, requires real image reads and persists supplemental batches", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const reader = f.agent("Vision"),
    other = f.agent("Text"),
    chat = f.store.state.defaultConversationId;
  f.service.visionFor = async (a) => ({
    status: a.provider === "codex" ? "supported" : "unknown",
    source: "test fixture",
  });
  const item = await f.service.attachments.upload(chat, "one.png", png());
  const { id } = f.service.collaboration.submit(
    "识图",
    chat,
    [item.id],
    reader,
  );
  await until(() => f.store.state.userRequests[0].control?.kind === "vision");
  await until(() => f.runtime.starts.length > 0);
  const request = f.store.state.userRequests[0],
    batch = request.vision!.batches[0];
  assert.equal(request.coordinatorId, reader);
  assert.ok(f.runtime.starts[0].images?.includes(join(f.data, item.path)));
  await assert.rejects(
    () => f.service.collaboration.publish(reader, 0, []),
    /图片分析/,
  );
  await assert.rejects(
    () => f.service.collaboration.readAttachment(other, item.id),
    /不能读取/,
  );
  const result = await f.service.collaboration.readAttachment(reader, item.id);
  assert.equal(result.content[0].type, "image");
  assert.equal(
    result.content[0].data,
    (await readFile(join(f.data, item.path))).toString("base64"),
  );
  assert.throws(
    () => f.service.collaboration.ask(reader, "下一张"),
    /先用 submit_vision_analysis/,
  );
  f.service.collaboration.submitVision(reader, id, batch.id, "图片分析");
  assert.equal(
    f.store.state.userRequests[0].vision!.batches[0].status,
    "completed",
  );
  const next = await f.service.attachments.upload(chat, "two.png", png());
  await f.service.collaboration.supplement("新图", chat, [next.id], reader);
  assert.equal(f.store.state.userRequests[0].vision!.batches.length, 2);
  assert.equal(
    f.store.state.userRequests[0].vision!.batches[1].status,
    "pending",
  );
  assert.equal(
    f.store.state.agents.find((a) => a.id === reader)!.boundSessionId,
    `session-${reader}`,
  );
  f.service.recover();
  assert.equal(f.store.state.paused, true);
  assert.equal(
    f.store.state.userRequests[0].vision!.batches[1].status,
    "pending",
  );
});

test("MCP image responses bypass persisted idempotency cache and reject stale generation", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const reader = f.agent(),
    chat = f.store.state.defaultConversationId,
    item = await f.service.attachments.upload(chat, "image.png", png()),
    request = f.service.collaboration.submit("图", chat, [item.id], reader);
  const generation = crypto.randomUUID();
  f.store.mutate((s) => {
    s.paused = true;
    s.activeRequestId = request.id;
    const a = s.agents[0];
    a.generation = generation;
    a.status = "idle";
    s.userRequests[0].vision!.batches[0].status = "running";
  });
  const app = await createHttp(f.service, { port: 0, root: resolve(".") });
  t.after(app.close);
  const token = f.service.auth.issue(reader);
  const call = (g: string) =>
    fetch(app.url + "/api/tools", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tool: "read_attachment",
        generation: g,
        requestId: "image-read",
        arguments: { attachmentId: item.id },
      }),
    });
  assert.equal((await call(crypto.randomUUID())).status, 409);
  const response = await call(generation);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].type, "image");
  assert.ok(
    !Object.keys(f.store.state.requests).some((k) => k.includes("image-read")),
  );
  f.service.auth.revoke(reader);
  assert.equal((await call(generation)).status, 401);
});
