import { test, expect } from "@playwright/test";
import { fixture, until } from "../helpers.ts";
import { createHttp } from "../../src/server/http.ts";
import { resolve } from "node:path";
import type { LocalPathSelection } from "../../src/server/local-picker.ts";
let folderSelection: LocalPathSelection | null = null;
const extraFixtures: Awaited<ReturnType<typeof fixture>>[] = [];
let f: Awaited<ReturnType<typeof fixture>>,
  app: Awaited<ReturnType<typeof createHttp>>;
test.beforeEach(async () => {
  f = await fixture();
  f.agent("Codex 1");
  f.agent("Antigravity 1");
  folderSelection = null;
  app = await createHttp(f.service, {
    port: 0,
    root: resolve("."),
    pickFolder: async () => folderSelection,
  });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await f.service.collaboration.stop();
  await app.close();
  for (const extra of extraFixtures.splice(0)) await extra.cleanup();
  await f.cleanup();
});
async function open(page: import("@playwright/test").Page) {
  await page.route("**/api/models/*", (route) =>
    route.fulfill({
      json: {
        provider: route.request().url().split("/").at(-1),
        source: "测试模型目录",
        models: [
          { id: "quick", name: "快速模型", efforts: ["low", "medium"] },
          { id: "deep", name: "深度模型", efforts: ["high", "max"] },
        ],
      },
    }),
  );
  await page.goto(`${app.url}/#token=${f.service.auth.consoleToken}`);
  await expect(page.locator("#project-button")).not.toContainText("选择项目");
}
test("IME candidate confirmation never submits the composer", async ({
  page,
}) => {
  await open(page);
  const input = page.locator("#prompt");
  await input.fill("如图");
  const prevented = await input.evaluate((el) => {
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented, "IME owns candidate-confirmation Enter").toBe(false);
  await expect(input).toHaveValue("如图");
  expect(f.store.state.userRequests).toHaveLength(0);
  expect(f.runtime.starts).toHaveLength(0);
});

test("WebKit compositionend before keydown with keyCode 229 never sends", async ({
  page,
}) => {
  await open(page);
  const input = page.locator("#prompt");
  await input.fill("如图");
  const prevented = await input.evaluate((el) => {
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    el.dispatchEvent(
      new CompositionEvent("compositionend", { data: "如图", bubbles: true }),
    );
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      isComposing: false,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(input).toHaveValue("如图");
  expect(f.store.state.userRequests).toHaveLength(0);
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("如图\n");
  expect(f.store.state.userRequests).toHaveLength(0);
  await input.press("Enter");
  await expect(page.locator(".user-message")).toContainText("如图");
  expect(f.store.state.userRequests).toHaveLength(1);
});

test("sidebar shortcut follows native commands and leaves IME keys alone", async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press("Meta+b");
  await expect(page.locator("#chat-sidebar")).toBeHidden();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("relay:native-command", { detail: "sidebar" }),
    ),
  );
  await expect(page.locator("#chat-sidebar")).toBeVisible();
  await page.locator("#prompt").evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        metaKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect(page.locator("#chat-sidebar")).toBeVisible();
});

test("manual takeover survives quoted credential text in persisted model output", async ({
  page,
}) => {
  f.service.collaboration.submit("查看模型输出并人工接管");
  await until(() => f.runtime.starts.length > 0);
  f.store.mutate((s) => {
    s.agents[0].error = 'password=demo"quoted" api_key=demo\\path';
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await page.locator(".process > summary").click();
  await page.getByRole("button", { name: "查看真实终端", exact: true }).click();
  await page
    .getByRole("button", { name: "人工接管", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "退出人工接管", exact: true }).first(),
  ).toBeVisible();
  expect(f.store.state.agents[0].manual).toBe(true);
  await expect(page.locator("#toasts")).not.toContainText("JSON");
  expect(errors).toEqual([]);
});

test("one prompt starts collaboration without manual configuration; live events preserve composer focus", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await expect(page.locator(".terminal-panel")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "批准计划", exact: true }),
  ).toHaveCount(0);
  await page.locator("#prompt").fill("审查项目并说明功能");
  await page.locator("#prompt").press("Enter");
  await expect(page.locator(".user-message")).toContainText(
    "审查项目并说明功能",
  );
  await until(() => Boolean(f.store.state.userRequests[0]?.control));
  expect(f.runtime.starts.length).toBe(1);
  const input = page.locator("#prompt");
  await input.fill("补充说明");
  await f.service.sendMessage("user", {
    targetId: f.store.state.agents[0].id,
    text: "真实状态更新",
  });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("补充说明");
  await page.reload();
  await expect(page.locator(".user-message")).toHaveCount(1);
  expect(f.runtime.starts.length).toBe(1);
  await page.screenshot({
    path: "test-results/chat-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("process folding keeps native terminal element; theme and desktop controls remain usable", async ({
  page,
}) => {
  f.service.collaboration.submit("审查项目");
  await open(page);
  await page.getByText("查看协作过程", { exact: false }).click();
  await page.getByRole("button", { name: "查看真实终端" }).click();
  await expect(page.locator(".terminal-panel:visible")).toHaveCount(2);
  const terminal = await page.locator(".xterm").first().elementHandle();
  await page.locator(".process > summary").click();
  await expect(page.locator(".terminal-panel:visible")).toHaveCount(0);
  await page.locator(".process > summary").click();
  expect(
    await terminal!.evaluate(
      (el) => el.isConnected && el === document.querySelector(".xterm"),
    ),
  ).toBeTruthy();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /切换到.*主题/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `width ${width}`,
    ).toBeTruthy();
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.screenshot({
    path: "test-results/chat-desktop-resized.png",
    fullPage: false,
  });
});

