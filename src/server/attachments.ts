import { randomUUID, createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { constants } from "node:fs";
import {
  mkdir,
  writeFile,
  rename,
  rm,
  readdir,
  lstat,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, State } from "../shared/types.ts";
import { Store, ensure, AppError } from "./store.ts";
import { conversation } from "./conversations.ts";
export const IMAGE_LIMIT = 10 * 1024 * 1024;
export const MESSAGE_IMAGE_LIMIT = 40 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function imageType(bytes: Buffer): Attachment["mimeType"] {
  ensure(
    bytes.length > 0 && bytes.length <= IMAGE_LIMIT,
    "IMAGE_SIZE",
    "单张图片最多 10 MiB",
    413,
  );
  if (
    bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let at = 8,
      first = true,
      ended = false,
      data = false;
    while (at + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(at),
        type = bytes.toString("ascii", at + 4, at + 8);
      ensure(
        at + 12 + length <= bytes.length,
        "IMAGE_FORMAT",
        "PNG 图片不完整",
      );
      ensure(
        crc32(bytes.subarray(at + 4, at + 8 + length)) ===
          bytes.readUInt32BE(at + 8 + length),
        "IMAGE_FORMAT",
        "PNG 校验失败",
      );
      if (first)
        ensure(
          type === "IHDR" &&
            length === 13 &&
            bytes.readUInt32BE(at + 8) > 0 &&
            bytes.readUInt32BE(at + 12) > 0 &&
            bytes.readUInt32BE(at + 8) * bytes.readUInt32BE(at + 12) <=
              64_000_000,
          "IMAGE_FORMAT",
          "PNG 尺寸无效或超过 6400 万像素",
        );
      if (type === "IDAT" && length > 0) data = true;
      first = false;
      at += length + 12;
      if (type === "IEND") {
        ended = length === 0 && at === bytes.length;
        break;
      }
    }
    ensure(ended && data, "IMAGE_FORMAT", "PNG 图片不完整");
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  ) {
    let at = 2,
      dimensions = false,
      scan = false;
    while (at + 4 <= bytes.length) {
      ensure(bytes[at] === 255, "IMAGE_FORMAT", "JPEG 标记无效");
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xda) {
        scan = true;
        break;
      }
      const length = bytes.readUInt16BE(at);
      ensure(
        length >= 2 && at + length <= bytes.length,
        "IMAGE_FORMAT",
        "JPEG 图片不完整",
      );
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        ensure(length >= 8, "IMAGE_FORMAT", "JPEG 尺寸无效");
        const h = bytes.readUInt16BE(at + 3),
          w = bytes.readUInt16BE(at + 5);
        ensure(
          h > 0 && w > 0 && h * w <= 64_000_000,
          "IMAGE_FORMAT",
          "JPEG 尺寸无效或超过 6400 万像素",
        );
        dimensions = true;
      }
      at += length;
    }
    ensure(dimensions && scan, "IMAGE_FORMAT", "JPEG 缺少图像数据");
    return "image/jpeg";
  }
  if (
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
  ) {
    let at = 12,
      image = false;
    while (at + 8 <= bytes.length) {
      const name = bytes.toString("ascii", at, at + 4),
        length = bytes.readUInt32LE(at + 4);
      ensure(
        length > 0 && at + 8 + length <= bytes.length,
        "IMAGE_FORMAT",
        "WebP 图片不完整",
      );
      if (["VP8 ", "VP8L"].includes(name)) image = true;
      at += 8 + length + (length % 2);
    }
    ensure(image && at === bytes.length, "IMAGE_FORMAT", "WebP 缺少图像数据");
    return "image/webp";
  }
  throw new AppError("IMAGE_FORMAT", "仅支持完整的 PNG、JPEG、WebP 图片");
}
export class Attachments {
  private busy = new Map<string, number>();
  private retain(id: string) {
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
  }
  private release(id: string) {
    const count = (this.busy.get(id) ?? 1) - 1;
    if (count) this.busy.set(id, count);
    else this.busy.delete(id);
  }
  private closing = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private dataDir: string,
  ) {
    const clean = () => void this.cleanup().catch(() => {});
    this.timer = setInterval(clean, 60 * 60 * 1000);
    this.timer.unref();
    clean();
    store.once("closing", () => {
      this.closing = true;
      clearInterval(this.timer);
    });
  }
  private path(id: string) {
    ensure(uuid.test(id), "ATTACHMENT_ID", "附件 ID 无效");
    return join(this.dataDir, "attachments", id);
  }
  async upload(chatId: string, filename: string, body: Buffer) {
    ensure(!this.closing, "CLOSING", "服务正在关闭");
    const selected = conversation(this.store.state, chatId);
    ensure(!selected.archivedAt, "ARCHIVED", "先恢复归档聊天");
    const mimeType = imageType(body),
      id = randomUUID(),
      path = this.path(id);
    this.retain(id);
    const item: Attachment = {
      id,
      conversationId: chatId,
      filename:
        filename
          .split(/[\\/]/)
          .at(-1)!
          .replace(/[\x00-\x1f]/g, "")
          .slice(0, 200) || "图片",
      mimeType,
      size: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      path: `attachments/${id}`,
      createdAt: new Date().toISOString(),
    };
    try {
      await mkdir(join(this.dataDir, "attachments"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(path + ".part", body, { flag: "wx", mode: 0o600 });
      await rename(path + ".part", path);
      ensure(!this.closing, "CLOSING", "服务正在关闭");
      this.store.mutate((s) => {
        ensure(!conversation(s, chatId).archivedAt, "ARCHIVED", "聊天已归档");
        (s.attachments ??= []).push(item);
      });
      return item;
    } catch (error) {
      await rm(path + ".part", { force: true });
      await rm(path, { force: true });
      throw error;
    } finally {
      this.release(id);
    }
  }
  bind(state: State, chatId: string, ids: string[], requestId: string) {
    ensure(
      ids.length <= 8 && new Set(ids).size === ids.length,
      "IMAGE_COUNT",
      "每条消息最多 8 张图片，不能重复引用",
    );
    const items = ids.map((id) => {
      const item = state.attachments?.find((a) => a.id === id);
      ensure(
        item && item.conversationId === chatId && !item.requestId,
        "ATTACHMENT_SCOPE",
        "附件不存在、已发送或不属于当前聊天",
        409,
      );
      ensure(
        item.requestId ||
          Date.now() - Date.parse(item.createdAt) < 24 * 60 * 60 * 1000,
        "ATTACHMENT_EXPIRED",
        "附件已过期，请重新添加",
        409,
      );
      return item;
    });
    ensure(
      items.reduce((n, a) => n + a.size, 0) <= MESSAGE_IMAGE_LIMIT,
      "IMAGE_SIZE",
      "每条消息图片合计最多 40 MiB",
      413,
    );
    for (const item of items) item.requestId = requestId;
  }
  async read(id: string, chatId: string) {
    const item = this.store.state.attachments?.find((a) => a.id === id);
    ensure(
      item && item.conversationId === chatId,
      "ATTACHMENT_SCOPE",
      "附件不属于当前聊天",
      404,
    );
    ensure(
      item.path === `attachments/${id}` && item.size <= IMAGE_LIMIT,
      "ATTACHMENT_PATH",
      "附件记录无效",
    );
    this.retain(id);
    try {
      const handle = await open(
        this.path(id),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        ensure(
          stat.isFile() && stat.size === item.size,
          "ATTACHMENT_DAMAGED",
          "附件已损坏，请重新添加",
        );
        const bytes = await handle.readFile();
        ensure(
          createHash("sha256").update(bytes).digest("hex") === item.sha256 &&
            imageType(bytes) === item.mimeType,
          "ATTACHMENT_DAMAGED",
          "附件校验失败，请重新添加",
        );
        return { item, bytes, path: this.path(id) };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (
        ["ENOENT", "ELOOP"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw new AppError(
          "ATTACHMENT_MISSING",
          "图片文件缺失或已被替换，请重新添加",
          404,
        );
      throw error;
    } finally {
      this.release(id);
    }
  }
  async remove(id: string, chatId: string) {
    ensure(
      !this.busy.has(id),
      "ATTACHMENT_BUSY",
      "附件正在处理，请稍后重试",
      409,
    );
    this.store.mutate((s) => {
      const item = s.attachments?.find((a) => a.id === id);
      ensure(
        item && item.conversationId === chatId,
        "ATTACHMENT_SCOPE",
        "附件不属于当前聊天",
        404,
      );
      ensure(
        !item.requestId,
        "ATTACHMENT_SENT",
        "已发送附件随聊天保存，不能单独删除",
        409,
      );
      s.attachments = s.attachments!.filter((a) => a.id !== id);
    });
    await rm(this.path(id), { force: true });
  }
  async cleanup() {
    if (this.closing) return;
    const now = Date.now(),
      expired =
        this.store.state.attachments?.filter(
          (a) =>
            !a.requestId &&
            !this.busy.has(a.id) &&
            now - Date.parse(a.createdAt) >= 86400000,
        ) ?? [];
    if (expired.length)
      this.store.mutate((s) => {
        s.attachments = s.attachments?.filter(
          (a) =>
            a.requestId ||
            this.busy.has(a.id) ||
            now - Date.parse(a.createdAt) < 86400000,
        );
      });
    await this.removeFiles(expired.map((a) => a.id));
    let files: string[];
    try {
      files = await readdir(join(this.dataDir, "attachments"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const file of files) {
      const id = file.replace(/\.part$/, "");
      if (
        !uuid.test(id) ||
        this.busy.has(id) ||
        this.store.state.attachments?.some((a) => a.id === id)
      )
        continue;
      const stat = await lstat(join(this.dataDir, "attachments", file));
      if (now - stat.mtimeMs >= 86400000)
        await rm(join(this.dataDir, "attachments", file), { force: true });
    }
  }
  async removeFiles(ids: string[]) {
    for (const id of ids) await rm(this.path(id), { force: true });
  }
}
