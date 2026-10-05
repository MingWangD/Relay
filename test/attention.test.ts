import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nativeAttention,
  nativeConnectionError,
} from "../src/server/runtime.ts";

test("native permission wording is only a transient UI hint", () => {
  assert.ok(nativeAttention("\x1b[32mTrust this folder?\x1b[0m"));
  assert.ok(
    nativeAttention("Read: /fixture/check.cjs\nAllow access to this file?"),
  );
  assert.equal(
    nativeAttention(
      "Allow calling this tool?\nCalling MCP tool relay/get_project_state\n> Plan mode: research & plan only",
    ),
    undefined,
  );
  assert.equal(nativeAttention("Task complete: all tests passed"), undefined);
  assert.equal(nativeAttention("Generating..."), undefined);
});

test("Claude risk confirmation and connection retries remain human-readable, separate from completion", () => {
  assert.match(
    nativeAttention("WARNING: Bypass Permissions mode\nYes, I accept")!,
    /风险声明/,
  );
  assert.match(
    nativeConnectionError(
      "Connection dropped (ECONNRESET) · Retrying in 7s · attempt 6/10",
    )!,
    /模型连接中断/,
  );
  assert.equal(nativeConnectionError("Generating..."), undefined);
});