test("command palette supports keyboard opening, filtering and native update command", async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog")).toContainText("命令面板");
  await page.locator("#command-filter").fill("更新");
  await expect(
    page.locator('.command-list [data-action="check-updates"]'),
  ).toBeVisible();
  await expect(
    page.locator('.command-list [data-action="chat-new"]'),
  ).toBeHidden();
  await page.locator('.command-list [data-action="check-updates"]').click();
  await expect(page.locator("#toasts")).toContainText("检查更新");
  await page.evaluate(() => {
    const messages: unknown[] = [];
    Object.assign(window, {
      nativeMessages: messages,
      webkit: {
        messageHandlers: {
          relayNative: { postMessage: (body: unknown) => messages.push(body) },
        },
      },
    });
  });
  await page.keyboard.press("Meta+k");
  await page.locator('.command-list [data-action="check-updates"]').click();
  expect(
    await page.evaluate(
      () => (window as Window & { nativeMessages?: unknown[] }).nativeMessages,
    ),
  ).toEqual([{ action: "checkForUpdates" }]);
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("relay:native-command", { detail: "escape" }),
    ),
  );
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
test("team chooser requires only tool counts and advanced settings stay under More", async ({
  page,
}) => {
  await open(page);
  await page.locator("#team-button").click();
  await expect(
    page.locator("[name=name],[name=role],[name=ownerId],[name=acceptance]"),
  ).toHaveCount(0);
  await expect(page.locator("dialog input[type=number]")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(page.locator("#team-button")).toBeFocused();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "高级设置" }).click();
  await expect(page.locator("[name=maxMinutes]")).toHaveValue("30");
  await page.keyboard.press("Escape");
  expect(f.runtime.starts).toHaveLength(0);
});

test("eight seats page on demand without recreating terminals", async ({
  page,
}) => {
  for (let i = 3; i <= 8; i++) f.agent(`Codex ${i}`);
  f.service.collaboration.submit("分析项目");
  await open(page);
  await page.locator(".process > summary").click();
  await page.getByRole("button", { name: "查看真实终端" }).click();
  await expect(page.locator(".terminal-panel")).toHaveCount(8);
  await expect(page.locator(".terminal-panel:visible")).toHaveCount(4);
  const first = await page.locator(".xterm").first().elementHandle();
  await page.getByRole("button", { name: "终端 5–8" }).click();
  await expect(page.locator(".terminal-panel:visible").last()).toContainText(
    "Codex 8",
  );
  await page.getByRole("button", { name: "终端 1–4" }).click();
  expect(
    await first!.evaluate(
      (el) => el.isConnected && el === document.querySelector(".xterm"),
    ),
  ).toBeTruthy();
});

test("native terminal permission hint opens the same hidden session without marking completion", async ({
  page,
}) => {
  f.service.collaboration.submit("审查项目");
  await open(page);
  await until(() => Boolean(f.store.state.userRequests[0]?.control));
  const id = f.store.state.agents[0].id;
  f.runtime.emit("event", {
    agentId: id,
    type: "attention",
    detail: "原生文件权限提示",
  });
  await expect(
    page
      .locator("#pending-requests")
      .getByText("原生文件权限提示", { exact: false }),
  ).toBeVisible();
  await page
    .locator("#pending-requests")
    .getByRole("button", { name: "打开终端" })
    .click();
  await expect(page.locator(".terminal-panel:visible")).toHaveCount(2);
  expect(f.store.state.userRequests[0].status).toBe("planning");
  expect(f.runtime.starts.length).toBe(1);
});

test("changing the idle team preserves historical member identities and never attaches a new terminal to an old request", async ({
  page,
}) => {
  f.service.collaboration.submit("历史需求");
  await until(() => Boolean(f.store.state.activeRequestId));
  await f.service.sendMessage("user", {
    targetId: f.store.state.agents[1].id,
    text: "原团队的交流",
  });
  await f.service.collaboration.stop();
  await f.service.collaboration.configureTeam({ codex: 1 });
  await open(page);
  await page.locator(".process > summary").click();
  await page.locator(".messages > summary").click();
  await expect(page.locator(".internal-message")).toContainText("Codex 2");
  await expect(page.getByRole("button", { name: "查看真实终端" })).toHaveCount(
    0,
  );
  await expect(page.locator(".terminal-panel")).toHaveCount(0);
});

test("restart recovery is available only when needed and does not restart a CLI", async ({
  page,
}) => {
  const id = f.store.state.agents[0].id;
  f.store.mutate((s) => {
    s.agents[0].status = "recovery";
    s.agents[0].cwd = f.repo;
  });
  await open(page);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "恢复成员", exact: true }).click();
  await expect(page.locator("dialog")).toContainText(
    "仍存活的 PID 会被后台拒绝",
  );
  await page.getByRole("button", { name: "已检查，恢复成员" }).click();
  await until(
    () => f.store.state.agents.find((a) => a.id === id)?.status === "stopped",
  );
  expect(f.runtime.starts).toHaveLength(0);
});

