import { strict as assert } from "node:assert";
import { mkdtemp, readFile, stat, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseServerOptions,
  removeReadyFile,
  writeReadyFile,
} from "../src/server/desktop.ts";

test("desktop flags preserve npm start defaults and accept an ephemeral port", () => {
  const options = parseServerOptions(
    [
      "--port",
      "0",
      "--data-dir",
      "/tmp/relay-data",
      "--ready-file",
      "/tmp/relay.ready",
    ],
    {},
    "/repo",
  );
  assert.equal(options.port, 0);
  assert.equal(options.dataDir, "/tmp/relay-data");
  assert.equal(options.readyFile, "/tmp/relay.ready");
  assert.equal(options.root, "/repo");
  assert.equal(options.dev, false);
});

test("ready envelope is atomically written with private permissions and removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-ready-"));
  const path = join(dir, "nested", "ready.json");
  try {
    await writeReadyFile(path, {
      protocolVersion: 1,
      pid: process.pid,
      port: 43217,
      url: "http://127.0.0.1:43217",
      token: "memory-only-test-token",
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      protocolVersion: 1,
      pid: process.pid,
      port: 43217,
      url: "http://127.0.0.1:43217",
      token: "memory-only-test-token",
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await removeReadyFile(path);
    await assert.rejects(stat(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ready envelope rejects non-local URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-ready-invalid-"));
  try {
    await assert.rejects(
      writeReadyFile(join(dir, "ready.json"), {
        protocolVersion: 1,
        pid: process.pid,
        port: 443,
        url: "https://example.com:443",
        token: "secret",
      }),
      /本机地址/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ready files never change permissions on an existing parent directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-ready-parent-"));
  try {
    await chmod(dir, 0o755);
    await writeReadyFile(join(dir, "ready.json"), {
      protocolVersion: 1,
      pid: process.pid,
      port: 43217,
      url: "http://127.0.0.1:43217",
      token: "test-token",
    });
    assert.equal((await stat(dir)).mode & 0o777, 0o755);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ready files reject embedded credentials, paths and mismatched process identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-ready-fields-"));
  try {
    const envelope = {
      protocolVersion: 1 as const,
      pid: process.pid,
      port: 43217,
      url: "http://127.0.0.1:43217",
      token: "test-token",
    };
    for (const url of [
      "http://user@127.0.0.1:43217",
      envelope.url + "/other",
      envelope.url + "?token=secret",
      envelope.url + "#token=secret",
    ])
      await assert.rejects(
        writeReadyFile(join(dir, "ready.json"), { ...envelope, url }),
      );
    for (const fields of [{ pid: 0 }, { token: "" }])
      await assert.rejects(
        writeReadyFile(join(dir, "ready.json"), { ...envelope, ...fields }),
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
