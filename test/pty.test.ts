import test from "node:test";
import assert from "node:assert/strict";
import * as pty from "node-pty";
test("真实 PTY：中文输入、输出、resize 与退出", async () => {
  const terminal = pty.spawn("/bin/cat", [], {
    cwd: process.cwd(),
    env: process.env,
    name: "xterm-256color",
    cols: 80,
    rows: 24,
  });
  const output = await new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error("PTY 超时"));
    }, 4000);
    terminal.onData((data) => {
      text += data;
      if (text.includes("真实终端你好")) {
        clearTimeout(timer);
        resolve(text);
      }
    });
    terminal.resize(120, 35);
    terminal.write("真实终端你好\r");
  });
  assert.match(output, /真实终端你好/);
  assert.equal(terminal.cols, 120);
  assert.equal(terminal.rows, 35);
  const exited = new Promise<void>((r) => terminal.onExit(() => r()));
  terminal.kill();
  await exited;
});