test("member model/effort linkage and team permissions persist without inference", async ({
  page,
}) => {
  await open(page);
  await page.locator("#team-button").click();
  await expect(page.locator('[name="permissionMode"]')).toHaveValue("native");
  await page.getByRole("spinbutton", { name: "Codex 数量" }).fill("2");
  await page.getByRole("spinbutton", { name: "Antigravity 数量" }).fill("0");
  await page
    .getByRole("combobox", { name: "Codex 1 模型", exact: true })
    .selectOption("quick");
  await page
    .getByRole("combobox", { name: "Codex 1 思考强度", exact: true })
    .selectOption("low");
  await page
    .getByRole("combobox", { name: "Codex 2 模型", exact: true })
    .selectOption("deep");
  await page
    .getByRole("combobox", { name: "Codex 2 思考强度", exact: true })
    .selectOption("max");
  await page
    .getByRole("combobox", { name: "Codex 1 模型", exact: true })
    .selectOption("deep");
  await expect(
    page.getByRole("combobox", { name: "Codex 1 思考强度", exact: true }),
  ).toHaveValue("");
  await page.locator('[name="permissionMode"]').selectOption("full");
  await expect(page.locator(".permission-help")).toContainText(
    "包括项目外文件",
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
  expect(
    f.store.state.agents.map((a) => [
      a.model,
      a.reasoningEffort,
      a.permissionMode,
    ]),
  ).toEqual([
    ["deep", undefined, "full"],
    ["deep", "max", "full"],
  ]);
  expect(f.runtime.starts).toHaveLength(0);
  const ids = f.store.state.agents.map((a) => a.id);
  await page.locator("#team-button").click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect(f.store.state.agents.map((a) => a.id)).toEqual(ids);
});

test("Anti model list updates focused controls, lists every returned model and saves full ID without effort", async ({
  page,
}) => {
  f.store.mutate((s) => {
    Object.assign(s.agents[1], {
      provider: "antigravity",
      model: "gemini-3.8-flash-high",
    });
  });
  await open(page);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const models = [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  ];
  await page.route("**/api/models/antigravity*", async (route) => {
    await ready;
    await route.fulfill({
      json: {
        provider: "antigravity",
        source: "Antigravity 原生模型目录",
        models,
      },
    });
  });
  await page.locator("#team-button").click();
  const picker = page.getByRole("combobox", {
    name: "Antigravity 1 模型",
    exact: true,
  });
  await picker.focus();
  await picker.evaluate((el) => ((window as any).focusedModelPicker = el));
  release();
  await expect(picker.locator("option")).toHaveCount(models.length + 1);
  expect(
    await picker.evaluate((el) => (window as any).focusedModelPicker === el),
  ).toBe(true);
  await expect(picker).toBeFocused();
  await expect(picker).toHaveValue("gemini-3.8-flash-high");
  await expect(page.locator(".custom-model")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Antigravity 1 思考强度", exact: true }),
  ).toHaveCount(0);
  await picker.selectOption("claude-sonnet-4-6");
  await page.screenshot({ path: "test-results/model-list.png" });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
  expect(
    f.store.state.agents.find((a) => a.provider === "antigravity")?.model,
  ).toBe("claude-sonnet-4-6");
  expect(
    f.store.state.agents.find((a) => a.provider === "antigravity")
      ?.reasoningEffort,
  ).toBeUndefined();
  expect(f.runtime.starts).toHaveLength(0);
});

test("fixed requests stay reachable in long chat; readable approval hides protocol and preserves focus/history/terminal", async ({
  page,
}) => {
  const { id } = f.service.collaboration.submit("长对话");
  await until(() => Boolean(f.store.state.userRequests[0]?.control));
  await f.service.collaboration.stop();
  f.store.mutate((s) => {
    s.chat.push({
      id: crypto.randomUUID(),
      requestId: id,
      role: "assistant",
      text: "历史记录\n".repeat(300),
      createdAt: new Date().toISOString(),
    });
  });
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  for (const approvalId of [first, second])
    f.runtime.emit("event", {
      agentId: f.store.state.agents[0].id,
      type: "approval",
      request: {
        id: approvalId,
        method: "mcpServer/elicitation/request",
        params: {
          mode: "form",
          threadId: "secret-session-marker",
          message:
            'Allow the relay MCP server to run tool "get_project_state"?',
          _meta: { tool_description: "读取项目、成员和收件箱" },
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });
  await open(page);
  await expect(page.locator("#pending-requests .approval-card")).toHaveCount(2);
  const dock = await page.locator("#pending-requests").boundingBox(),
    composer = await page.locator("#composer").boundingBox();
  expect(dock!.y + dock!.height).toBeLessThanOrEqual(composer!.y);
  expect(dock!.height).toBeLessThanOrEqual(250);
  await page.locator(".conversation").evaluate((el) => (el.scrollTop = 120));
  await page.locator("#prompt").fill("仍在输入");
  f.store.mutate((s) => {
    s.agents[0].connectionWarning = "接续能力尚未确认";
  });
  await expect(page.locator("#pending-requests")).toContainText(
    "接续能力尚未确认",
  );
  await expect(page.locator("#prompt")).toBeFocused();
  expect(
    await page.locator(".conversation").evaluate((el) => el.scrollTop),
  ).toBe(120);
  await page
    .locator('#pending-requests [data-action="approval"]')
    .first()
    .click();
  await expect(page.locator("dialog")).toContainText("读取项目协作状态");
  await expect(page.locator("dialog")).not.toContainText("requestedSchema");
  await expect(page.locator("dialog")).not.toContainText(
    "secret-session-marker",
  );
  await expect(page.locator("dialog")).not.toContainText("mcpServer/");
  await page.getByRole("button", { name: "批准本次请求" }).click();
  await expect(page.locator("#pending-requests .approval-card")).toHaveCount(1);
  await page
    .locator('#pending-requests [data-action="show-terminals"]')
    .first()
    .click();
  const terminal = await page.locator(".xterm").first().elementHandle();
  f.store.mutate((s) => {
    s.agents[0].attention = "需要登录";
  });
  await expect(page.locator("#pending-requests")).toContainText("需要登录");
  expect(
    await terminal!.evaluate(
      (el) => el.isConnected && el === document.querySelector(".xterm"),
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/fixed-requests-desktop.png" });
});

test("catalog failure retains saved model and default without custom input; busy team cannot change permissions", async ({
  page,
}) => {
  await f.service.collaboration.configureTeam({
    members: [{ provider: "claude", model: "my-saved-model" }],
    permissionMode: "native",
  });
  await open(page);
  await page.route("**/api/models/claude", (route) =>
    route.fulfill({
      json: {
        provider: "claude",
        models: [],
        source: "CLI",
        error: "目录暂不可用",
      },
    }),
  );
  await page.locator("#team-button").click();
  await page.getByRole("spinbutton", { name: "Claude Code 数量" }).fill("1");
  await expect(
    page.locator('[data-provider="claude"] .catalog-note'),
  ).toContainText("目录暂不可用");
  const picker = page.getByRole("combobox", {
    name: "Claude Code 1 模型",
    exact: true,
  });
  await expect(picker).toHaveValue("my-saved-model");
  await expect(picker.locator("option")).toHaveCount(2);
  await expect(page.locator(".custom-model")).toHaveCount(0);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
  expect(f.store.state.agents.find((a) => a.provider === "claude")?.model).toBe(
    "my-saved-model",
  );
  expect(f.runtime.starts).toHaveLength(0);
  f.service.collaboration.submit("开始");
  await until(() => Boolean(f.store.state.activeRequestId));
  await page.locator("#team-button").click();
  await expect(page.locator('[name="permissionMode"]')).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
});

test("chat history switches without inference, retains draft/disclosures/reading and protects deletion", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const first = f.store.state.defaultConversationId;
  const request = f.service.collaboration.submit("原聊天");
  await f.service.collaboration.stop(first);
  await open(page);
  await page.locator(".process > summary").click();
  await page.locator("#prompt").fill("未发送草稿");
  const starts = f.runtime.starts.length;
  await page.getByRole("button", { name: "新建聊天", exact: true }).click();
  await expect(page.locator(".user-message")).toHaveCount(0);
  await page.locator("#prompt").fill("第二份草稿");
  await page
    .locator('[data-action="chat-select"][data-id="' + first + '"]')
    .click();
  await expect(page.locator("#prompt")).toHaveValue("未发送草稿");
  await expect(page.locator(".process")).toHaveAttribute("open", "");
  expect(f.runtime.starts.length).toBe(starts);
  const second = f.store.state.conversations.find((c) => c.id !== first)!.id;
  await page
    .locator('[data-action="chat-archive"][data-id="' + second + '"]')
    .click();
  await expect
    .poll(() =>
      Boolean(
        f.store.state.conversations.find((c) => c.id === second)?.archivedAt,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "切换聊天历史", exact: true }).click();
  await expect(page.locator("#chat-sidebar")).toBeHidden();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "历史需求", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "已归档对话", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("已归档的对话");
  await expect(page.locator("#chat-sidebar")).toBeHidden();
  await expect(page.locator("#chat-sidebar details")).toHaveCount(0);
  await expect(page.locator("#archive-search")).toBeFocused();
  await expect(page.locator(".archive-row")).toHaveCount(1);
  await page.locator("#archive-search").fill("没有匹配的标题");
  await expect(page.locator("#archive-list")).toContainText("没有匹配");
  await page.locator("#archive-search").fill("");
  await expect(page.locator("#prompt")).toHaveValue("未发送草稿");
  await expect(page.locator(".process")).toHaveAttribute("open", "");
  expect(f.runtime.starts.length).toBe(starts);
  await page.screenshot({ path: "test-results/archived-dialog-dark.png" });
  await page
    .locator('[data-action="chat-restore"][data-id="' + second + '"]')
    .click();
  await expect(page.locator("#archive-list")).toContainText("暂无已归档对话");
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.getByRole("button", { name: "切换聊天历史", exact: true }).click();
  await page
    .locator('[data-action="chat-delete"][data-id="' + second + '"]')
    .click();
  await expect(page.getByRole("dialog")).toContainText("CLI 全局历史保留");
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect
    .poll(() => f.store.state.conversations.some((c) => c.id === second))
    .toBe(false);
  expect(
    f.store.state.userRequests.find((r) => r.id === request.id),
  ).toBeTruthy();
});

test("archive manager sorts, opens history and confirms single or bulk deletion without inference", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const original = f.store.state.defaultConversationId;
  const alpha = f.service.collaboration.createConversation();
  const beta = f.service.collaboration.createConversation();
  f.service.collaboration.archiveConversation(alpha.id, true);
  f.service.collaboration.archiveConversation(beta.id, true);
  f.store.mutate((s) => {
    Object.assign(
      s.conversations.find((c) => c.id === alpha.id)!,
      { title: "Alpha 审查", archivedAt: "2026-10-01T12:00:00.000Z" },
    );
    Object.assign(
      s.conversations.find((c) => c.id === beta.id)!,
      { title: "Beta 修复", archivedAt: "2026-10-02T12:00:00.000Z" },
    );
  });
  await open(page);
  await expect(
    page.locator('#chat-sidebar [data-id="' + alpha.id + '"]'),
  ).toHaveCount(0);
  const show = async () => {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: "已归档对话", exact: true }).click();
  };
  await show();
  await expect(page.locator(".archive-chat").first()).toContainText("Beta");
  await page.locator("#archive-sort").selectOption("oldest");
  await expect(page.locator(".archive-chat").first()).toContainText("Alpha");
  await page
    .locator('[data-action="archive-open"][data-id="' + alpha.id + '"]')
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("relay.chat"))).toBe(
    alpha.id,
  );
  await show();
  await page
    .locator('[data-action="archive-delete"][data-id="' + beta.id + '"]')
    .click();
  await expect(page.getByRole("dialog")).toContainText("删除后无法恢复");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("已归档的对话");
  await expect(page.locator(".archive-row")).toHaveCount(2);
  await page.getByRole("button", { name: "全部删除", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("2 个 Relay 对话");
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.locator("#archive-list")).toContainText("暂无已归档对话");
  expect(f.store.state.conversations.map((c) => c.id)).toEqual([original]);
  expect(f.runtime.starts).toHaveLength(0);
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page
    .getByRole("button", { name: "切换到浅色主题", exact: true })
    .click();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "已归档对话", exact: true }).click();
  await page.screenshot({ path: "test-results/archived-dialog-light.png" });
});

