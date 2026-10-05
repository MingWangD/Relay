import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { createHttp } from "../src/server/http.ts";
import { resolve } from "node:path";

test("HTTP authentication, origin checks, and role separation", async (t) => {
  const f = await fixture();
  const app = await createHttp(f.service, { port: 0, root: resolve(".") });
  t.after(async () => {
    await app.close();
    await f.cleanup();
  });
  assert.equal((await fetch(app.url + "/api/state")).status, 401);
  const headers = { Authorization: `Bearer ${f.service.auth.consoleToken}` };
  assert.equal((await fetch(app.url + "/api/state", { headers })).status, 200);
  assert.equal(
    (
      await fetch(app.url + "/api/state", {
        headers: { ...headers, Origin: "https://attacker.invalid" },
      })
    ).status,
    403,
  );
  const id = f.agent();
  const token = f.service.auth.issue(id);
  assert.equal(
    (
      await fetch(app.url + "/api/state", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    403,
  );
  const tools = await fetch(app.url + "/api/tools", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool: "get_project_state",
      requestId: "1",
      arguments: {},
    }),
  });
  assert.equal(tools.status, 200);
  assert.equal((await tools.json()).agents[0].id, id);
});

test("invalid WebSocket credentials and cross-site origins cannot connect", async (t) => {
  const f = await fixture();
  const app = await createHttp(f.service, { port: 0, root: resolve(".") });
  t.after(async () => {
    await app.close();
    await f.cleanup();
  });
  const { default: WebSocket } = await import("ws");
  for (const [token, origin] of [
    ["invalid", app.url],
    [f.service.auth.consoleToken, "https://attacker.invalid"],
  ]) {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        app.url.replace("http:", "ws:") + "/ws",
        [`relay.${token}`],
        { origin },
      );
      ws.on("open", () => {
        ws.close();
        reject(new Error("unauthorized connection"));
      });
      ws.on("error", () => resolve());
    });
  }
  const { equal } = await import("../src/server/auth.ts");
  assert.equal(equal("é", "a"), false);
  assert.equal(equal("same", "same"), true);
});
