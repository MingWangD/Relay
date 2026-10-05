import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./helpers.ts";
import { createHttp } from "../src/server/http.ts";

test("real MCP stdio transport enforces per-agent identity through HTTP bridge", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = f.agent("A"),
    b = f.agent("B");
  const http = await createHttp(f.service, { port: 0, root: resolve(".") });
  t.after(http.close);
  const client = new Client({ name: "integration-test", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      resolve("node_modules/tsx/dist/loader.mjs"),
      resolve("src/server/mcp.ts"),
    ],
    env: {
      ...(process.env as Record<string, string>),
      RELAY_URL: http.url,
      RELAY_AGENT_TOKEN: f.service.auth.issue(a),
      RELAY_AGENT_ID: a,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "submit_result"));
  const sent = await client.callTool({
    name: "send_message",
    arguments: { targetId: b, text: "从真实 MCP 传输送出" },
  });
  assert.ok(!sent.isError);
  assert.equal(f.store.state.messages[0].sourceId, a);
  assert.equal(f.store.state.messages[0].targetId, b);
  const wrong = await client.callTool({
    name: "ack_message",
    arguments: { messageId: f.store.state.messages[0].id },
  });
  assert.equal(wrong.isError, true);
});

test("global Antigravity plugin exposes no tools outside a Relay session", async (t) => {
  const client = new Client({ name: "unscoped-test", version: "1.0" });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => !key.startsWith("RELAY_") && value !== undefined,
    ),
  ) as Record<string, string>;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("src/server/mcp.ts"),
      ],
      env,
      stderr: "pipe",
    }),
  );
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 0);
});