test("completed chat with stale restart flags archives through the sidebar without running models", async ({
  page,
}) => {
  const chatId = f.store.state.defaultConversationId;
  const request = f.service.collaboration.submit("已完成审查");
  f.store.mutate((s) => {
    Object.assign(
      s.userRequests.find((r) => r.id === request.id)!,
      { status: "completed", summary: "最终结论", control: undefined },
    );
    s.activeRequestId = undefined;
    for (const a of s.agents)
      Object.assign(a, {
        status: "recovery",
        pid: 9999999,
        boundSessionId: "retained-" + a.id,
      });
  });
  await open(page);
  await expect(page.locator(".request-summary")).toContainText("最终结论");
  await page
    .locator('[data-action="chat-archive"][data-id="' + chatId + '"]')
    .click();
  await expect
    .poll(() =>
      Boolean(
        f.store.state.conversations.find((c) => c.id === chatId)?.archivedAt,
      ),
    )
    .toBe(true);
  expect(
    f.store.state.agents.every(
      (a) => a.status === "stopped" && a.boundSessionId === "retained-" + a.id,
    ),
  ).toBe(true);
  expect(f.runtime.starts).toHaveLength(0);
});

test("live messages and Enter preserve expanded exchanges and manual position; conclusions are safe and below process", async ({
  page,
}) => {
  const request = f.service.collaboration.submit("长聊天");
  await f.service.collaboration.stop();
  f.store.mutate((s) => {
    for (let i = 0; i < 20; i++)
      s.chat.push({
        id: crypto.randomUUID(),
        requestId: request.id,
        role: "user",
        text: "历史段落 " + i + "\n".repeat(3),
        createdAt: new Date().toISOString(),
      });
    s.messages.push({
      id: crypto.randomUUID(),
      requestId: request.id,
      sourceId: s.agents[0].id,
      targetId: s.agents[1].id,
      kind: "question",
      text: "成员交流",
      status: "acknowledged",
      createdAt: new Date().toISOString(),
    });
  });
  await open(page);
  await page.locator(".process > summary").click();
  await page.locator(".messages > summary").click();
  await page.evaluate(() => {
    document.querySelector(".conversation")!.scrollTop = 200;
  });
  const top = await page
    .locator(".conversation")
    .evaluate((el) => el.scrollTop);
  const details = await page.locator(".messages").elementHandle();
  f.store.mutate((s) => {
    s.messages.push({
      ...s.messages[0],
      id: crypto.randomUUID(),
      text: "Enter 后更新",
    });
  });
  await expect(page.locator(".messages summary")).toContainText("2");
  expect(
    await details!.evaluate(
      (el) => el.isConnected && (el as HTMLDetailsElement).open,
    ),
  ).toBe(true);
  expect(
    await page.locator(".conversation").evaluate((el) => el.scrollTop),
  ).toBe(top);
  await page.locator("#prompt").fill("Enter 发送后继续阅读原消息");
  await page.locator("#prompt").press("Enter");
  await expect(page.locator(".user-message").last()).toHaveText(
    "Enter 发送后继续阅读原消息",
  );
  expect(
    await details!.evaluate(
      (el) => el.isConnected && (el as HTMLDetailsElement).open,
    ),
  ).toBe(true);
  expect(
    await page.locator(".conversation").evaluate((el) => el.scrollTop),
  ).toBe(top);
  f.store.mutate((s) => {
    s.userRequests[0].summary =
      "# 验收结果\n\n**完成**\n- 检查成功\n\n<img src=x onerror=alert(1)>\n[危险](javascript:alert(1))";
  });
  await expect(page.locator(".request-summary h2").last()).toHaveText(
    "验收结果",
  );
  await expect(page.locator(".request-summary strong")).toHaveText("完成");
  await expect(
    page.locator(
      '.request-summary img, .request-summary a[href^="javascript:"]',
    ),
  ).toHaveCount(0);
  expect(
    await page
      .locator(".request")
      .first()
      .evaluate((el) =>
        Boolean(
          el
            .querySelector(".process")!
            .compareDocumentPosition(el.querySelector(".request-summary")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
  ).toBe(true);
  await page.locator(".process > summary").first().click();
  await expect(page.locator(".request-summary")).toBeAttached();
});

test("fullscreen wheel uses authenticated restricted scrolling while keyboard remains locked", async ({
  page,
}) => {
  const request = f.service.collaboration.submit("终端滚动");
  await until(() => f.runtime.starts.length > 0);
  const a = f.store.state.agents[0];
  const generation = crypto.randomUUID();
  f.store.mutate((s) => {
    s.agents[0].generation = generation;
  });
  f.runtime.snapshot = () => ({
    generation,
    seq: 1,
    cols: 100,
    rows: 28,
    data: "\x1b[?1049h\x1b[?1000h\x1b[?1006h原生终端",
  });
  const scrolls: unknown[] = [],
    keys: string[] = [];
  f.runtime.scroll = (...args) => {
    scrolls.push(args);
  };
  f.runtime.write = (...args: unknown[]) => {
    keys.push(String(args[1]));
  };
  await open(page);
  await page.locator(".process > summary").click();
  await page.getByRole("button", { name: "查看真实终端", exact: true }).click();
  const screen = page.locator(".xterm-screen").first();
  await screen.hover();
  await page.mouse.wheel(0, -160);
  await expect.poll(() => scrolls.length).toBeGreaterThan(0);
  expect(scrolls[0]).toEqual([
    a.id,
    generation,
    "up",
    4,
    expect.any(Number),
    expect.any(Number),
  ]);
  await screen.click();
  await page.keyboard.type("danger");
  expect(keys).toEqual([]);
  expect(
    f.store.state.userRequests.find((r) => r.id === request.id)!.status,
  ).toBe("planning");
});

test("read-only fullscreen without mouse tracking scrolls through the restricted channel", async ({
  page,
}) => {
  f.service.collaboration.submit("查看全屏终端历史");
  await until(() => f.runtime.starts.length > 0);
  const agent = f.store.state.agents[0];
  const generation = crypto.randomUUID();
  f.store.mutate((s) => {
    s.agents[0].generation = generation;
  });
  f.runtime.snapshot = () => ({
    generation,
    seq: 1,
    cols: 100,
    rows: 28,
    data: "\x1b[?1049h\x1b[2J只读历史",
  });
  const scrolls: unknown[] = [];
  f.runtime.scroll = (...args) => {
    scrolls.push(args);
  };
  await open(page);
  await page.locator(".process > summary").click();
  await page.getByRole("button", { name: "查看真实终端", exact: true }).click();
  await expect(page.locator(".terminal-panel").first()).toContainText(
    "只读历史",
  );
  await page.locator(".xterm-screen").first().hover();
  await page.mouse.wheel(0, -160);
  await expect.poll(() => scrolls.length).toBeGreaterThan(0);
  expect(scrolls[0]).toEqual([
    agent.id,
    generation,
    "up",
    expect.any(Number),
    expect.any(Number),
    expect.any(Number),
  ]);
  expect(f.store.state.agents[0].manual).toBe(false);
  scrolls.length = 0;
  for (let i = 0; i < 7; i++) await page.mouse.wheel(0, -5);
  await page.waitForTimeout(50);
  expect(scrolls).toHaveLength(0);
  await page.mouse.wheel(0, -5);
  await expect.poll(() => scrolls.length).toBe(1);
  expect(scrolls[0]).toEqual([
    agent.id,
    generation,
    "up",
    1,
    expect.any(Number),
    expect.any(Number),
  ]);
});

test("normal terminal scrollback stays local before and after manual takeover", async ({
  page,
}) => {
  f.service.collaboration.submit("阅读普通终端历史");
  await until(() => f.runtime.starts.length > 0);
  const generation = crypto.randomUUID();
  f.store.mutate((s) => {
    s.agents[0].generation = generation;
  });
  f.runtime.snapshot = () => ({
    generation,
    seq: 1,
    cols: 100,
    rows: 28,
    data: Array.from({ length: 80 }, (_, i) => `记录 ${i}`).join("\r\n"),
  });
  const scrolls: unknown[] = [];
  f.runtime.scroll = (...args) => {
    scrolls.push(args);
  };
  await open(page);
  await page.locator(".process > summary").click();
  await page.getByRole("button", { name: "查看真实终端", exact: true }).click();
  const rows = page.locator(".terminal-panel").first().locator(".xterm-rows");
  await expect(rows).toContainText("记录 79");
  const before = await rows.innerText();
  await page.locator(".xterm-screen").first().hover();
  await page.mouse.wheel(0, -320);
  await expect.poll(() => rows.innerText()).not.toBe(before);
  expect(scrolls).toHaveLength(0);
  await page
    .getByRole("button", { name: "人工接管", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "退出人工接管", exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "退出人工接管", exact: true })
    .first()
    .click();
  const afterExit = await rows.innerText();
  await page.locator(".xterm-screen").first().hover();
  await page.mouse.wheel(0, -160);
  await expect.poll(() => rows.innerText()).not.toBe(afterExit);
  expect(scrolls).toHaveLength(0);
});

test("terminal snapshot keeps ANSI column positions and Chinese text on first open", async ({
  page,
}) => {
  f.service.collaboration.submit("检查终端排版");
  await until(() => f.runtime.starts.length > 0);
  const generation = crypto.randomUUID();
  f.store.mutate((s) => {
    s.agents[0].generation = generation;
  });
  f.runtime.snapshot = () => ({
    generation,
    seq: 1,
    cols: 100,
    rows: 28,
    data: "\x1b[?1049h\x1b[2J\x1b[4;87H\x1b[36m中文排版测试\x1b[0m",
  });
  await page.setViewportSize({ width: 2400, height: 1000 });
  await open(page);
  await page.locator(".process > summary").click();
  await page.getByRole("button", { name: "查看真实终端", exact: true }).click();
  const row = page
    .locator(".terminal-panel")
    .first()
    .locator(".xterm-rows > div")
    .nth(3);
  await expect(row).toContainText("中文排版测试");
  expect((await row.textContent())?.indexOf("中")).toBeGreaterThanOrEqual(86);
});

test("terminal reconnect restores the current Chinese screen without old output", async ({
  page,
}) => {
  f.service.collaboration.submit("检查终端重连");
  await until(() => f.runtime.starts.length > 0);
  const generation = crypto.randomUUID();
  f.store.mutate((s) => {
    s.agents[0].generation = generation;
  });
  let current = {
    generation,
    seq: 1,
    cols: 100,
    rows: 28,
    data: "\x1b[?1049h\x1b[2J\x1b[3;3H旧画面",
  };
  f.runtime.snapshot = () => current;
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as unknown as { relaySocket: WebSocket }).relaySocket = this;
      }
    };
  });
  await open(page);
  await page.locator(".process > summary").click();
  await page.getByRole("button", { name: "查看真实终端", exact: true }).click();
  const rows = page.locator(".terminal-panel").first().locator(".xterm-rows");
  await expect(rows).toContainText("旧画面");
  await page.evaluate(() =>
    (window as unknown as { relaySocket: WebSocket }).relaySocket.close(),
  );
  await expect(page.locator("#connection")).toHaveAttribute(
    "aria-label",
    "连接中断，正在重连",
  );
  current = {
    generation,
    seq: 2,
    cols: 100,
    rows: 28,
    data: "\x1b[?1049h\x1b[2J\x1b[3;3H重连中文画面",
  };
  await expect(rows).toContainText("重连中文画面", { timeout: 10000 });
  await expect(rows).not.toContainText("旧画面");
});

