import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class Auth {
  consoleToken: string;
  private agents = new Map<string, string>();
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "console-token");
    try {
      this.consoleToken = readFileSync(path, "utf8").trim();
    } catch {
      this.consoleToken = secret();
      writeFileSync(path, this.consoleToken, { mode: 0o600 });
    }
  }
  issue(agentId: string) {
    const token = secret();
    this.agents.set(hash(token), agentId);
    return token;
  }
  revoke(agentId: string) {
    for (const [key, id] of this.agents)
      if (id === agentId) this.agents.delete(key);
  }
  discard(token: string) {
    this.agents.delete(hash(token));
  }
  actor(token: string): string | undefined {
    if (equal(token, this.consoleToken)) return "user";
    return this.agents.get(hash(token));
  }
}
