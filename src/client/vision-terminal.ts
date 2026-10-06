import { Terminal } from "@xterm/xterm";
import { approvalPresentation } from "../shared/presentation.ts";
import type { Provider, State } from "../shared/types.ts";

/** Independent diagnostics only. Typing is opt-in and scoped to the observed generation. */
export function openVisionTerminal(provider: Provider, token: string) {
  const dialog = document.createElement("dialog");
  dialog.className = "vision-dialog";
  dialog.innerHTML =
    '<h2>图片能力验证</h2><p>这是独立诊断会话；不改变团队成员身份。登录、信任与权限提示请自行核对。</p><p class="vision-attention" role="status">正在启动…</p><div class="vision-approvals"></div><div class="vision-screen"></div><button type="button" class="vision-manual" disabled>人工接管验证终端</button> <button type="button" class="vision-close">关闭窗口</button>';
  document.body.append(dialog);
  dialog.showModal();
  const terminal = new Terminal({
    cols: 100,
    rows: 28,
    scrollback: 1000,
    disableStdin: true,
    fontSize: 12,
  });
  terminal.open(dialog.querySelector<HTMLElement>(".vision-screen")!);
  let generation = "offline",
    manual = false,
    finished = false,
    disposed = false,
    seq = -1;
  const button = dialog.querySelector<HTMLButtonElement>(".vision-manual")!,
    note = dialog.querySelector<HTMLElement>(".vision-attention")!,
    approvals = dialog.querySelector<HTMLElement>(".vision-approvals")!;
  const send = async (body: object) => {
    const response = await fetch(`/api/vision-check/${provider}/terminal`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ generation, ...body }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error?.message ?? "验证终端输入失败");
  };
  button.onclick = () => {
    void send({ manual: !manual })
      .then(() => {
        manual = !manual;
        terminal.options.disableStdin = !manual;
        button.textContent = manual ? "退出人工接管" : "人工接管验证终端";
        if (manual) terminal.focus();
      })
      .catch((e) => (note.textContent = e.message));
  };
  terminal.onData((data) => {
    if (manual && !finished)
      void send({ data }).catch((e) => (note.textContent = e.message));
  });
  const poll = async () => {
    if (disposed || finished) return;
    try {
      const response = await fetch(`/api/vision-check/${provider}/terminal`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const state = await response.json();
        generation = state.generation;
        button.disabled = generation === "offline";
        note.textContent =
          state.attention || "验证中；需要输入时开启人工接管。";
        if (state.seq !== seq) {
          seq = state.seq;
          terminal.reset();
          terminal.resize(state.cols, state.rows);
          terminal.write(state.data);
        }
        if (
          !approvals.matches(":hover") &&
          !approvals.contains(document.activeElement)
        ) {
          approvals.replaceChildren();
          for (const item of state.approvals as State["approvals"]) {
            const description = approvalPresentation(item.method, item.detail);
            const row = document.createElement("p");
            row.textContent =
              description.title + " " + (description.description ?? "");
            approvals.append(row);
            if (description.supported)
              for (const accepted of [true, false]) {
                const choice = document.createElement("button");
                choice.type = "button";
                choice.textContent = accepted ? "允许本次操作" : "拒绝";
                choice.onclick = () =>
                  void send({ approvalId: item.id, accepted }).catch(
                    (e) => (note.textContent = e.message),
                  );
                row.append(choice);
              }
          }
        }
      }
    } catch (e) {
      note.textContent = (e as Error).message;
    }
    if (!disposed && !finished) timer = setTimeout(() => void poll(), 1000);
  };
  let timer: ReturnType<typeof setTimeout>;
  void poll();
  const dispose = () => {
    if (manual && !finished) void send({ manual: false }).catch(() => {});
    disposed = true;
    clearTimeout(timer);
    terminal.dispose();
    dialog.remove();
  };
  dialog.querySelector<HTMLButtonElement>(".vision-close")!.onclick = () =>
    dialog.close();
  dialog.onclose = dispose;
  return (message: string) => {
    finished = true;
    clearTimeout(timer);
    if (disposed) return;
    button.disabled = true;
    terminal.options.disableStdin = true;
    note.textContent = message;
  };
}