test("an offline terminal opened before launch receives its first live screen", async ({
  page,
}) => {
  f.service.collaboration.submit("检查尚未启动的终端");
  await until(() => f.runtime.starts.length > 0);
  f.runtime.snapshot = () => ({
    generation: "offline",
    seq: 0,
    cols: 100,
    rows: 28,
    data: "",
  });
  await open(page);
  await page.locator(".process > summary").click();
  await page.getByRole("button", { name: "查看真实终端", exact: true }).click();
  await expect(page.locator(".terminal-panel").first()).toBeVisible();
  const agentId = f.store.state.agents[0].id;
  const generation = crypto.randomUUID();
  f.runtime.snapshot = () => ({
    generation,
    seq: 1,
    cols: 100,
    rows: 28,
    data: "\x1b[?1049h首次启动中文画面",
  });
  f.runtime.emit("terminal", {
    agentId,
    generation,
    seq: 1,
    data: "\x1b[?1049h首次启动中文画面",
  });
  await expect(page.locator(".terminal-panel").first()).toContainText(
    "首次启动中文画面",
  );
});

test("eight terminals retain ordered Chinese output through paging, folding and snapshot gaps", async ({
  page,
}) => {
  for (let i = 2; i < 8; i++) f.agent(`Codex ${i + 1}`);
  f.service.collaboration.submit("检查八终端持续输出");
  await until(() => f.runtime.starts.length > 0);
  const generation = crypto.randomUUID();
  const agents = f.store.state.agents;
  f.store.mutate((s) => {
    for (const a of s.agents) a.generation = generation;
  });
  let snapshotSeq = 1;
  let snapshotCalls = 0;
  const data = (id: string, seq: number) =>
    `\x1b[2;1H成员 ${id.slice(0, 6)} 中文第${seq}步\x1b[K`;
  f.runtime.snapshot = (id) => {
    snapshotCalls++;
    return {
      generation,
      seq: snapshotSeq,
      cols: 100,
      rows: 28,
      data: "\x1b[?1049h\x1b[2J" + data(id, snapshotSeq),
    };
  };
  const resizes: unknown[] = [];
  f.runtime.resize = (...args) => {
    resizes.push(args);
  };
  await open(page);
  expect(snapshotCalls).toBe(0);
  await page.locator(".process > summary").click();
  await page.getByRole("button", { name: "查看真实终端", exact: true }).click();
  await expect(page.locator(".terminal-panel:visible")).toHaveCount(4);
  await expect(page.locator(".terminal-panel").first()).toContainText(
    "中文第1步",
  );
  await expect.poll(() => resizes.length).toBe(4);
  expect(snapshotCalls).toBe(8);
  for (let seq = 2; seq <= 30; seq++)
    for (const agent of agents)
      f.runtime.emit("terminal", {
        agentId: agent.id,
        generation,
        seq,
        data: data(agent.id, seq),
      });
  await expect(page.locator(".terminal-panel").first()).toContainText(
    "中文第30步",
  );
  expect(resizes).toHaveLength(4);
  await page.getByRole("button", { name: "终端 5–8" }).click();
  await expect(page.locator(".terminal-panel:visible").first()).toContainText(
    "中文第30步",
  );
  await expect.poll(() => resizes.length).toBe(8);
  snapshotSeq = 35;
  for (const agent of agents)
    f.runtime.emit("terminal", {
      agentId: agent.id,
      generation,
      seq: 35,
      data: "遗漏片段之后的增量",
    });
  await expect(page.locator(".terminal-panel:visible").first()).toContainText(
    "中文第35步",
  );
  await expect(
    page.locator(".terminal-panel:visible").first(),
  ).not.toContainText("遗漏片段之后的增量");
  await page.locator(".process > summary").click();
  for (let seq = 36; seq <= 80; seq++)
    for (const agent of agents)
      f.runtime.emit("terminal", {
        agentId: agent.id,
        generation,
        seq,
        data: data(agent.id, seq),
      });
  await page.locator(".process > summary").click();
  await expect(page.locator(".terminal-panel:visible").first()).toContainText(
    "中文第80步",
  );
  await page
    .locator(".terminal-panel:visible")
    .first()
    .getByRole("button", { name: "放大终端" })
    .click();
  await expect(page.locator(".terminal-panel.expanded")).toContainText(
    "中文第80步",
  );
});

