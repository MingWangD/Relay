import { randomBytes, randomInt, createHash, createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeEnvironment } from "./claude-environment.ts";
import { modelCatalog } from "./models.ts";
import type { Agent, VisionCapability, Provider } from "../shared/types.ts";
const verified = new Map<
  string,
  { value: VisionCapability; identity: string }
>();
const salt = randomBytes(32);
export async function configurationIdentity(provider: Provider, root: string) {
  const hmac = createHmac("sha256", salt).update(provider);
  const env =
    provider === "claude"
      ? (await claudeEnvironment.resolve(process.env)).environment
      : process.env;
  hmac.update(env.PATH ?? "");
  const executable={codex:"codex",claude:"claude",antigravity:"agy"}[provider];
  for(const directory of (env.PATH ?? "").split(":")) {
    if(!directory)continue;
    try {const path=join(directory,executable),file=await stat(path);if(!file.isFile())continue;hmac.update(path).update(String(file.mtimeMs)).update(String(file.size));break;}catch{}
  }
  for (const name of Object.keys(env)
    .filter((k) =>
      /^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|GEMINI_|GOOGLE_)/.test(k),
    )
    .sort())
    hmac
      .update(name)
      .update("\0")
      .update(env[name] ?? "");
  const paths =
    provider === "claude"
      ? [
          join(
            env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
            "settings.json",
          ),
          join(root, ".claude/settings.json"),
          join(root, ".claude/settings.local.json"),
          join(
            env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
            ".credentials.json",
          ),
        ]
      : provider === "codex"
        ? [
            join(
              process.env.CODEX_HOME ?? join(homedir(), ".codex"),
              "config.toml",
            ),
            join(
              process.env.CODEX_HOME ?? join(homedir(), ".codex"),
              "auth.json",
            ),
            join(root, ".codex/config.toml"),
          ]
        : [
            join(homedir(), ".gemini/settings.json"),
            join(homedir(), ".gemini/oauth_creds.json"),
            join(root, ".gemini/settings.json"),
          ];
  for (const path of paths) {
    try {
      hmac.update(await readFile(path));
    } catch {}
  }
  return hmac.digest("hex");
}
const key = (provider: Provider, model: string | undefined, root: string) =>
  `${root}:${provider}:${model ?? "default"}`;
export function forgetVision(provider: Provider, root: string) {
  for (const k of verified.keys())
    if (k.startsWith(`${root}:${provider}:`)) verified.delete(k);
}
export function recordVision(
  provider: Provider,
  model: string | undefined,
  root: string,
  supported: boolean,
  identity: string,
) {
  const value: VisionCapability = {
    status: supported ? "supported" : "unsupported",
    source: "本次运行的独立图片识别验证",
  };
  verified.set(key(provider, model, root), { value, identity });
  return value;
}
export async function checkedVision(
  provider: Provider,
  model: string | undefined,
  root: string,
) {
  const entry = verified.get(key(provider, model, root));
  if (!entry) return undefined;
  return entry?.identity === (await configurationIdentity(provider, root))
    ? entry.value
    : undefined;
}
export async function modelVision(
  agent: Pick<Agent, "provider" | "model">,
  root: string,
): Promise<VisionCapability> {
  const checked = await checkedVision(agent.provider, agent.model, root);
  if (checked) return checked;
  const catalog = await modelCatalog(agent.provider, root);
  const choice = catalog.models.find(
    (m) => m.id === (agent.model ?? catalog.defaultModelId),
  );
  return (
    choice?.vision ?? {
      status: "unknown",
      source: "当前模型未提供视觉能力信息；需独立验证",
    }
  );
}
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Buffer) {
  const label = Buffer.from(type);
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length);
  label.copy(out, 4);
  bytes.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([label, bytes])), 8 + bytes.length);
  return out;
}
// Answer exists only in memory. PNG metadata, filename and prompts never contain it.
export function visionChallenge() {
  const digits = [
    "11111/10001/10001/10001/10001/10001/11111",
    "00100/01100/00100/00100/00100/00100/01110",
    "11110/00001/00001/11110/10000/10000/11111",
    "11110/00001/00001/01110/00001/00001/11110",
    "10010/10010/10010/11111/00010/00010/00010",
    "11111/10000/10000/11110/00001/00001/11110",
    "01111/10000/10000/11110/10001/10001/01110",
    "11111/00001/00010/00100/01000/01000/01000",
    "01110/10001/10001/01110/10001/10001/01110",
    "01110/10001/10001/01111/00001/00001/11110",
  ];
  const answer = Array.from({ length: 6 }, () => randomInt(10)).join("");
  const scale = 8,
    width = 320,
    height = 88,
    stride = width * 3 + 1,
    pixels = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  [...answer].forEach((digit, index) =>
    digits[Number(digit)].split("/").forEach((row, y) =>
      [...row].forEach((bit, x) => {
        if (bit !== "1") return;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const at =
              (16 + y * scale + dy) * stride +
              1 +
              (16 + index * 48 + x * scale + dx) * 3;
            pixels[at] = pixels[at + 1] = pixels[at + 2] = 16;
          }
      }),
    ),
  );
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return {
    answer,
    bytes,
    nonce: randomBytes(8).toString("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
