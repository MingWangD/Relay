export type Provider = "codex" | "antigravity" | "claude";
export type PermissionMode = "full" | "native";
export type ReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export interface MemberConfig {
  id?: string;
  provider: Provider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}
export type VisionCapability = {
  status: "supported" | "unsupported" | "unknown";
  source: string;
};
export interface Attachment {
  id: string;
  conversationId: string;
  requestId?: string;
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  sha256: string;
  path: string;
  createdAt: string;
}
export interface ModelChoice {
  vision?: VisionCapability;
  id: string;
  name: string;
  efforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}
export interface ModelCatalog {
  provider: Provider;
  models: ModelChoice[];
  source: string;
  error?: string;
  cliEfforts?: ReasoningEffort[];
  defaultModelId?: string;
  defaultVision?: VisionCapability;
}
export interface ApprovalPresentation {
  title: string;
  description?: string;
  fields: { label: string; value: string }[];
  supported: boolean;
}
export type TaskStatus =
  | "queued"
  | "assigned"
  | "running"
  | "blocked"
  | "review"
  | "integrating"
  | "completed"
  | "failed"
  | "cancelled";
export type AgentStatus =
  | "offline"
  | "starting"
  | "idle"
  | "running"
  | "waiting"
  | "stopped"
  | "error"
  | "recovery";
export interface Probe {
  provider: Provider;
  executable: string;
  installed: boolean;
  version: string;
  nativeTerminal: boolean;
  initialPrompt: boolean;
  sessionControl: boolean;
  verified: boolean;
  notes: string[];
}
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  permissionMode: PermissionMode;
  teamConfigured?: boolean;
}
export interface Agent {
  conversationId?: string;
  sessionCwd?: string;
  boundSessionId?: string;
  sessionError?: string;
  sessionStarted?: boolean;
  id: string;
  name: string;
  provider: Provider;
  role: string;
  messageTurn?: { messageId: string; startedAt: string };
  status: AgentStatus;
  manual: boolean;
  sessionId?: string;
  taskId?: string;
  cwd?: string;
  pid?: number;
  error?: string;
  lastActivity?: string;
  attention?: string;
  probe?: Probe;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  generation?: string;
  connectionWarning?: string;
  nativeError?: string;
  settingChange?: string;
  effectiveModel?: string;
  effectiveEffort?: string;
}
export interface CommandSpec {
  executable: string;
  args: string[];
}
export interface Plan {
  version: number;
  goal: string;
  approvedVersion?: number;
  approvedAt?: string;
  checks: CommandSpec[];
  maxMinutes: number;
  retryLimit: number;
}
export interface Project {
  id: string;
  name: string;
  root: string;
  base: string;
  branch: string;
  integrationPath: string;
  workspaceLayout?: "dated";
  workspaceRoot?: string;
  integrationBranch: string;
  integratedHead: string;
  dirtyOriginal: boolean;
  plan: Plan;
  createdAt: string;
}
export interface Task {
  conversationId?: string;
  requestId?: string;
  kind?: "analysis" | "code";
  evidence?: string;
  checked?: boolean;
  key?: string;
  id: string;
  title: string;
  description: string;
  ownerId: string;
  sourceId: string;
  dependencies: string[];
  acceptance: string;
  status: TaskStatus;
  planVersion: number;
  priority: number;
  createdAt: string;
  runId?: string;
  worktree?: string;
  gitDir?: string;
  branch?: string;
  base?: string;
  progress?: string;
  remaining?: string;
  error?: string;
  result?: string;
  commit?: string;
  artifact?: { files: string[]; diff: string; truncated: boolean };
  testIds: string[];
  review?: { by: string; commit: string; at: string };
  integratedCommit?: string;
  attempts: number;
  repairs?: number;
  reviewRounds?: number;
  lastReviewer?: string;
  resolvesTaskId?: string;
}
export interface Run {
  conversationId?: string;
  analysisAudit?: Record<string, Record<string, string>>;
  id: string;
  taskId: string;
  agentId: string;
  status: "starting" | "running" | "ended" | "interrupted" | "unknown";
  startedAt: string;
  endedAt?: string;
  sessionId?: string;
  pid?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  reason?: string;
}
export interface Message {
  conversationId?: string;
  requestId?: string;
  id: string;
  sourceId: string;
  targetId: string;
  taskId?: string;
  text: string;
  kind: "task" | "question" | "reply" | "progress" | "result";
  status: "queued" | "sending" | "delivered" | "acknowledged" | "failed";
  createdAt: string;
  error?: string;
  replyTo?: string;
  deliveryAttempts?: number;
}
export interface TestRun {
  conversationId?: string;
  id: string;
  taskId: string;
  commit: string;
  cwd: string;
  command: CommandSpec;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  log: string;
  status: "running" | "passed" | "failed";
  scope: "task" | "integration";
}
export interface AppEvent {
  requestId?: string;
  seq: number;
  type: string;
  at: string;
  agentId?: string;
  taskId?: string;
  messageId?: string;
  detail: string;
}
export interface State {
  attachments?: Attachment[];
  conversations: Conversation[];
  defaultConversationId: string;
  userRequests: UserRequest[];
  chat: ChatMessage[];
  activeRequestId?: string;
  teamConfigured?: boolean;
  permissionMode?: PermissionMode;
  revision: number;
  project?: Project;
  agents: Agent[];
  tasks: Task[];
  messages: Message[];
  runs: Run[];
  tests: TestRun[];
  events: AppEvent[];
  paused: boolean;
  concurrency: number;
  approvals: {
    id: string;
    agentId: string;
    method: string;
    detail: string;
    presentation?: ApprovalPresentation;
    status: "pending" | "accepted" | "declined" | "resolved";
  }[];
  requests: Record<string, { hash: string; result: unknown }>;
}
export type BrowserEvent =
  | { type: "state"; state: State }
  | {
      type: "terminal";
      agentId: string;
      generation: string;
      seq: number;
      data: string;
    }
  | {
      type: "terminal-snapshot";
      agentId: string;
      generation: string;
      seq: number;
      cols: number;
      rows: number;
      data: string;
    };
