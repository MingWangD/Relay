import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import type { State, AppEvent } from "../shared/types.ts";
import { now } from "../shared/types.ts";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function ensure(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
export function redact(text: string): string {
  return text
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{16,})\b/g, "[REDACTED]")
    .replace(
      /((?:authorization|api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi,
      "$1[REDACTED]",
    );
}
export class Store extends EventEmitter {
  private db: DatabaseSync;
  private current: State;
  constructor(path: string) {
    super();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);",
    );
    const row = this.db.prepare("SELECT data FROM state WHERE id=1").get() as
      { data: string } | undefined;
    this.current = row
      ? JSON.parse(row.data)
      : {
          conversations: [],
          defaultConversationId: randomUUID(),
          revision: 0,
          userRequests: [],
          chat: [],
          agents: [],
          tasks: [],
          messages: [],
          runs: [],
          tests: [],
          events: [],
          approvals: [],
          paused: true,
          concurrency: 4,
          requests: {},
        };
    this.current.userRequests ??= [];
    this.current.chat ??= [];
    this.current.permissionMode ??= "native";
    this.current.defaultConversationId ??= randomUUID();
    this.current.conversations ??= [];
    if (!this.current.conversations.length)
      this.current.conversations.push({
        id: this.current.defaultConversationId,
        title: row ? "现有对话" : "新聊天",
        createdAt: now(),
        updatedAt: now(),
        permissionMode: this.current.permissionMode,
        teamConfigured: this.current.teamConfigured,
      });
    for (const a of this.current.agents) {
      a.conversationId ??= this.current.defaultConversationId;
      // Only an identity that was actually reported may be reused; keep its original cwd.
      if (a.sessionId && a.cwd) {
        a.boundSessionId ??= a.sessionId;
        a.sessionCwd ??= a.cwd;
      }
    }
    for (const r of this.current.userRequests)
      r.conversationId ??= this.current.defaultConversationId;
    for (const a of this.current.agents) a.permissionMode ??= "native";
    this.current.concurrency = Math.min(
      4,
      Math.max(1, this.current.concurrency ?? 4),
    );
    for (const r of this.current.userRequests)
      r.members ??= this.current.agents
        .filter((a) => r.agentIds.includes(a.id))
        .map(({ id, provider }) => ({ id, provider }));

    // Commit migration immediately so a read-only open/close cannot invent a new chat ID.
    const normalized = JSON.stringify(this.current);
    if (normalized !== row?.data)
      this.db
        .prepare(
          "INSERT INTO state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(normalized);
  }
  get state(): State {
    return structuredClone(this.current);
  }
  mutate<T>(fn: (state: State) => T): T {
    const next = this.state;
    const result = fn(next);
    next.userRequests ??= [];
    for (const request of next.userRequests)
      request.conversationId ??= next.defaultConversationId;
    for (const agent of next.agents)
      agent.conversationId ??= next.defaultConversationId;
    const requestsById = new Map(next.userRequests.map((r) => [r.id, r]));
    const agentsById = new Map(next.agents.map((a) => [a.id, a]));
    const tasksById = new Map(next.tasks.map((t) => [t.id, t]));
    for (const record of [
      ...next.tasks,
      ...next.messages,
      ...next.runs,
      ...next.tests,
      ...next.approvals,
      ...(next.chat ?? []),
    ]) {
      const item = record as {
        conversationId?: string;
        requestId?: string;
        ownerId?: string;
        agentId?: string;
        targetId?: string;
        taskId?: string;
      };
      item.conversationId ??=
        requestsById.get(item.requestId ?? "")?.conversationId ??
        agentsById.get(item.ownerId ?? item.agentId ?? item.targetId ?? "")
          ?.conversationId ??
        tasksById.get(item.taskId ?? "")?.conversationId ??
        next.defaultConversationId;
    }
    const previousRequests = new Map(
      this.current.userRequests.map((r) => [r.id, r]),
    );
    const previousAgents = new Map(this.current.agents.map((a) => [a.id, a]));
    const latestByConversation = new Map<string, string>();
    const changedConversations = new Set<string>();
    for (const request of next.userRequests) {
      const chatId = request.conversationId ?? next.defaultConversationId;
      const latest = request.control?.startedAt ?? request.createdAt;
      if (latest > (latestByConversation.get(chatId) ?? ""))
        latestByConversation.set(chatId, latest);
      if (
        JSON.stringify(request) !==
        JSON.stringify(previousRequests.get(request.id))
      )
        changedConversations.add(chatId);
    }
    for (const agent of next.agents)
      if (
        JSON.stringify(agent) !== JSON.stringify(previousAgents.get(agent.id))
      )
        changedConversations.add(
          agent.conversationId ?? next.defaultConversationId,
        );
    for (const c of next.conversations) {
      const latest = latestByConversation.get(c.id);
      if (latest && latest > c.updatedAt) c.updatedAt = latest;
      if (changedConversations.has(c.id)) c.updatedAt = now();
    }
    next.revision++;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(JSON.stringify(next));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.current = next;
    this.emit("change", this.publicState());
    return result;
  }
  publicState(): State {
    const result = this.state;
    result.requests = {};
    // Logs and model text may contain secrets. Terminal bytes are a separate, authenticated stream.
    return JSON.parse(redact(JSON.stringify(result)));
  }
  event(
    state: State,
    type: string,
    detail: string,
    ids: Partial<AppEvent> = {},
  ) {
    state.events.push({
      requestId: state.activeRequestId,
      ...ids,
      seq: (state.events.at(-1)?.seq ?? 0) + 1,
      type,
      at: now(),
      detail: redact(detail),
    });
  }
  close() {
    this.emit("closing");
    this.db.close();
  }
}
