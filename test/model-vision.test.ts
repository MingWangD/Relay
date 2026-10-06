import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCatalog } from "../src/server/models.ts";
test("Codex native modalities, old compatibility and custom gateway stay distinct; configuration changes invalidate catalog cache", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-model-vision-")),
    bin = join(root, "bin");
  await mkdir(bin);
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = ["PATH", "OPENAI_BASE_URL", "RELAY_FIXTURE_MODALITIES"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  });
  const script = join(bin, "codex");
  await writeFile(
    script,
    `#!${process.execPath}
import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(!m.id)continue;let result={};if(m.method==='config/read')result={config:{model:'configured',model_provider:'openai'}};if(m.method==='model/list')result={data:[{model:'configured',displayName:'Configured',...(process.env.RELAY_FIXTURE_MODALITIES==='old'?{}:{inputModalities:['text']}),isDefault:true}],nextCursor:null};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}
`,
  );
  await chmod(script, 0o700);
  process.env.PATH = bin + ":" + old.PATH;
  delete process.env.OPENAI_BASE_URL;
  let catalog = await modelCatalog("codex", root, true);
  assert.equal(catalog.models[0].vision?.status, "unsupported");
  assert.equal(catalog.defaultModelId, "configured");
  process.env.RELAY_FIXTURE_MODALITIES = "old";
  catalog = await modelCatalog("codex", root, true);
  assert.equal(catalog.models[0].vision?.status, "supported");
  assert.match(catalog.models[0].vision!.source, /兼容/);
  process.env.OPENAI_BASE_URL = "https://custom.invalid/v1";
  catalog = await modelCatalog("codex", root);
  assert.equal(catalog.models[0].vision?.status, "unknown");
  assert.match(catalog.models[0].vision!.source, /自定义/);
});