export const PROVIDERS: Provider[] = ["antigravity", "codex", "claude"];
export const now = () => new Date().toISOString();

export interface Snapshot {
  id: string;
  root: string;
  head: string;
  branch: string;
  commit: string;
  fingerprints: Record<string, string>;
}
export type RequestStatus =
  | "queued"
  | "planning"
  | "running"
  | "verifying"
  | "writing"
  | "summarizing"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped";
export interface UserRequest {
  attachmentIds?: string[];
  vision?: {
    agentId: string;
    batches: {
      id: string;
      attachmentIds: string[];
      status: "pending" | "running" | "completed";
      analysis?: string;
      readIds?: string[];
      startedAt?: string;
    }[];
  };
  conversationId?: string;
  id: string;
  text: string;
  status: RequestStatus;
  createdAt: string;
  agentIds: string[];
  members?: Pick<
    Agent,
    "id" | "provider" | "model" | "reasoningEffort" | "permissionMode"
  >[];
  coordinatorId?: string;
  version: number;
  rounds: number;
  summaryRounds?: number;
  snapshot?: Snapshot;
  analysisRootAudit?: Record<string, string>;
  integrationPath?: string;
  integrationBranch?: string;
  summary?: string;
  error?: string;
  question?: string;
  answer?: string;
  changedFiles?: string[];
  delivered?: boolean;
  control?: {
    fileAudit?: Record<string, Record<string, string>>;
    agentId: string;
    kind: "planning" | "review" | "summary" | "vision";
    taskId?: string;
    startedAt: string;
  };
}
export interface ChatMessage {
  attachmentIds?: string[];
  conversationId?: string;
  id: string;
  requestId?: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}
export interface PlannedTask {
  key: string;
  title: string;
  description: string;
  ownerId: string;
  dependencies: string[];
  acceptance: string;
  kind: "analysis" | "code";
}
