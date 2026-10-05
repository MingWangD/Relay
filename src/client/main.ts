import { renderMarkdown, updateMarkup } from "./reading.ts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { icon } from "./icons.ts";
import {
  agentStatusText,
  approvalPresentation,
} from "../shared/presentation.ts";
import type {
  Agent,
  BrowserEvent,
  State,
  Provider,
  UserRequest,
  MemberConfig,
  ModelCatalog,
  PermissionMode,
} from "../shared/types.ts";
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const escape = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const names: Record<Provider, string> = {
  codex: "Codex",
  antigravity: "Antigravity",
  claude: "Claude Code",
};
const labels: Record<string, string> = {
  queued: "排队中",
  planning: "团队正在规划",
  running: "执行中",
  verifying: "验证中",
  writing: "正在回写",
  summarizing: "正在汇总结果",
  waiting: "等待处理",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  assigned: "已分配",
  blocked: "阻塞",
  review: "待评审",
  integrating: "整合中",
  cancelled: "已取消",
  offline: "未启动",
  starting: "连接中",
  idle: "空闲",
  error: "异常",
  recovery: "待恢复",
  sending: "投递中",
  delivered: "已送达",
  acknowledged: "已确认",
};
let state: State | undefined;
let selectedChat = sessionStorage.getItem("relay.chat") ?? "";
const viewKey = () => "relay.view." + selectedChat;
const views = new Map<
  string,
  {
    scroll: number;
    draft: string;
    processId?: string;
    terminalsOpen: boolean;
    terminalPage: number;
  }
>();
const members = () =>
  state?.agents.filter(
    (a) => (a.conversationId ?? state!.defaultConversationId) === selectedChat,
  ) ?? [];
const requests = () =>
  state?.userRequests.filter(
    (r) => (r.conversationId ?? state!.defaultConversationId) === selectedChat,
  ) ?? [];
function saveView() {
  if (!selectedChat) return;
  const view = {
    scroll: $(".conversation").scrollTop,
    draft: $<HTMLTextAreaElement>("#prompt").value,
    processId,
    terminalsOpen,
    terminalPage,
  };
  views.set(selectedChat, view);
  sessionStorage.setItem(viewKey(), JSON.stringify(view));
}
function checkForUpdates() {
  const native = (
    window as Window & {
      webkit?: {
        messageHandlers?: {
          relayNative?: { postMessage: (body: { action: string }) => void };
        };
      };
    }
  ).webkit?.messageHandlers?.relayNative;
  if (native) native.postMessage({ action: "checkForUpdates" });
  else toast("请在 Relay App 中检查更新");
}
function selectChat(id: string) {
  saveView();
  selectedChat = id;
  sessionStorage.setItem("relay.chat", id);
  let view = views.get(id);
  try {
    view ??= JSON.parse(sessionStorage.getItem(viewKey()) ?? "null");
  } catch {}
  processId = view?.processId;
  terminalsOpen = view?.terminalsOpen ?? false;
  terminalPage = view?.terminalPage ?? 0;
  $<HTMLTextAreaElement>("#prompt").value = view?.draft ?? "";
  document.body.append(processPane);
  $("#chat").replaceChildren();
  lastChatMarkup = undefined;
  render();
  $(".conversation").scrollTop = view?.scroll ?? 0;
}

let socket: WebSocket | undefined;
let token = sessionStorage.getItem("relay.token") ?? "";
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.get("token")) {
  token = fragment.get("token")!;
  sessionStorage.setItem("relay.token", token);
  history.replaceState(null, "", location.pathname);
}
let theme = localStorage.getItem("relay.theme") ?? "dark";

let animations = localStorage.getItem("relay.animations") !== "false";
let lastInput = 0,
  lastEvent = 0,
  queueNext = false,
  reconnect: ReturnType<typeof setTimeout>;
let terminalsOpen = false,
  processId: string | undefined;