test("desktop native picker cancels locally and sends the chosen path to the authenticated endpoint", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      pickerResult: { cancelled: true },
      pickerCalls: 0,
      webkit: {
        messageHandlers: {
          relayPicker: {
            postMessage: async () => {
              const state = window as Window & {
                pickerResult?: { cancelled?: boolean; path?: string };
                pickerCalls?: number;
              };
              state.pickerCalls = (state.pickerCalls ?? 0) + 1;
              return state.pickerResult ?? { cancelled: true };
            },
          },
        },
      },
    });
  });
  let posts = 0;
  await page.route("**/api/project-folder", (route) => {
    posts++;
    expect(route.request().postDataJSON().path).toBe(f.repo);
    expect(route.request().headers().authorization).toBe(
      "Bearer " + f.service.auth.consoleToken,
    );
    return route.fulfill({ json: { cancelled: true } });
  });
  await open(page);
  await page.locator("#prompt").fill("保留草稿");
  const choose = async () => {
    await page.getByRole("button", { name: "添加项目", exact: true }).click();
    await page
      .getByRole("button", { name: "在此电脑上选择文件夹", exact: true })
      .click();
    await expect(page.locator("#project-menu")).toBeHidden();
  };
  await choose();
  expect(posts).toBe(0);
  await page.evaluate((path) => {
    Object.assign(window, { pickerResult: { path } });
  }, f.repo);
  await choose();
  expect(posts).toBe(1);
  await expect(page.locator("#prompt")).toHaveValue("保留草稿");
  expect(f.runtime.starts.length).toBe(0);
});

