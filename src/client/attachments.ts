import type { Attachment, State } from "../shared/types.ts";
const MAX_FILE = 10 * 1024 * 1024,
  MAX_TOTAL = 40 * 1024 * 1024;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type Draft = {
  key: string;
  file?: File;
  id?: string;
  url?: string;
  status: "uploading" | "ready" | "failed";
  error?: string;
  size: number;
  filename: string;
};
export class AttachmentUI {
  private drafts = new Map<string, Draft[]>();
  private urls = new Map<string, string>();
  private fetching = new Set<string>();
  private sending = false;
  constructor(
    private context: () => { chatId: string; token: string; state?: State },
    private error: (s: string) => void,
  ) {
    const picker = document.querySelector<HTMLInputElement>("#image-picker")!,
      composer = document.querySelector<HTMLElement>("#composer")!,
      prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
    document
      .querySelector("#add-image")!
      .addEventListener("click", () => picker.click());
    picker.onchange = () => {
      void this.add([...(picker.files ?? [])]);
      picker.value = "";
    };
    composer.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        composer.classList.add("image-drop");
      }
    });
    composer.addEventListener("dragleave", () =>
      composer.classList.remove("image-drop"),
    );
    composer.addEventListener("drop", (e) => {
      if (e.dataTransfer?.files.length) {
        e.preventDefault();
        composer.classList.remove("image-drop");
        void this.add([...e.dataTransfer.files]);
      }
    });
    prompt.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.items ?? [])]
        .filter((x) => x.kind === "file")
        .map((x) => x.getAsFile())
        .filter((x): x is File => !!x);
      if (files.length) {
        e.preventDefault();
        void this.add(files);
        return;
      }
      if (e.clipboardData?.getData("text/plain")) return;
      const bridge = (window as any).webkit?.messageHandlers?.relayClipboard;
      if (bridge && document.activeElement === prompt) {
        const chatId = this.context().chatId;
        void bridge
          .postMessage({ action: "pasteImage" })
          .then((value: any) => {
            if (
              value?.data &&
              this.context().chatId === chatId &&
              document.activeElement === prompt
            ) {
              const binary = atob(value.data),
                bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
              void this.add([
                new File([bytes], "粘贴截图.png", { type: "image/png" }),
              ]);
            }
          })
          .catch((e: Error) => this.error(e.message));
      }
    });
    document.addEventListener("click", (e) => {
      const target = (e.target as Element).closest<HTMLElement>(
        "[data-attachment-action]",
      );
      if (!target) return;
      const id = target.dataset.attachmentId!;
      if (target.dataset.attachmentAction === "preview") void this.preview(id);
      else if (target.dataset.attachmentAction === "remove")
        void this.remove(id);
      else if (target.dataset.attachmentAction === "retry") {
        const row = this.rows().find((x) => x.key === id);
        if (row?.file) void this.upload(row, this.context().chatId);
      }
    });
    window.addEventListener("beforeunload", () => {
      for (const url of this.urls.values()) URL.revokeObjectURL(url);
    });
  }
  private rows() {
    const { chatId, state } = this.context();
    if (!this.drafts.has(chatId)) {
      let ids: string[] = [];
      try {
        ids = JSON.parse(
          sessionStorage.getItem("relay.images." + chatId) ?? "[]",
        );
      } catch {}
      this.drafts.set(
        chatId,
        (state?.attachments ?? [])
          .filter(
            (a) =>
              ids.includes(a.id) && a.conversationId === chatId && !a.requestId,
          )
          .map((a) => ({
            key: a.id,
            id: a.id,
            status: "ready",
            filename: a.filename,
            size: a.size,
          })),
      );
    }
    return this.drafts.get(chatId)!;
  }
  private persist(chatId: string) {
    sessionStorage.setItem(
      "relay.images." + chatId,
      JSON.stringify(
        (this.drafts.get(chatId) ?? []).filter((a) => a.id).map((a) => a.id),
      ),
    );
  }
  async add(files: File[]) {
    if (this.sending) return;
    const rows = this.rows(),
      chatId = this.context().chatId;
    for (const file of files) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        this.error("仅支持 PNG、JPEG、WebP 图片");
        continue;
      }
      if (
        rows.length >= 8 ||
        file.size > MAX_FILE ||
        rows.reduce((n, a) => n + a.size, 0) + file.size > MAX_TOTAL
      ) {
        this.error("最多 8 张图片；单张 10 MiB，合计 40 MiB");
        continue;
      }
      const row: Draft = {
        key: crypto.randomUUID(),
        file,
        status: "uploading",
        size: file.size,
        filename: file.name,
        url: URL.createObjectURL(file),
      };
      rows.push(row);
      void this.upload(row, chatId);
    }
    this.render();
  }
  private async upload(row: Draft, chatId: string) {
    row.status = "uploading";
    row.error = undefined;
    this.render();
    try {
      const response = await fetch(
        `/api/attachments?conversationId=${encodeURIComponent(chatId)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.context().token}`,
            "Content-Type": "application/octet-stream",
            "X-Relay-Filename": encodeURIComponent(row.filename),
          },
          body: row.file,
        },
      );
      const result = await response.json();
      if (!response.ok) throw Error(result.error?.message ?? "上传失败");
      row.id = result.id;
      row.status = "ready";
      this.persist(chatId);
    } catch (error) {
      row.status = "failed";
      row.error = (error as Error).message;
    }
    this.render();
  }
  ids() {
    const rows = this.rows();
    if (rows.some((a) => a.status !== "ready"))
      throw Error("请等待图片上传完成，或移除失败的图片");
    return rows.map((a) => a.id!);
  }
  lock(value: boolean) {
    this.sending = value;
    this.render();
  }
  sent(chatId: string) {
    for (const row of this.drafts.get(chatId) ?? [])
      if (row.url) URL.revokeObjectURL(row.url);
    this.drafts.delete(chatId);
    sessionStorage.removeItem("relay.images." + chatId);
    this.render();
  }
  private async remove(key: string) {
    if (this.sending) return;
    const rows = this.rows(),
      row = rows.find((a) => a.key === key);
    if (!row || row.status === "uploading") return;
    if (row.id) {
      const r = await fetch(
        `/api/attachments/${row.id}?conversationId=${this.context().chatId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.context().token}` },
        },
      );
      if (!r.ok) {
        this.error((await r.json()).error?.message ?? "移除失败");
        return;
      }
    }
    if (row.url) URL.revokeObjectURL(row.url);
    rows.splice(rows.indexOf(row), 1);
    this.persist(this.context().chatId);
    this.render();
  }
  markup(ids: string[] = []) {
    return ids.length
      ? `<div class="message-images">${ids.map((id) => `<button type="button" class="attachment-preview" data-attachment-action="preview" data-attachment-id="${escape(id)}" aria-label="查看附件图片"><img data-image-id="${escape(id)}" ${this.urls.has(id) ? `src="${this.urls.get(id)}"` : ""} alt="图片附件"><span class="image-status">加载图片…</span></button>`).join("")}</div>`
      : "";
  }
  render() {
    const root = document.querySelector<HTMLElement>("#draft-images")!;
    const rows = this.rows();
    root.innerHTML = rows
      .map(
        (a) =>
          `<div class="draft-image"><button type="button" class="attachment-preview" ${a.id ? `data-attachment-action="preview" data-attachment-id="${a.id}"` : ""} aria-label="预览 ${escape(a.filename)}">${a.url ? `<img src="${a.url}" alt="${escape(a.filename)}">` : `<img data-image-id="${a.id}" alt="${escape(a.filename)}">`}</button><small>${a.status === "uploading" ? "上传中…" : a.status === "failed" ? escape(a.error ?? "上传失败") : escape(a.filename)}</small>${a.status === "failed" ? `<button type="button" data-attachment-action="retry" data-attachment-id="${a.key}" ${this.sending ? "disabled" : ""}>重试</button>` : ""}<button type="button" class="text-button" data-attachment-action="remove" data-attachment-id="${a.key}" aria-label="移除 ${escape(a.filename)}" ${a.status === "uploading" || this.sending ? "disabled" : ""}>移除</button></div>`,
      )
      .join("");
    document.querySelector<HTMLButtonElement>("#add-image")!.disabled =
      this.sending;
    document.querySelector<HTMLButtonElement>(".send-button")!.disabled =
      this.sending || rows.some((a) => a.status !== "ready");
    this.hydrate();
  }
  private async url(id: string) {
    if (this.urls.has(id)) return this.urls.get(id)!;
    const { state, token, chatId } = this.context(),
      item = state?.attachments?.find((a) => a.id === id);
    const response = await fetch(
      `/api/attachments/${id}?conversationId=${item?.conversationId ?? chatId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok)
      throw Error((await response.json()).error?.message ?? "图片无法读取");
    const url = URL.createObjectURL(await response.blob());
    this.urls.set(id, url);
    return url;
  }
  hydrate() {
    for (const image of document.querySelectorAll<HTMLImageElement>(
      "img[data-image-id]",
    )) {
      const id = image.dataset.imageId!;
      if (image.src || this.fetching.has(id)) continue;
      this.fetching.add(id);
      void this.url(id)
        .then((url) => {
          for (const el of document.querySelectorAll<HTMLImageElement>(
            `img[data-image-id="${id}"]`,
          )) {
            el.src = url;
            const status = el.parentElement?.querySelector(".image-status");
            if (status) status.textContent = "";
            el.onerror = () => {
              if (status) status.textContent = "图片内容无法解码";
            };
          }
        })
        .catch((error) => {
          const status = image.parentElement?.querySelector(".image-status");
          if (status) status.textContent = error.message;
        })
        .finally(() => this.fetching.delete(id));
    }
  }
  private async preview(id: string) {
    try {
      const url = await this.url(id);
      const dialog = document.createElement("dialog");
      dialog.className = "image-dialog";
      dialog.innerHTML = `<button type="button" aria-label="关闭图片">关闭</button><img alt="附件原图">`;
      dialog.querySelector("img")!.src = url;
      dialog.querySelector("button")!.onclick = () => dialog.close();
      dialog.onclose = () => dialog.remove();
      document.body.append(dialog);
      dialog.showModal();
    } catch (error) {
      this.error((error as Error).message);
    }
  }
}