let terminalPage = 0;
let chatDeferred = false;
let lastChatMarkup: string | undefined;
const openProcesses = new Set<string>(
  JSON.parse(sessionStorage.getItem("relay.openProcesses") ?? "[]"),
);
const openMessages = new Set<string>(
  JSON.parse(sessionStorage.getItem("relay.openMessages") ?? "[]"),
);
type TerminalUpdate = Extract<BrowserEvent, { type: "terminal" }>;
type TerminalSnapshot = Extract<BrowserEvent, { type: "terminal-snapshot" }>;
type TerminalPanel = {
  el: HTMLElement;
  terminal: Terminal;
  fit: FitAddon;
  observer: ResizeObserver;
  seq: number;
  generation: string;
  wheelRemainder: number;
  awaitingSnapshot: boolean;
  restoring: boolean;
  pending: TerminalUpdate[];
  nextSnapshot?: TerminalSnapshot;
  fitFrame: number;
  lastResize: string;
};
const panels = new Map<string, TerminalPanel>();
window.addEventListener(
  "wheel",
  (event) => {
    const el = (event.target as Element | null)?.closest<HTMLElement>(
      ".terminal-panel",
    );
    const panel = el && panels.get(el.dataset.agent ?? "");
    if (
      !panel ||
      panel.terminal.buffer.active.type !== "alternate" ||
      event.deltaY === 0
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const rect = el.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * panel.terminal.rows
          : event.deltaY / 40;
    if (Math.sign(delta) !== Math.sign(panel.wheelRemainder))
      panel.wheelRemainder = 0;
    const lines = Math.trunc(panel.wheelRemainder + delta);
    panel.wheelRemainder = (panel.wheelRemainder + delta) % 1;
    if (!lines || socket?.readyState !== WebSocket.OPEN || !panel.generation)
      return;
    const terminal = panel.terminal;
    socket.send(
      JSON.stringify({
        type: "scroll",
        agentId: el.dataset.agent,
        conversationId: selectedChat,
        generation: panel.generation,
        direction: lines < 0 ? "up" : "down",
        count: Math.min(10, Math.abs(lines)),
        col: Math.max(
          1,
          Math.min(
            terminal.cols,
            Math.floor(
              ((event.clientX - rect.left) / rect.width) * terminal.cols,
            ) + 1,
          ),
        ),
        row: Math.max(
          1,
          Math.min(
            terminal.rows,
            Math.floor(
              ((event.clientY - rect.top) / rect.height) * terminal.rows,
            ) + 1,
          ),
        ),
      }),
    );
  },
  { capture: true, passive: false },
);
let available: Record<string, boolean> = {};
let preferred: Record<Provider, number> = {
  codex: 1,
  antigravity: 1,
  claude: 0,
};
const activeRequest = () =>
  requests().find((r) => r.id === state?.activeRequestId);
const agentName = (
  a?: Pick<Agent, "id" | "provider">,
  members: Pick<Agent, "id" | "provider">[] = state!.agents.filter(
    (a) => (a.conversationId ?? state!.defaultConversationId) === selectedChat,
  ),
) =>
  a
    ? `${names[a.provider]} ${members.filter((x) => x.provider === a.provider).findIndex((x) => x.id === a.id) + 1}`
    : "Agent";
$("#app").innerHTML = `
  <aside id="chat-sidebar" aria-label="聊天历史"></aside><main class="shell"><header class="topbar"><div class="brand"><button class="icon-button" data-action="sidebar" aria-label="切换聊天历史">☰</button><span class="brand-mark">${icon("relay")}</span><strong>Relay</strong></div><div class="context"><div class="project-context"><button class="context-button" data-action="project" id="project-button">${icon("folder")}<span>选择项目</span></button><button class="icon-button project-add" data-action="add-project" aria-label="添加项目" aria-haspopup="true" aria-expanded="false">${icon("plus")}</button><div id="project-menu" class="project-menu menu-list" hidden><button type="button" data-action="project-folder">${icon("folder")} 在此电脑上选择文件夹</button></div></div><button class="context-button" data-action="team" id="team-button">${icon("grid")}<span>Agent</span></button></div><div class="header-end"><span id="connection" role="status" class="connection" aria-label="本地服务正在连接"></span><button class="icon-button command-button" data-action="command-palette" aria-label="打开命令面板" title="命令面板（⌘K）">${icon("search")}</button><button class="icon-button" data-action="more" aria-label="更多">···</button></div></header>
  <section class="conversation" aria-label="项目对话"><div id="chat"></div></section>
  <div class="composer-wrap"><section id="pending-requests" aria-label="待处理请求" aria-live="polite"></section><button class="text-button latest-button" data-action="latest">查看最新</button><div id="runtime-controls"></div><form id="composer"><label class="sr-only" for="prompt">告诉团队要完成什么</label><textarea id="prompt" rows="2" placeholder="告诉团队要完成什么…" required></textarea><div class="composer-foot"><span id="composer-hint">选择项目和 Agent，开始协作</span><button type="submit" class="send-button" aria-label="发送需求">${icon("chevron")}</button></div></form><p class="input-note">Enter 发送 · Shift + Enter 换行</p></div></main>
  <section id="process-pane" hidden><div id="terminal-pages"></div><div class="terminal-grid" id="terminals"></div></section><dialog id="dialog" aria-labelledby="dialog-title"></dialog><div id="toasts" aria-live="polite"></div>`;
const processPane = $("#process-pane");
function scheduleTerminalFit(panel: TerminalPanel) {
  if (panel.fitFrame) return;
  panel.fitFrame = requestAnimationFrame(() => {
    panel.fitFrame = 0;
    if (
      !panel.el.isConnected ||
      processPane.hidden ||
      panel.el.hidden ||
      panel.awaitingSnapshot ||
      panel.restoring
    )
      return;
    const size = panel.fit.proposeDimensions();
    if (!size || size.cols < 20 || size.rows < 5) return;
    if (size.cols !== panel.terminal.cols || size.rows !== panel.terminal.rows)
      panel.fit.fit();
    const geometry = `${panel.generation}:${panel.terminal.cols}:${panel.terminal.rows}`;
    if (
      !panel.generation ||
      panel.lastResize === geometry ||
      socket?.readyState !== WebSocket.OPEN
    )
      return;
    panel.lastResize = geometry;
    socket.send(
      JSON.stringify({
        type: "resize",
        agentId: panel.el.dataset.agent,
        conversationId: selectedChat,
        generation: panel.generation,
        cols: panel.terminal.cols,
        rows: panel.terminal.rows,
      }),
    );
  });
}
function requestTerminalSnapshot(agentId: string, panel: TerminalPanel) {
  panel.awaitingSnapshot = true;
  socket?.readyState === WebSocket.OPEN &&
    socket.send(JSON.stringify({ type: "snapshot", agentId }));
}
function receiveTerminalUpdate(panel: TerminalPanel, packet: TerminalUpdate) {
  if (panel.awaitingSnapshot || panel.restoring) {
    if (panel.pending.length >= 512) panel.pending.shift();
    panel.pending.push(packet);
    return;
  }
  if (packet.generation !== panel.generation || packet.seq !== panel.seq + 1) {
    if (packet.generation === panel.generation && packet.seq <= panel.seq)
      return;
    panel.pending = [packet];
    requestTerminalSnapshot(packet.agentId, panel);
    return;
  }
  panel.seq = packet.seq;
  const viewport = panel.terminal.buffer.active.viewportY;
  const history = viewport < panel.terminal.buffer.active.baseY;
  panel.terminal.write(packet.data, () => {
    if (history) panel.terminal.scrollToLine(viewport);
  });
}
function receiveTerminalSnapshot(
  panel: TerminalPanel,
  packet: TerminalSnapshot,
) {
  if (packet.generation === "offline") {
    panel.awaitingSnapshot = false;
    const pending = panel.pending;
    panel.pending = [];
    for (const update of pending) receiveTerminalUpdate(panel, update);
    scheduleTerminalFit(panel);
    return;
  }
  if (panel.generation === packet.generation && packet.seq < panel.seq) return;
  if (panel.restoring) {
    if (panel.generation !== packet.generation || panel.seq !== packet.seq)
      panel.nextSnapshot = packet;
    return;
  }
  if (
    !panel.awaitingSnapshot &&
    panel.generation === packet.generation &&
    panel.seq === packet.seq
  )
    return;
  const sameGeneration = panel.generation === packet.generation;
  const viewport = panel.terminal.buffer.active.viewportY;
  const history =
    sameGeneration && viewport < panel.terminal.buffer.active.baseY;
  panel.awaitingSnapshot = false;
  panel.restoring = true;
  panel.generation = packet.generation;
  panel.seq = packet.seq;
  panel.lastResize = "";
  panel.wheelRemainder = 0;
  panel.terminal.reset();
  panel.terminal.resize(packet.cols ?? 100, packet.rows ?? 28);
  panel.terminal.write(packet.data, () => {
    panel.restoring = false;
    if (panel.nextSnapshot) {
      const next = panel.nextSnapshot;
      panel.nextSnapshot = undefined;
      receiveTerminalSnapshot(panel, next);
      return;
    }
    if (history) panel.terminal.scrollToLine(viewport);
    const pending = panel.pending;
    panel.pending = [];
    for (const update of pending)
      if (update.generation !== panel.generation)
        requestTerminalSnapshot(update.agentId, panel);
      else if (update.seq > panel.seq) receiveTerminalUpdate(panel, update);
    scheduleTerminalFit(panel);
  });
}
function applyTheme() {
  document.documentElement.dataset.theme = theme;
}
applyTheme();
function toast(text: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 5500);
}
async function api(action: string, data: unknown = {}) {
  data = {
    conversationId: selectedChat || state?.defaultConversationId,
    ...(data as object),
  };
  const response = await fetch("/api/action", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requestId: crypto.randomUUID(), action, data }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "操作失败");
  return body;
}
function connect() {
  if (!token) {
    modal(
      "连接本地服务",
      '<label>启动链接<input name="link" required placeholder="http://127.0.0.1:4317/#token=…"></label>',
      async (d) => {
        const link = String(d.get("link"));
        token =
          new URLSearchParams(link.split("#")[1] ?? link).get("token") ?? link;
        sessionStorage.setItem("relay.token", token);
        connect();
      },
      "连接",
    );
    return;
  }
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    [`relay.${token}`],
  );
  socket.onopen = () => {
    $("#connection").classList.add("connected");
    $("#connection").setAttribute("aria-label", "本地服务已连接");
    for (const [id, panel] of panels) requestTerminalSnapshot(id, panel);
    void fetch("/api/capabilities", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((probes) => {
        for (const p of probes) available[p.provider] = p.installed;
        preferred = {
          codex: available.codex ? 1 : 0,
          antigravity: available.antigravity ? 1 : 0,
          claude:
            !available.codex && !available.antigravity && available.claude
              ? 1
              : 0,
        };
      })
      .catch(() => {});
  };
  socket.onclose = () => {
    $("#connection").classList.remove("connected");
    $("#connection").setAttribute("aria-label", "连接中断，正在重连");
    for (const panel of panels.values()) {
      panel.awaitingSnapshot = true;
      panel.pending = [];
      panel.lastResize = "";
    }
    clearTimeout(reconnect);
    reconnect = setTimeout(connect, 2000);
  };
  socket.onmessage = (e) => {
    const packet = JSON.parse(e.data) as
      BrowserEvent | { type: "error"; message: string };
    if (packet.type === "state") {
      const firstState = !state;
      state = packet.state;
      if (!state.conversations.some((c) => c.id === selectedChat))
        selectedChat = state.defaultConversationId;
      if (firstState) {
        let view: ReturnType<typeof views.get>;
        try {
          view = JSON.parse(sessionStorage.getItem(viewKey()) ?? "null");
        } catch {}
        if (view) {
          views.set(selectedChat, view);
          processId = view.processId;
          terminalsOpen = view.terminalsOpen;
          terminalPage = view.terminalPage;
          $<HTMLTextAreaElement>("#prompt").value = view.draft;
        }
        render();
        $(".conversation").scrollTop = view?.scroll ?? 0;
      } else render();
    } else if (packet.type === "error") toast(packet.message);
    else {
      const p = panels.get(packet.agentId);
      if (!p) return;
      if (packet.type === "terminal-snapshot") {
        receiveTerminalSnapshot(p, packet);
      } else {
        receiveTerminalUpdate(p, packet);
      }
    }
  };
}
function renderSidebar() {
  const s = state!;
  const list = () =>
    [...s.conversations]
      .filter((c) => !c.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => {
        const rs = s.userRequests.filter(
          (r) => (r.conversationId ?? s.defaultConversationId) === c.id,
        );
        const current = rs.find(
          (r) => !["completed", "failed", "stopped"].includes(r.status),
        );
        const agents = s.agents.filter(
          (a) => (a.conversationId ?? s.defaultConversationId) === c.id,
        );
        const alerts =
          s.approvals.filter(
            (p) =>
              p.status === "pending" && agents.some((a) => a.id === p.agentId),
          ).length +
          agents.filter(
            (a) =>
              a.attention ||
              a.nativeError ||
              a.connectionWarning ||
              a.status === "recovery" ||
              a.sessionError,
          ).length;
        return (
          '<div class="chat-history-item" data-key="' +
          c.id +
          '"><button class="chat-select" data-action="chat-select" data-id="' +
          c.id +
          '" aria-current="' +
          (c.id === selectedChat) +
          '"><strong>' +
          escape(c.title) +
          "</strong><small>" +
          (current ? labels[current.status] : "空闲") +
          (alerts ? " · 待处理 " + alerts : "") +
          '</small></button><div><button class="text-button" data-action="' +
          "chat-archive" +
          '" data-id="' +
          c.id +
          '">' +
          "归档" +
          '</button><button class="text-button" data-action="chat-delete" data-id="' +
          c.id +
          '">删除</button></div></div>'
        );
      })
      .join("");
  updateMarkup(
    $("#chat-sidebar"),
    '<button class="secondary new-chat" data-action="chat-new">新建聊天</button><h2>历史对话</h2>' +
      list(),
  );
}
function render() {
  if (!state) return;
  renderSidebar();
  renderArchivedDialog();
  $<HTMLButtonElement>(".send-button").disabled = Boolean(
    state.conversations.find((c) => c.id === selectedChat)?.archivedAt,
  );
  const s = state,
    r = activeRequest();
  $("#project-button span").textContent = s.project?.name ?? "选择项目";
  $("#team-button span").textContent = members().length
    ? [...new Set(members().map((a) => a.provider))]
        .map(
          (p) =>
            `${names[p]} ×${members().filter((a) => a.provider === p).length}`,
        )
        .join(" · ")
    : "Agent";
  $("#composer-hint").textContent = queueNext
    ? "下一条作为新需求排队"
    : r
      ? r.question
        ? "回复团队的问题"
        : "补充当前需求"
      : "直接描述需求，团队自行规划";
  $(".send-button").setAttribute(
    "aria-label",
    r && !queueNext ? "发送补充" : "发送需求",
  );
  $("#runtime-controls").innerHTML = r
    ? `<span class="execution-status"><i></i>${s.paused ? "已暂停" : labels[r.status]}</span><div><button class="text-button" data-action="${s.paused || (r.status === "waiting" && !r.question) ? "resume" : "pause"}">${s.paused || (r.status === "waiting" && !r.question) ? "继续" : "暂停"}</button><button class="text-button" data-action="stop">停止</button></div>`
    : "";
  renderPendingRequests();
  renderChat();
  const recent = s.events.filter(
    (e) =>
      e.seq > lastEvent &&
      ["task.delivered", "message.delivered"].includes(e.type),
  );
  if (lastEvent)
    for (const e of recent) {
      const p = panels.get(e.agentId ?? "");
      if (
        p &&
        !processPane.hidden &&
        animations &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        p.el.classList.remove("received");
        void p.el.offsetWidth;
        p.el.classList.add("received");
      }
    }
  lastEvent = s.events.at(-1)?.seq ?? 0;
}
function panelsHaveHistory() {
  return [...panels.values()].some(
    (p) =>
      p.terminal.hasSelection() ||
      p.terminal.buffer.active.viewportY < p.terminal.buffer.active.baseY,
  );
}
document.addEventListener("selectionchange", () => {
  if (chatDeferred && !document.getSelection()?.toString()) {
    chatDeferred = false;
    if (state) renderChat();
  }
});
function renderPendingRequests() {
  const s = state!;
  const cards = s.approvals
    .filter(
      (a) =>
        a.status === "pending" && members().some((m) => m.id === a.agentId),
    )
    .map((a) => {
      const p = a.presentation ?? approvalPresentation(a.method, a.detail);
      return `<div class="approval-card"><span>${escape(agentName(s.agents.find((x) => x.id === a.agentId)))}：${escape(p.title)}</span><div><button class="secondary" data-action="approval" data-id="${a.id}">查看请求</button><button class="text-button" data-action="show-terminals" data-id="${activeRequest()?.id ?? requests().at(-1)?.id}">打开终端</button></div></div>`;
    });
  for (const a of members().filter(
    (a) => a.attention || a.nativeError || a.connectionWarning,
  )) {
    cards.push(
      `<div class="attention"><span>${escape(agentName(a))}：${escape(a.attention ?? a.nativeError ?? a.connectionWarning)}</span><button class="text-button" data-action="show-terminals" data-id="${activeRequest()?.id ?? requests().at(-1)?.id}">打开终端</button></div>`,
    );
  }
  const dock = $("#pending-requests");
  const focused = document.activeElement as HTMLElement | null;
  const scroll = dock.scrollTop;
  dock.innerHTML = cards.join("");
  dock.scrollTop = scroll;
  if (focused && !focused.isConnected && focused.dataset.action) {
    [...dock.querySelectorAll<HTMLElement>("[data-action]")]
      .find(
        (el) =>
          el.dataset.action === focused.dataset.action &&
          el.dataset.id === focused.dataset.id,
      )
      ?.focus({ preventScroll: true });
  }
  const dialog = $<HTMLDialogElement>("#dialog");
  if (
    dialog.open &&
    dialog.dataset.approval &&
    !s.approvals.some(
      (a) => a.id === dialog.dataset.approval && a.status === "pending",
    )
  )
    dialog.close();
}