test("project plus opens folder menu; cancellation keeps draft, chat and manual reading without inference", async ({
  page,
}) => {
  await open(page);
  await page.locator("#prompt").fill("保留当前草稿");
  const add = page.getByRole("button", { name: "添加项目", exact: true });
  await add.click();
  const choose = page.locator('#project-menu [data-action="project-folder"]');
  await expect(choose).toBeVisible();
  await expect(page.locator('input[name="path"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(choose).not.toBeVisible();
  await expect(add).toBeFocused();
  await add.click();
  let request: Record<string, unknown> | undefined, release!: () => void;
  await page.route("**/api/project-folder", async (route) => {
    request = route.request().postDataJSON();
    await new Promise<void>((r) => {
      release = r;
    });
    await route.fulfill({ json: { cancelled: true } });
  });
  const before = structuredClone(f.store.state);
  await choose.click();
  await expect(choose).toBeDisabled();
  await expect(choose).toHaveText("文件夹选择器已打开…");
  expect(request).toEqual({
    conversationId: f.store.state.defaultConversationId,
  });
  release();
  await expect(choose).not.toBeVisible();
  await expect(add).toBeFocused();
  await expect(page.locator("#prompt")).toHaveValue("保留当前草稿");
  expect(f.store.state).toEqual(before);
  expect(f.runtime.starts).toHaveLength(0);
  await add.click();
  await page.screenshot({ path: "test-results/project-picker.png" });
  await page.locator("#prompt").click();
  await expect(choose).not.toBeVisible();
});

test("project picker errors permit retry; choosing current project keeps same chat and draft", async ({
  page,
}) => {
  await open(page);
  await page.locator("#prompt").fill("项目草稿");
  let count = 0;
  await page.route("**/api/project-folder", (route) => {
    count++;
    return route.fulfill(
      count === 1
        ? { status: 409, json: { error: { message: "无法打开 macOS 选择器" } } }
        : { json: { url: app.url, token: f.service.auth.consoleToken } },
    );
  });
  const add = page.getByRole("button", { name: "添加项目", exact: true });
  await add.click();
  await page
    .getByRole("button", { name: "在此电脑上选择文件夹", exact: true })
    .click();
  await expect(page.locator("#toasts")).toContainText("无法打开 macOS 选择器");
  await add.click();
  await page
    .getByRole("button", { name: "在此电脑上选择文件夹", exact: true })
    .click();
  await expect(page.locator("#project-menu")).not.toBeVisible();
  await expect(page.locator("#prompt")).toHaveValue("项目草稿");
  expect(count).toBe(2);
  expect(f.runtime.starts).toHaveLength(0);
  expect(page.url()).toBe(app.url + "/");
});

test("selecting another local folder navigates to isolated console and returning keeps original draft and history", async ({
  page,
}) => {
  const other = await fixture();
  extraFixtures.push(other);
  folderSelection = { path: other.repo, name: "repo", kind: "folder" };
  await open(page);
  await page.locator("#prompt").fill("原项目草稿");
  const original = structuredClone(f.store.state);
  await page.getByRole("button", { name: "添加项目", exact: true }).click();
  await page
    .getByRole("button", { name: "在此电脑上选择文件夹", exact: true })
    .click();
  await page.waitForURL((url) => url.origin !== app.url);
  await expect(page.locator("#team-button")).toContainText("Codex ×2");
  await expect(page.locator("#prompt")).toHaveValue("");
  const selected = await page.evaluate(async () => {
    const response = await fetch("/api/state", {
      headers: {
        Authorization: "Bearer " + sessionStorage.getItem("relay.token"),
      },
    });
    return { status: response.status, state: await response.json() };
  });
  expect(selected.status).toBe(200);
  expect(selected.state.project.id).not.toBe(original.project!.id);
  expect(selected.state.agents.map((a: { id: string }) => a.id)).not.toEqual(
    original.agents.map((a) => a.id),
  );
  expect(selected.state.userRequests).toHaveLength(0);
  expect(f.runtime.starts).toHaveLength(0);
  expect(f.store.state).toEqual(original);
  await page.goto(app.url);
  await expect(page.locator("#prompt")).toHaveValue("原项目草稿");
  await expect(page.locator("#connection")).toHaveAttribute(
    "aria-label",
    "本地服务已连接",
  );
});

test("image-only file selection sends authenticated original and restores preview", async ({
  page,
}) => {
  const { visionChallenge } = await import("../../src/server/vision.ts");
  const image = visionChallenge().bytes;
  f.service.visionFor = async () => ({
    status: "supported",
    source: "browser fixture",
  });
  await open(page);
  await page
    .locator("#image-picker")
    .setInputFiles({ name: "图片.png", mimeType: "image/png", buffer: image });
  await expect(page.locator("#draft-images")).toContainText("图片.png");
  await expect(page.locator(".send-button")).toBeEnabled();
  await page.locator(".send-button").click();
  await expect(page.locator(".user-message")).toContainText("请分析附件图片");
  expect(f.store.state.userRequests[0].attachmentIds).toHaveLength(1);
  expect(f.store.state.attachments![0].size).toBe(image.length);
  await expect(page.locator(".message-images img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await page.locator(".message-images button").click();
  await expect(page.locator(".image-dialog")).toBeVisible();
  await page.getByRole("button", { name: "关闭图片" }).click();
  await page.reload();
  await expect(page.locator(".message-images img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
});

test("drop and clipboard images upload; unknown vision preserves draft; retry sends once", async ({
  page,
}) => {
  const { visionChallenge } = await import("../../src/server/vision.ts");
  const base64 = visionChallenge().bytes.toString("base64");
  f.service.visionFor = async () => ({
    status: "unknown",
    source: "browser fixture",
  });
  await open(page);
  await page.locator("#composer").evaluate((el, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "drop.png", { type: "image/png" }));
    el.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, base64);
  await expect(page.locator("#draft-images")).toContainText("drop.png");
  await expect(page.locator(".send-button")).toBeEnabled();
  await page.locator("#prompt").fill("检查两张图");
  await page.locator("#prompt").evaluate((el, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
        "paste.png",
        { type: "image/png" },
      ),
    );
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, base64);
  await expect(page.locator("#draft-images .draft-image")).toHaveCount(2);
  await expect(page.locator(".send-button")).toBeEnabled();
  await page.locator(".send-button").click();
  await expect(page.locator("#prompt")).toHaveValue("检查两张图");
  await expect(page.locator("#draft-images .draft-image")).toHaveCount(2);
  expect(f.store.state.userRequests).toHaveLength(0);
  f.service.visionFor = async () => ({
    status: "supported",
    source: "browser fixture",
  });
  await page.locator(".send-button").click();
  await expect(page.locator(".user-message")).toContainText("检查两张图");
  expect(f.store.state.userRequests).toHaveLength(1);
  expect(f.store.state.userRequests[0].attachmentIds).toHaveLength(2);
});

test("attachment failure blocks send, removal works and native paste fallback keeps text paste", async ({
  page,
}) => {
  const { visionChallenge } = await import("../../src/server/vision.ts");
  const base64 = visionChallenge().bytes.toString("base64");
  await open(page);
  await page.locator("#image-picker").setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("broken"),
  });
  await expect(page.locator("#draft-images")).toContainText("仅支持");
  await expect(page.locator(".send-button")).toBeDisabled();
  await page.getByRole("button", { name: "移除 broken.png" }).click();
  await expect(page.locator("#draft-images .draft-image")).toHaveCount(0);
  await page.evaluate((data) => {
    (window as any).webkit = {
      messageHandlers: {
        relayClipboard: {
          postMessage: async () => ({ data, mimeType: "image/png" }),
        },
      },
    };
  }, base64);
  await page.locator("#prompt").focus();
  await page.locator("#prompt").dispatchEvent("paste");
  await expect(page.locator("#draft-images")).toContainText("粘贴截图.png");
  await page.locator("#prompt").evaluate((el) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "plain text");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.locator("#draft-images .draft-image")).toHaveCount(1);
});

test("vision diagnostic exposes a scoped terminal and requires explicit manual input", async ({
  page,
}) => {
  await open(page);
  let finish: (() => void) | undefined;
  const input: string[] = [];
  await page.route("**/api/vision-check", async (route) => {
    await new Promise<void>((r) => (finish = r));
    await route.fulfill({
      json: { status: "unknown", source: "测试诊断结束" },
    });
  });
  await page.route("**/api/vision-check/*/terminal", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.generation).toBe("diagnostic-generation");
      if (body.data) input.push(body.data);
      await route.fulfill({ json: { ok: true } });
    } else
      await route.fulfill({
        json: {
          generation: "diagnostic-generation",
          seq: 1,
          cols: 100,
          rows: 28,
          data: "Trust isolated fixture?",
          attention: "目录信任提示",
          manual: false,
          approvals: [],
        },
      });
  });
  await page.locator("#team-button").click();
  await page
    .getByRole("button", { name: "验证识图能力（调用模型）" })
    .first()
    .click();
  await expect(page.locator(".vision-dialog")).toBeVisible();
  await expect(page.locator(".vision-attention")).toContainText("目录信任提示");
  expect(input).toEqual([]);
  await page
    .getByRole("button", { name: "人工接管验证终端", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "退出人工接管", exact: true }),
  ).toBeVisible();
  await page.keyboard.type("test");
  await expect.poll(() => input.join("")).toBe("test");
  finish!();
  await expect(page.locator(".vision-attention")).toContainText("测试诊断结束");
  await expect(
    page.getByRole("button", { name: "退出人工接管", exact: true }),
  ).toBeDisabled();
  expect(f.runtime.starts).toHaveLength(0);
});
