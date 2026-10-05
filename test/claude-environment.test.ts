import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeEnvironmentResolver,
  readClaudeShellEnvironment,
  withClaudeEnvironment,
} from "../src/server/claude-environment.ts";
import { modelCatalog } from "../src/server/models.ts";

test("desktop Claude environment caches, refreshes and preserves explicit overrides without copying other secrets", async () => {
  let reads = 0;
  const resolver = new ClaudeEnvironmentResolver(async () => {
    reads++;
    return {
      ANTHROPIC_MODEL: `shell-model-${reads}`,
      ANTHROPIC_AUTH_TOKEN: "fixture-token",
      OTHER_SECRET: "omit",
    };
  });
  assert.deepEqual(await resolver.resolve({ ANTHROPIC_MODEL: "browser" }), {
    environment: { ANTHROPIC_MODEL: "browser" },
  });
  assert.equal(reads, 0);
  const desktop = { RELAY_DESKTOP: "1" };
  const [a, b] = await Promise.all([
    resolver.resolve(desktop),
    resolver.resolve(desktop),
  ]);
  assert.equal(reads, 1);
  assert.deepEqual(a, b);
  assert.equal(a.environment.ANTHROPIC_MODEL, "shell-model-1");
  assert.ok(!("OTHER_SECRET" in a.environment));
  const finder = await resolver.resolve({
    ...desktop,
    RELAY_CLAUDE_ENV_EXPLICIT: "0",
    ANTHROPIC_MODEL: "stale-launchservices-model",
    ANTHROPIC_API_KEY: "stale",
  });
  assert.equal(finder.environment.ANTHROPIC_MODEL, "shell-model-1");
  const child = withClaudeEnvironment(
    { ANTHROPIC_API_KEY: "stale", PATH: "/bin" },
    finder.environment,
  );
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.PATH, "/bin");
  assert.equal(
    (
      await resolver.resolve({
        ...desktop,
        ANTHROPIC_MODEL: "explicit",
        ANTHROPIC_AUTH_TOKEN: "",
      })
    ).environment.ANTHROPIC_AUTH_TOKEN,
    "",
  );
  assert.equal(
    (await resolver.resolve(desktop, true)).environment.ANTHROPIC_MODEL,
    "shell-model-2",
  );
});

test("shell failures return a safe warning and remain refreshable", async () => {
  let failing = true;
  const resolver = new ClaudeEnvironmentResolver(async () => {
    if (failing) throw new Error("private credentials must never escape");
    return { ANTHROPIC_MODEL: "restored" };
  });
  const environment = { RELAY_DESKTOP: "1", ANTHROPIC_MODEL: "fallback" };
  const failed = await resolver.resolve(environment);
  assert.equal(failed.environment.ANTHROPIC_MODEL, "fallback");
  assert.match(failed.warning!, /刷新/);
  assert.ok(!JSON.stringify(failed).includes("private"));
  failing = false;
  assert.equal(
    (await resolver.resolve({ RELAY_DESKTOP: "1" }, true)).environment
      .ANTHROPIC_MODEL,
    "restored",
  );
});

test("real shell extraction tolerates banners, quotes and whitespace paths; hung profiles are bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay shell ' 中文-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = join(root, "shell");
  await writeFile(
    shell,
    '#!/bin/sh\nprintf "startup banner\\n"\nexport ANTHROPIC_MODEL="configured-model"\nexport OTHER_SECRET="omit"\nexec /bin/sh -c "$2"\n',
    { mode: 0o755 },
  );
  const environment = await readClaudeShellEnvironment({ SHELL: shell });
  assert.equal(environment.ANTHROPIC_MODEL, "configured-model");
  assert.ok(!("OTHER_SECRET" in environment));
  const finder = await new ClaudeEnvironmentResolver().resolve({
    SHELL: shell,
    RELAY_DESKTOP: "1",
    RELAY_CLAUDE_ENV_EXPLICIT: "0",
    ANTHROPIC_API_KEY: "stale-launchservices-key",
  });
  assert.equal(finder.environment.ANTHROPIC_MODEL, "configured-model");
  assert.equal(finder.environment.ANTHROPIC_API_KEY, undefined);
  const hung = join(root, "hung");
  await writeFile(hung, "#!/bin/sh\n/bin/sleep 20\n", { mode: 0o755 });
  const start = Date.now();
  await assert.rejects(
    readClaudeShellEnvironment({ SHELL: hung }, 100),
    /未能读取/,
  );
  assert.ok(Date.now() - start < 1500);
  await assert.rejects(
    readClaudeShellEnvironment({ SHELL: join(root, "missing") }),
    /未能读取/,
  );
});

test("desktop catalog discovers shell model and custom config directory, then refreshes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"),
    config = join(root, "config");
  await mkdir(bin);
  await mkdir(config);
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({ model: "configured-in-file" }),
  );
  await writeFile(
    join(bin, "claude"),
    '#!/bin/sh\nprintf "%s\\n" "--effort low medium high"\n',
    { mode: 0o755 },
  );
  const shell = join(root, "shell");
  const writeShell = (model: string) =>
    writeFile(
      shell,
      `#!/bin/sh\nexport ANTHROPIC_MODEL=${model}\nexport CLAUDE_CONFIG_DIR='${config}'\nexec /bin/sh -c "$2"\n`,
      { mode: 0o755 },
    );
  await writeShell("shell-first");
  const original = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.CLAUDE_CONFIG_DIR;
  Object.assign(process.env, {
    RELAY_DESKTOP: "1",
    SHELL: shell,
    PATH: `${bin}:/usr/bin:/bin`,
  });
  const first = await modelCatalog("claude", root, true);
  assert.equal(first.error, undefined);
  for (const id of ["shell-first", "configured-in-file"])
    assert.ok(first.models.some((m) => m.id === id));
  await writeShell("shell-second");
  const second = await modelCatalog("claude", root, true);
  assert.ok(second.models.some((m) => m.id === "shell-second"));
  assert.ok(!second.models.some((m) => m.id === "shell-first"));
  assert.equal(process.env.ANTHROPIC_MODEL, undefined);
});