const catalogs = new Map<Provider, ModelCatalog>();
async function openTeamSettings() {
  const providers: Provider[] = ["codex", "antigravity", "claude"];
  const draft = new Map<Provider, MemberConfig[]>(
    providers.map((provider) => [
      provider,
      members()
        .filter((a) => a.provider === provider)
        .map((a) => ({
          id: a.id,
          provider,
          model: a.model,
          reasoningEffort: a.reasoningEffort,
        })) ?? [],
    ]),
  );
  if (!members().length)
    for (const provider of providers)
      draft.set(
        provider,
        Array.from({ length: preferred[provider] }, () => ({ provider })),
      );
  const busy = Boolean(
    activeRequest() ||
    requests().some(
      (r) => !["completed", "failed", "stopped"].includes(r.status),
    ) ||
    members().some(
      (a) =>
        a.manual ||
        ["starting", "running", "waiting", "recovery"].includes(a.status),
    ),
  );
  modal(
    "选择 Agent",
    `<label>团队权限<select name="permissionMode"><option value="full" ${!members().length || state?.conversations.find((c) => c.id === selectedChat)?.permissionMode === "full" ? "selected" : ""}>完全访问</option><option value="native" ${members().length && state?.conversations.find((c) => c.id === selectedChat)?.permissionMode !== "full" ? "selected" : ""}>原生审批</option></select></label><p class="permission-help"></p>${providers.map((p) => `<section class="provider-settings" data-provider="${p}"><label class="team-row">${names[p]}<input aria-label="${names[p]} 数量" name="${p}" type="number" min="0" max="8" value="${draft.get(p)!.length}"></label><div class="catalog-note muted" role="status">正在读取模型目录…</div><button class="text-button catalog-retry" type="button">刷新模型目录</button><div class="member-settings"></div></section>`).join("")}<p class="muted">共 1–8 个 Agent，分工由团队自行确定。保存后，下次启动使用新设置。</p>${busy ? '<p class="dialog-warning">执行、排队或恢复期间不能修改团队。请先停止并处理现有会话。</p>' : ""}`,
    async () => {
      const members = providers.flatMap((p) => draft.get(p)!);
      await api("team", {
        members,
        permissionMode: $<HTMLSelectElement>('#dialog [name="permissionMode"]')
          .value,
      });
    },
  );
  const dialog = $<HTMLDialogElement>("#dialog");
  const editorId = crypto.randomUUID();
  dialog.dataset.team = editorId;
  const permission = dialog.querySelector<HTMLSelectElement>(
    '[name="permissionMode"]',
  )!;
  const permissionHelp = () => {
    dialog.querySelector(".permission-help")!.textContent =
      permission.value === "full"
        ? "完全访问允许 Agent 无需逐次批准，读写当前用户可访问的文件、执行命令和联网，包括项目外文件。它不能绕过 macOS 系统权限或组织策略。独立工作区和回写检查仍保留，但无法限制 Agent 直接操作其他目录。仅作用于 Relay 启动的新会话，不修改 CLI 全局配置。"
        : "使用 CLI 原生审批与沙箱流程；权限请求由你确认。仅作用于下一次 Relay 会话启动。";
  };
  permission.onchange = permissionHelp;
  permissionHelp();
  function renderMembers(provider: Provider) {
    const section = dialog.querySelector<HTMLElement>(
      `[data-provider="${provider}"]`,
    )!;
    updateMarkup(
      section.querySelector<HTMLElement>(".member-settings")!,
      draft
        .get(provider)!
        .map(
          (m, i) =>
            `<fieldset class="member-config" data-key="${provider}-${i}" data-index="${i}"><legend>${names[provider]} ${i + 1}</legend><label>模型<select class="model-select" aria-label="${names[provider]} ${i + 1} 模型"></select></label><label ${provider === "antigravity" ? "hidden" : ""}>思考强度<select class="effort-select" aria-label="${names[provider]} ${i + 1} 思考强度"></select></label><p class="effort-note muted" ${provider === "antigravity" ? "hidden" : ""}></p></fieldset>`,
        )
        .join(""),
    );
    section.querySelectorAll<HTMLElement>(".member-config").forEach((row) => {
      const m = draft.get(provider)![Number(row.dataset.index)];
      const model = row.querySelector<HTMLSelectElement>(".model-select")!;
      const effort = row.querySelector<HTMLSelectElement>(".effort-select")!;
      const choices = catalogs.get(provider)?.models ?? [];
      if (provider === "antigravity" && m.reasoningEffort && choices.length) {
        const suffix = m.model?.match(/-(low|medium|high|max)$/)?.[1];
        const full = suffix
          ? m.model
          : m.model
            ? m.model + "-" + m.reasoningEffort
            : undefined;
        if (
          (!suffix || suffix === m.reasoningEffort) &&
          choices.some((x) => x.id === full)
        ) {
          m.model = full;
          m.reasoningEffort = undefined;
        } else
          section.querySelector(".catalog-note")!.textContent =
            "旧模型与强度无法匹配或存在冲突，请重新选择完整模型 ID。";
      }
      const saved =
        m.model && !choices.some((x) => x.id === m.model)
          ? [{ id: m.model, name: m.model + "（已保存，目录暂未列出）" }]
          : [];
      model.innerHTML =
        '<option value="">沿用 CLI 默认</option>' +
        [...choices, ...saved]
          .map(
            (x) =>
              '<option value="' +
              escape(x.id) +
              '">' +
              escape(x.name) +
              "</option>",
          )
          .join("");
      model.value = m.model ?? "";
      const updateEffort = () => {
        const known = choices.find((x) => x.id === m.model)?.efforts;
        const values = known ?? catalogs.get(provider)?.cliEfforts ?? [];
        if (known && m.reasoningEffort && !known.includes(m.reasoningEffort))
          m.reasoningEffort = undefined;
        const extras =
          m.reasoningEffort && !values.includes(m.reasoningEffort)
            ? [m.reasoningEffort]
            : [];
        effort.innerHTML =
          '<option value="">沿用 CLI 默认</option>' +
          [...values, ...extras]
            .map((x) => `<option value="${x}">${x}</option>`)
            .join("");
        effort.value = m.reasoningEffort ?? "";
        row.querySelector(".effort-note")!.textContent = known
          ? "强度按所选模型能力提供。"
          : "模型能力尚未确认；默认交给 CLI。显式强度由 CLI 验证。";
      };
      model.onchange = () => {
        if (provider === "antigravity") m.reasoningEffort = undefined;
        m.model = model.value || undefined;
        updateEffort();
      };
      effort.onchange = () => {
        m.reasoningEffort =
          (effort.value as MemberConfig["reasoningEffort"]) || undefined;
      };
      updateEffort();
      model.disabled = effort.disabled = busy;
    });
  }
  async function load(provider: Provider, refresh = false) {
    const section = dialog.querySelector<HTMLElement>(
      `[data-provider="${provider}"]`,
    )!;
    const note = section.querySelector<HTMLElement>(".catalog-note")!;
    note.textContent = "正在读取模型目录…";
    try {
      const response = await fetch(
        `/api/models/${provider}${refresh ? "?refresh=1" : ""}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error("模型目录暂不可用");
      const catalog = (await response.json()) as ModelCatalog;
      const previous = catalogs.get(provider);
      const effective =
        catalog.error && previous?.models.length
          ? {
              ...catalog,
              models: previous.models,
              cliEfforts: previous.cliEfforts,
            }
          : catalog;
      catalogs.set(provider, effective);
      note.textContent = catalog.error
        ? `目录读取失败：${catalog.error}。${effective.models.length ? "暂用上次读取的模型列表，可刷新重试。" : "可沿用 CLI 默认或已保存模型，请刷新重试。"}`
        : catalog.models.length
          ? catalog.source
          : "目录未返回可选模型；可沿用 CLI 默认或已保存模型，请刷新重试。";
      // Reconcile stable controls even if catalog loading finishes after focus enters a member.
      if (dialog.open && dialog.dataset.team === editorId)
        renderMembers(provider);
    } catch (e) {
      note.textContent = `${(e as Error).message}。可沿用 CLI 默认或已保存模型，请刷新重试。`;
    }
  }
  for (const provider of providers) {
    const section = dialog.querySelector<HTMLElement>(
      `[data-provider="${provider}"]`,
    )!;
    const count = section.querySelector<HTMLInputElement>('[type="number"]')!;
    count.disabled = busy;
    count.oninput = () => {
      const value = Number(count.value);
      if (!Number.isInteger(value) || value < 0 || value > 8) return;
      const members = draft.get(provider)!;
      while (members.length < value) members.push({ provider });
      members.length = value;
      renderMembers(provider);
    };
    section.querySelector<HTMLButtonElement>(".catalog-retry")!.onclick = () =>
      void load(provider, true);
    renderMembers(provider);
    void load(provider);
  }
  permission.disabled = busy;
  dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = busy;
}

function renderChat() {
  const selection = document.getSelection();
  if (
    selection?.toString() &&
    selection.anchorNode &&
    $("#chat").contains(selection.anchorNode)
  ) {
    chatDeferred = true;
    return;
  }
  const s = state!;
  const markup = !requests().length
    ? '<div class="welcome"><h1>想让团队完成什么？</h1></div>'
    : requests()
        .map((r) => {
          const tasks = s.tasks.filter((t) => t.requestId === r.id);
          const members =
            r.members ?? s.agents.filter((a) => r.agentIds.includes(a.id));
          const memberName = (id: string) =>
            agentName(
              members.find((a) => a.id === id),
              members,
            );
          const chat = s.chat.filter(
            (m) =>
              m.requestId === r.id &&
              !(m.role === "assistant" && m.text === r.summary),
          );
          const messages = s.messages.filter(
            (m) => m.requestId === r.id || tasks.some((t) => t.id === m.taskId),
          );
          return `<article class="request" data-request="${r.id}">${chat.map((m) => `<div data-key="${m.id}" class="${m.role === "user" ? "user-message" : "assistant-message"}">${escape(m.text)}</div>`).join("")}${r.status !== "completed" ? `<div class="request-status ${r.status}" role="status">${labels[r.status]}${r.error ? `<p>${escape(r.error)}</p>` : ""}</div>` : ""}<details class="process" data-process="${r.id}" ${openProcesses.has(r.id) ? "open" : ""}><summary>查看协作过程 <span>${tasks.length ? `${tasks.filter((t) => t.status === "completed").length}/${tasks.length}` : ""}</span></summary><div class="process-content"><div class="process-tasks">${tasks.map((t) => `<div class="internal-task" data-key="${t.id}"><span class="badge ${t.status}">${labels[t.status]}</span><div><strong>${escape(t.title)}</strong><small>${escape(memberName(t.ownerId))}</small>${t.progress || t.error ? `<p>${escape(t.error ?? t.progress)}</p>` : ""}</div></div>`).join("") || '<p class="muted">团队正在协商分工。</p>'}</div>${messages.length ? `<details class="messages" data-key="messages-${r.id}" ${openMessages.has(r.id) ? "open" : ""}><summary>成员交流 · ${messages.length}</summary>${messages.map((m) => `<div class="internal-message" data-key="${m.id}"><small>${escape(m.sourceId === "user" ? "你" : memberName(m.sourceId))} 交给 ${escape(memberName(m.targetId))} · ${labels[m.status]}</small><p>${escape(m.text)}</p></div>`).join("")}</details>` : ""}${(r.id === s.activeRequestId || r.id === requests().at(-1)?.id) && r.agentIds.every((id) => s.agents.some((a) => a.id === id)) ? `<button class="text-button terminal-toggle" data-action="terminals" data-id="${r.id}">${icon("terminal")} ${terminalsOpen && processId === r.id ? "收起终端" : "查看真实终端"}</button><div class="terminal-slot" data-slot="${r.id}"></div>` : '<p class="muted">历史过程记录；原生终端仅展示最近会话。</p>'}</div></details>${r.summary ? '<section class="request-summary" data-key="summary-' + r.id + '"><h2>最终结论</h2>' + renderMarkdown(r.summary) + "</section>" : ""}${r.changedFiles?.length ? `<button class="text-button result-link" data-action="diff" data-id="${r.id}">${icon("branch")} 查看改动 · ${r.changedFiles.length} 个文件</button>` : r.status === "waiting" && tasks.some((t) => t.kind === "code" && t.commit) ? `<button class="text-button" data-action="diff" data-id="${r.id}">查看保留的成果差异</button>` : ""}</article>`;
        })
        .join("");
  if (lastChatMarkup === markup) {
    attachTerminals();
    return;
  }
  const focused = document.activeElement as HTMLElement | null;
  const oldScroll = $(".conversation").scrollTop;
  const viewportTop = $(".conversation").getBoundingClientRect().top;
  const anchor = [
    ...$("#chat").querySelectorAll<HTMLElement>("[data-key]"),
  ].find(
    (el) =>
      el.getBoundingClientRect().bottom > viewportTop &&
      el.getBoundingClientRect().top <= viewportTop,
  );
  const anchorTop = anchor?.getBoundingClientRect().top;
  updateMarkup($("#chat"), markup);
  lastChatMarkup = markup;
  $("#chat")
    .querySelectorAll<HTMLDetailsElement>("[data-process]")
    .forEach((el) => {
      el.open = openProcesses.has(el.dataset.process!);
      el.ontoggle = () => {
        if (el.open) openProcesses.add(el.dataset.process!);
        else openProcesses.delete(el.dataset.process!);
        sessionStorage.setItem(
          "relay.openProcesses",
          JSON.stringify([...openProcesses]),
        );
        attachTerminals();
      };
    });
  $("#chat")
    .querySelectorAll<HTMLDetailsElement>(".messages")
    .forEach((el) => {
      el.ontoggle = () => {
        const id = el.closest<HTMLElement>("[data-request]")!.dataset.request!;
        if (el.open) openMessages.add(id);
        else openMessages.delete(id);
        sessionStorage.setItem(
          "relay.openMessages",
          JSON.stringify([...openMessages]),
        );
      };
    });
  attachTerminals();
  $(".conversation").scrollTop = oldScroll;
  if (anchor?.isConnected && anchorTop !== undefined)
    $(".conversation").scrollTop +=
      anchor.getBoundingClientRect().top - anchorTop;
  if (focused?.isConnected && focused.closest(".xterm") && !processPane.hidden)
    focused.focus({ preventScroll: true });
  if (focused && !focused.isConnected && focused.dataset.action)
    [...document.querySelectorAll<HTMLElement>("[data-action]")]
      .find(
        (el) =>
          el.dataset.action === focused.dataset.action &&
          el.dataset.id === focused.dataset.id &&
          el.getClientRects().length,
      )
      ?.focus({ preventScroll: true });
}
function attachTerminals() {
  const slot = [...document.querySelectorAll<HTMLElement>("[data-slot]")].find(
    (el) => el.dataset.slot === processId,
  );
  const wasHidden = processPane.hidden;
  const hidden = !terminalsOpen || !slot || !openProcesses.has(processId!);
  if (processPane.hidden !== hidden) processPane.hidden = hidden;
  if (!processPane.hidden && slot) {
    const moved = processPane.parentElement !== slot;
    if (moved) slot.append(processPane);
    for (const [id, panel] of panels)
      if (!state?.agents.some((a) => a.id === id)) {
        panel.observer.disconnect();
        panel.terminal.dispose();
        panel.el.remove();
        panels.delete(id);
      }
    const agents = members();
    terminalPage = Math.min(
      terminalPage,
      Math.max(0, Math.ceil(agents.length / 4) - 1),
    );
    updateMarkup(
      $("#terminal-pages"),
      agents.length > 4
        ? `<div class="terminal-pages">${Array.from({ length: Math.ceil(agents.length / 4) }, (_, i) => `<button class="text-button" data-action="terminal-page" data-id="${i}" aria-pressed="${i === terminalPage}">终端 ${i * 4 + 1}–${Math.min(agents.length, (i + 1) * 4)}</button>`).join("")}</div>`
        : "",
    );
    for (const [id, panel] of panels)
      if (!agents.some((a) => a.id === id) && !panel.el.hidden)
        panel.el.hidden = true;
    agents.forEach(renderAgent);
    if (wasHidden || moved)
      for (const panel of panels.values()) scheduleTerminalFit(panel);
  }
}
function renderAgent(a: Agent) {
  let p = panels.get(a.id);
  if (!p) {
    const el = document.createElement("article");
    el.className = "terminal-panel";
    el.dataset.agent = a.id;
    el.innerHTML =
      '<div class="terminal-header"></div><div class="terminal-mount"></div><div class="terminal-foot"></div>';
    $("#terminals").append(el);
    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: '"SFMono-Regular", Menlo, monospace',
      scrollback: 5000,
      cursorBlink: true,
      disableStdin: true,
      allowProposedApi: true,
      theme: {
        background: "#121419",
        foreground: "#e2e4e9",
        cursor: "#c7caff",
        selectionBackground: "#3f4262",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(el.querySelector(".terminal-mount")!);
    terminal.onData((data) => {
      lastInput = Date.now();
      if (state?.agents.find((x) => x.id === a.id)?.manual)
        socket?.send(
          JSON.stringify({
            type: "input",
            agentId: a.id,
            data,
            conversationId: selectedChat,
            generation: panels.get(a.id)?.generation,
          }),
        );
    });
    const observer = new ResizeObserver(() => {
      const panel = panels.get(a.id);
      if (panel && members().some((member) => member.id === a.id))
        scheduleTerminalFit(panel);
    });
    observer.observe(el);
    p = {
      el,
      terminal,
      fit,
      observer,
      generation: "",
      seq: 0,
      wheelRemainder: 0,
      awaitingSnapshot: true,
      restoring: false,
      pending: [],
      fitFrame: 0,
      lastResize: "",
    };
    panels.set(a.id, p);
    requestTerminalSnapshot(a.id, p);
  }
  const hidden =
    Math.floor(members().findIndex((x) => x.id === a.id) / 4) !== terminalPage;
  if (p.el.hidden !== hidden) {
    p.el.hidden = hidden;
    if (!hidden) scheduleTerminalFit(p);
  }
  if (p.terminal.options.disableStdin !== !a.manual)
    p.terminal.options.disableStdin = !a.manual;
  const header =
    "<strong>" +
    escape(agentName(a)) +
    '</strong><small class="agent-model">' +
    escape(a.model ?? a.effectiveModel ?? "CLI 默认") +
    (a.provider !== "antigravity" && (a.reasoningEffort ?? a.effectiveEffort)
      ? " · " + escape(a.reasoningEffort ?? a.effectiveEffort)
      : "") +
    '</small><span class="badge">' +
    escape(agentStatusText(a)) +
    '</span><button class="text-button" data-action="agent-details" data-id="' +
    a.id +
    '">设置详情</button><button class="icon-button" data-action="expand" data-id="' +
    a.id +
    '" aria-label="' +
    (p.el.classList.contains("expanded") ? "缩小终端" : "放大终端") +
    '">' +
    icon("expand") +
    "</button>";
  updateMarkup(p.el.querySelector<HTMLElement>(".terminal-header")!, header);
  const foot = `<span title="${escape(a.cwd)}">${escape(a.error ?? a.nativeError ?? a.connectionWarning ?? a.cwd?.split("/").slice(-2).join("/") ?? "原生会话尚未启动")}</span><button class="text-button" data-action="manual" data-id="${a.id}">${a.manual ? "退出人工接管" : "人工接管"}</button>`;
  updateMarkup(p.el.querySelector<HTMLElement>(".terminal-foot")!, foot);
}
function showArchivedDialog() {
  modal(
    "已归档的对话",
    '<div class="archive-toolbar"><label class="archive-search"><span class="sr-only">搜索已归档的对话</span>' +
      icon("search") +
      '<input id="archive-search" type="search" placeholder="搜索已归档的对话"></label><label class="archive-sort"><span class="sr-only">排序</span><select id="archive-sort"><option value="newest">最近归档优先</option><option value="oldest">最早归档优先</option></select></label></div><div id="archive-list" aria-live="polite"></div>',
  );
  const dialog = $<HTMLDialogElement>("#dialog");
  dialog.dataset.archives = "true";
  dialog
    .querySelector(".dialog-head")!
    .insertAdjacentHTML(
      "beforeend",
      '<button type="button" class="archive-delete-all" data-action="archive-delete-all">' +
        icon("trash") +
        "全部删除</button>",
    );
  const close = dialog.querySelector<HTMLElement>("[data-close]")!;
  dialog.querySelector(".dialog-head")!.append(close);
  dialog
    .querySelector<HTMLInputElement>("#archive-search")!
    .addEventListener("input", renderArchivedDialog);
  dialog
    .querySelector<HTMLSelectElement>("#archive-sort")!
    .addEventListener("change", renderArchivedDialog);
  renderArchivedDialog();
  dialog
    .querySelector<HTMLInputElement>("#archive-search")!
    .focus({ preventScroll: true });
}
function renderArchivedDialog() {
  const dialog = $<HTMLDialogElement>("#dialog");
  if (!dialog.open || !dialog.dataset.archives || !state) return;
  const query = dialog
    .querySelector<HTMLInputElement>("#archive-search")!
    .value.trim()
    .toLocaleLowerCase();
  const oldest =
    dialog.querySelector<HTMLSelectElement>("#archive-sort")!.value ===
    "oldest";
  const archived = state.conversations.filter((c) => c.archivedAt);
  const filtered = archived
    .filter((c) => c.title.toLocaleLowerCase().includes(query))
    .sort((a, b) =>
      oldest
        ? a.archivedAt!.localeCompare(b.archivedAt!)
        : b.archivedAt!.localeCompare(a.archivedAt!),
    );
  dialog.querySelector<HTMLButtonElement>(
    '[data-action="archive-delete-all"]',
  )!.disabled = !archived.length;
  const rows = filtered
    .map((c) => {
      const date = new Date(c.archivedAt!).toLocaleString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      return (
        '<article class="archive-row" data-key="' +
        c.id +
        '"><button type="button" class="archive-chat" data-action="archive-open" data-id="' +
        c.id +
        '" title="' +
        escape(c.title) +
        '"><strong>' +
        escape(c.title) +
        '</strong><time datetime="' +
        escape(c.archivedAt) +
        '">' +
        escape(date) +
        '</time></button><button type="button" class="icon-button archive-delete" data-action="archive-delete" data-id="' +
        c.id +
        '" aria-label="删除 ' +
        escape(c.title) +
        '">' +
        icon("trash") +
        '</button><button type="button" class="secondary" data-action="chat-restore" data-id="' +
        c.id +
        '">取消归档</button></article>'
      );
    })
    .join("");
  updateMarkup(
    dialog.querySelector<HTMLElement>("#archive-list")!,
    filtered.length
      ? '<div class="archive-project">' +
          icon("folder") +
          "<strong>" +
          escape(state.project?.name ?? "当前项目") +
          "</strong><span>" +
          filtered.length +
          ' 个对话</span></div><div class="archive-rows">' +
          rows +
          "</div>"
      : '<p class="archive-empty muted">' +
          (query && archived.length
            ? "没有匹配的已归档对话。"
            : "暂无已归档对话。") +
          "</p>",
  );
}
function confirmArchiveDeletion(ids: string[]) {
  if (!ids.length) return;
  const deleted = new Set<string>();
  modal(
    ids.length > 1 ? "删除全部已归档对话" : "删除已归档对话",
    "<p>将永久删除 " +
      ids.length +
      " 个 Relay 对话及其记录，删除后无法恢复。项目代码和 CLI 全局历史保留。</p>",
    async () => {
      for (const id of ids) {
        if (deleted.has(id)) continue;
        await api("conversation-delete", {
          conversationId: id,
          confirmed: true,
        });
        deleted.add(id);
      }
    },
    "确认删除",
  );
  $<HTMLDialogElement>("#dialog").addEventListener(
    "close",
    () => requestAnimationFrame(showArchivedDialog),
    { once: true },
  );
}

function modal(
  title: string,
  html: string,
  onSubmit?: (d: FormData) => Promise<unknown>,
  submit = "保存",
) {
  const d = $<HTMLDialogElement>("#dialog");
  if (!d.open) {
    const opener = document.activeElement as HTMLElement | null;
    const action = opener?.dataset.action,
      id = opener?.dataset.id;
    d.addEventListener(
      "close",
      () => {
        const next = opener?.isConnected
          ? opener
          : [...document.querySelectorAll<HTMLElement>("[data-action]")].find(
              (el) =>
                el.dataset.action === action &&
                el.dataset.id === id &&
                el.getClientRects().length,
            );
        next?.focus({ preventScroll: true });
      },
      { once: true },
    );
  }
  delete d.dataset.approval;
  delete d.dataset.team;
  delete d.dataset.archives;
  d.innerHTML = `<form><div class="dialog-head"><h2 id="dialog-title">${escape(title)}</h2><button type="button" class="icon-button" data-close aria-label="关闭对话框">${icon("close")}</button></div><div class="dialog-body">${html}</div><div class="dialog-error" role="alert"></div>${onSubmit ? `<div class="dialog-foot"><button type="button" class="secondary" data-close>取消</button><button class="primary" type="submit">${escape(submit)}</button></div>` : ""}</form>`;
  d.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", () => d.close()),
  );
  d.querySelector("form")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const button = d.querySelector<HTMLButtonElement>("[type=submit]")!;
    button.disabled = true;
    try {
      await onSubmit(new FormData(e.target as HTMLFormElement));
      d.close();
    } catch (e) {
      d.querySelector(".dialog-error")!.textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  });
  if (!d.open) d.showModal();
}
async function action(name: string, id?: string) {
  const s = state;
  switch (name) {
    case "sidebar":
      document.body.classList.toggle("sidebar-collapsed");
      break;
    case "latest":
      $(".conversation").scrollTop = $(".conversation").scrollHeight;
      break;
    case "chat-select":
      selectChat(id!);
      break;
    case "chat-new": {
      const result = await api("conversation-create");
      selectChat(result.id);
      break;
    }
    case "chat-archive":
    case "chat-restore":
      await api("conversation-archive", {
        conversationId: id,
        archived: name === "chat-archive",
      });
      break;
    case "chat-delete":
      modal(
        "删除聊天",
        "<p>只删除 Relay 中的对话和记录。项目代码及 CLI 全局历史保留。删除后无法恢复。</p>",
        () =>
          api("conversation-delete", { conversationId: id, confirmed: true }),
        "确认删除",
      );
      break;
    case "agent-details": {
      const a = state!.agents.find((a) => a.id === id)!;
      modal(
        "原生会话设置",
        "<p>权限：" +
          (a.permissionMode === "full" ? "完全访问" : "原生审批") +
          "</p><p>" +
          escape(
            a.effectiveModel
              ? "原生模型：" + a.effectiveModel
              : "原生模型尚未确认",
          ) +
          "</p><p>" +
          escape(
            a.effectiveEffort
              ? "原生强度：" + a.effectiveEffort
              : "强度尚未确认",
          ) +
          "</p><p>" +
          escape(a.settingChange ?? a.sessionError ?? "") +
          "</p>",
      );
      break;
    }

    case "add-project": {
      const menu = $("#project-menu");
      menu.hidden = !menu.hidden;
      $(".project-add").setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden)
        menu.querySelector<HTMLButtonElement>("button")!.focus();
      break;
    }
    case "project-folder": {
      const menu = $("#project-menu"),
        button = menu.querySelector<HTMLButtonElement>("button")!;
      if (button.disabled) break;
      button.disabled = true;
      button.textContent = "文件夹选择器已打开…";
      saveView();
      try {
        const picker = (
          window as Window & {
            webkit?: {
              messageHandlers?: {
                relayPicker?: {
                  postMessage: (message: {
                    action: string;
                  }) => Promise<{ path?: string; cancelled?: boolean }>;
                };
              };
            };
          }
        ).webkit?.messageHandlers?.relayPicker;
        const selection = picker
          ? await picker.postMessage({ action: "pickFolder" })
          : undefined;
        if (selection?.cancelled) break;
        if (picker && !selection?.path) throw new Error("文件夹选择未返回路径");
        const response = await fetch("/api/project-folder", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            conversationId: selectedChat,
            ...(selection?.path ? { path: selection.path } : {}),
          }),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error?.message ?? "选择文件夹失败");
        if (!result.cancelled) {
          const next = new URL(result.url);
          if (next.protocol !== "http:" || next.hostname !== "127.0.0.1")
            throw new Error("项目地址无效");
          if (next.origin !== location.origin) {
            next.hash = new URLSearchParams({ token: result.token }).toString();
            location.assign(next.href);
          }
        }
      } finally {
        button.disabled = false;
        button.innerHTML = `${icon("folder")} 在此电脑上选择文件夹`;
        menu.hidden = true;
        $(".project-add").setAttribute("aria-expanded", "false");
        $(".project-add").focus({ preventScroll: true });
      }
      break;
    }
    case "project":
      if (s?.project)
        modal(
          "当前项目",
          `<p>${escape(s.project.root)}</p><p class="muted">每项需求开始时读取当前文件快照，包含未提交改动。</p>`,
        );
      else await action("add-project");
      break;
    case "team": {
      await openTeamSettings();
      break;
    }
    case "more":
      modal(
        "更多",
        `<div class="menu-list"><button type="button" data-action="theme">${icon(theme === "dark" ? "sun" : "moon")} ${theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}</button><button type="button" data-action="advanced">${icon("settings")} 高级设置</button><button type="button" data-action="archived-chats">${icon("clock")} 已归档对话</button><button type="button" data-action="report">${icon("download")} 导出报告</button>${members().some((a) => a.status === "recovery" || a.sessionError) ? '<button type="button" data-action="recoveries">恢复成员</button>' : ""}${activeRequest() ? '<button type="button" data-action="queue-next">下一条作为新需求排队</button>' : ""}</div>`,
      );
      break;
    case "command-palette": {
      modal(
        "命令面板",
        `<label class="command-search"><span class="sr-only">过滤命令</span>${icon("search")}<input id="command-filter" type="search" placeholder="搜索命令…" autocomplete="off"></label><div class="command-list" role="menu"><button type="button" data-action="chat-new" role="menuitem">新建聊天 <kbd>⌘N</kbd></button><button type="button" data-action="project" role="menuitem">选择项目 <kbd>⌘⇧P</kbd></button><button type="button" data-action="latest" role="menuitem">查看最新</button><button type="button" data-action="toggle-terminals" role="menuitem">显示／隐藏终端</button><button type="button" data-action="theme" role="menuitem">切换主题</button><button type="button" data-action="archived-chats" role="menuitem">已归档对话</button><button type="button" data-action="advanced" role="menuitem">高级设置</button><button type="button" data-action="check-updates" role="menuitem">检查更新 <kbd>⌘U</kbd></button></div>`,
      );
      const filter = $<HTMLInputElement>("#command-filter");
      filter.addEventListener("input", () => {
        const query = filter.value.trim().toLocaleLowerCase();
        document
          .querySelectorAll<HTMLButtonElement>(".command-list [data-action]")
          .forEach((button) => {
            button.hidden =
              Boolean(query) &&
              !button.textContent!.toLocaleLowerCase().includes(query);
          });
      });
      filter.focus({ preventScroll: true });
      break;
    }
    case "toggle-terminals": {
      terminalsOpen = !terminalsOpen;
      if (!processId) processId = activeRequest()?.id ?? requests().at(-1)?.id;
      if (processId) openProcesses.add(processId);
      renderChat();
      break;
    }
    case "check-updates":
      checkForUpdates();
      $<HTMLDialogElement>("#dialog").close();
      break;
    case "recoveries":
      modal(
        "恢复成员",
        `<p class="muted">服务重启后不能重新附着旧终端。请先在原终端停止对应进程，检查工作区成果，再恢复席位。仍存活的 PID 会被后台拒绝。</p>${
          members()
            .filter((a) => a.status === "recovery" || a.sessionError)
            .map(
              (a) =>
                `<div class="approval-card"><p>${escape(agentName(a))} · PID ${a.pid ?? "无"}</p><p>${escape(a.cwd ?? "尚无工作区")}</p><button type="button" class="secondary" data-action="recover-agent" data-id="${a.id}">已检查，恢复成员</button></div>`,
            )
            .join("") ?? ""
        }`,
      );
      break;
    case "recover-agent":
      await api("recover", { id });
      $<HTMLDialogElement>("#dialog").close();
      break;
    case "theme":
      theme = theme === "dark" ? "light" : "dark";
      localStorage.setItem("relay.theme", theme);
      applyTheme();
      $<HTMLDialogElement>("#dialog").close();
      break;
    case "queue-next":
      queueNext = true;
      render();
      $<HTMLDialogElement>("#dialog").close();
      $("#prompt").focus();
      break;
    case "advanced":
      modal(
        "高级设置",
        `<label>并发上限<input type="number" name="concurrency" value="${s?.concurrency ?? 4}" min="1" max="4"></label><label>单轮执行上限（分钟）<input type="number" name="maxMinutes" value="${s?.project?.plan.maxMinutes ?? 30}" min="1" max="240"></label><label class="check-row"><input type="checkbox" name="animations" ${animations ? "checked" : ""}>交接动画</label>`,
        async (d) => {
          await api("preferences", {
            concurrency: Number(d.get("concurrency")),
            maxMinutes: Number(d.get("maxMinutes")),
          });
          animations = d.has("animations");
          localStorage.setItem("relay.animations", String(animations));
        },
      );
      break;
    case "pause":
      await api("pause", { paused: true });
      break;
    case "resume":
      await api("request-resume", { requestId: id });
      $<HTMLDialogElement>("#dialog").close();
      break;
    case "stop":
      await api("request-stop");
      break;
    case "manual":
      await api("manual", {
        id,
        enabled: !s?.agents.find((a) => a.id === id)?.manual,
      });
      break;
    case "terminals":
      processId = id;
      terminalsOpen = !terminalsOpen;
      openProcesses.add(id!);
      renderChat();
      break;
    case "show-terminals":
      $<HTMLDialogElement>("#dialog").close();
      processId = id;
      terminalsOpen = true;
      openProcesses.add(id!);
      renderChat();
      processPane.scrollIntoView({ block: "nearest" });
      break;
    case "terminal-page":
      terminalPage = Number(id);
      attachTerminals();
      break;
    case "expand": {
      const p = panels.get(id!);
      p?.el.classList.toggle("expanded");
      if (p) {
        renderAgent(s!.agents.find((a) => a.id === id)!);
        scheduleTerminalFit(p);
      }
      break;
    }
    case "diff": {
      const response = await fetch(
        `/api/diff?requestId=${encodeURIComponent(id!)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error("无法读取成果差异");
      modal("本次改动", `<pre>${escape(await response.text())}</pre>`);
      break;
    }
    case "archived-chats":
      showArchivedDialog();
      break;
    case "archive-open":
      $<HTMLDialogElement>("#dialog").close();
      selectChat(id!);
      break;
    case "archive-delete":
      confirmArchiveDeletion([id!]);
      break;
    case "archive-delete-all":
      confirmArchiveDeletion(
        state!.conversations.filter((c) => c.archivedAt).map((c) => c.id),
      );
      break;
    case "report": {
      const response = await fetch(
        "/api/report?conversationId=" + encodeURIComponent(selectedChat),
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!response.ok) throw new Error("导出失败");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await response.blob());
      a.download = "relay-report.md";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      $<HTMLDialogElement>("#dialog").close();
      break;
    }
    case "approval": {
      const a = s!.approvals.find((a) => a.id === id);
      if (!a || a.status !== "pending") {
        toast("请求已处理或失效");
        break;
      }
      const p = a.presentation ?? approvalPresentation(a.method, a.detail);
      const requestId = s!.activeRequestId;
      const fields = p.fields
        .map(
          (f) =>
            `<div class="approval-field"><strong>${escape(f.label)}</strong><pre>${escape(f.value)}</pre></div>`,
        )
        .join("");
      const agent = s!.agents.find((x) => x.id === a.agentId);
      modal(
        p.title,
        `<p>${escape(agentName(agent))} 请求执行此操作。</p>${p.description ? `<p class="approval-description">${escape(p.description)}</p>` : ""}${fields}<p class="muted">${p.supported ? "授权范围：仅本次操作。" : "此请求需要在原生终端处理。"}</p>${p.supported ? `<button type="button" class="secondary" data-action="reject" data-id="${id}">拒绝</button>` : ""}<button type="button" class="text-button" data-action="show-terminals" data-id="${requestId}">打开终端</button>`,
        p.supported ? () => api("approval", { id, accepted: true }) : undefined,
        "批准本次请求",
      );
      $("#dialog").dataset.approval = id;
      break;
    }
    case "reject":
      await api("approval", { id, accepted: false });
      $<HTMLDialogElement>("#dialog").close();
      break;
  }
}
$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLTextAreaElement>("#prompt");
  const text = input.value.trim();
  if (!text) return;
  const button = $<HTMLButtonElement>(".send-button");
  button.disabled = true;
  try {
    if (!state?.project) throw new Error("请先选择项目");
    if (!members().length) {
      await action("team");
      return;
    }
    await api(activeRequest() && !queueNext ? "supplement" : "request", {
      text,
    });
    input.value = "";
    saveView();
    queueNext = false;
    input.focus();
  } catch (e) {
    toast((e as Error).message);
  } finally {
    button.disabled = false;
  }
});
$("#prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").dispatchEvent(new Event("submit", { cancelable: true }));
  }
});
document.addEventListener("input", () => {
  saveView();
  lastInput = Date.now();
});
document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (el)
    void action(el.dataset.action!, el.dataset.id).catch((e) =>
      toast(e.message),
    );
});
window.addEventListener("beforeunload", saveView);
connect();

