import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkedVision,
  configurationIdentity,
  forgetVision,
  recordVision,
  visionChallenge,
} from "../src/server/vision.ts";
import { imageType } from "../src/server/attachments.ts";
test("capability probes are memory-only and invalidate when effective configuration changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-vision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = process.env.OPENAI_BASE_URL;
  t.after(() => {
    if (old === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = old;
  });
  const identity = await configurationIdentity("codex", root);
  recordVision("codex", "test-model", root, true, identity);
  assert.equal(
    (await checkedVision("codex", "test-model", root))?.status,
    "supported",
  );
  process.env.OPENAI_BASE_URL = "https://fixture.invalid";
  assert.equal(await checkedVision("codex", "test-model", root), undefined);
  recordVision(
    "codex",
    "test-model",
    root,
    false,
    await configurationIdentity("codex", root),
  );
  forgetVision("codex", root);
  assert.equal(await checkedVision("codex", "test-model", root), undefined);
});
test("random image challenge keeps expected digits outside PNG metadata", () => {
  const challenge = visionChallenge();
  assert.match(challenge.answer, /^\d{6}$/);
  assert.equal(imageType(challenge.bytes), "image/png");
  assert.ok(!challenge.bytes.includes(Buffer.from(challenge.answer)));
  assert.ok(!challenge.nonce.includes(challenge.answer));
});

import { fixture, TestRuntime, until } from "./helpers.ts";
import {
  verifyVision,
  visionTerminal,
  visionTerminalInput,
} from "../src/server/vision-check.ts";
test("stopping parent cancels isolated capability diagnostics, closes input and retains real member IDs", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const actual = f.agent(),
    runtime = new TestRuntime();
  const ids = f.store.state.agents.map((a) => a.id);
  const probe = verifyVision(
    f.service,
    { provider: "codex" },
    "full",
    () => runtime,
  );
  await until(() => runtime.starts.length > 0);
  const status = await visionTerminal(f.service, "codex");
  assert.equal(status.generation, "test");
  assert.throws(
    () =>
      visionTerminalInput(f.service, "codex", "stale", {
        manual: true,
        data: "yes",
      }),
    /已改变/,
  );
  await f.service.stopAll();
  const result = await probe;
  assert.equal(result.status, "unknown");
  assert.match(result.source, /已停止/);
  assert.equal(runtime.sessions.size, 0);
  await assert.rejects(() => visionTerminal(f.service, "codex"), /没有运行/);
  assert.deepEqual(
    f.store.state.agents.map((a) => a.id),
    ids,
  );
  assert.equal(
    f.store.state.agents.find((a) => a.id === actual)!.boundSessionId,
    undefined,
  );
});