// Opening a menu and reading updates never move the conversation viewport.
document.addEventListener("click", (event) => {
  if (!(event.target as Element).closest(".project-context")) {
    $("#project-menu").hidden = true;
    $(".project-add").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    void action("command-palette");
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    void action("chat-new");
    return;
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === "p"
  ) {
    event.preventDefault();
    void action("project");
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "u") {
    event.preventDefault();
    checkForUpdates();
    return;
  }
  if (event.key === "Escape" && !$("#project-menu").hidden) {
    $("#project-menu").hidden = true;
    $(".project-add").setAttribute("aria-expanded", "false");
    $(".project-add").focus({ preventScroll: true });
  }
  if (event.key === "Escape" && $<HTMLDialogElement>("#dialog").open) {
    event.preventDefault();
    $<HTMLDialogElement>("#dialog").close();
  }
});
window.addEventListener("relay:native-command", (event) => {
  const actionName = (event as CustomEvent<string>).detail;
  if (actionName === "escape") {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    return;
  }
  if (
    [
      "chat-new",
      "project",
      "command-palette",
      "latest",
      "toggle-terminals",
    ].includes(actionName)
  )
    void action(actionName).catch((error) => toast((error as Error).message));
  if (actionName === "settings")
    void action("advanced").catch((error) => toast((error as Error).message));
});
