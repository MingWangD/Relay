import headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
const { Terminal } = headless;

// Track the actual viewport, including cursor movement, erasure and alternate screen.
// Screen wording is a UI hint only, never delivery or completion evidence.
export class TerminalScreen {
  private disposed = false;
  private captures = new Set<() => void>();
  private terminal = new Terminal({
    cols: 100,
    rows: 28,
    scrollback: 5000,
    allowProposedApi: true,
  });
  private serializer = new SerializeAddon();
  constructor() {
    this.terminal.loadAddon(this.serializer);
  }
  write(data: string, ready: (screen: string) => void) {
    if (!this.disposed)
      this.terminal.write(data, () => {
        if (!this.disposed) ready(this.text());
      });
  }
  text() {
    const b = this.terminal.buffer.active;
    return Array.from(
      { length: this.terminal.rows },
      (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? "",
    ).join("\n");
  }
  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
  }
  snapshot() {
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      data: this.serializer.serialize({ scrollback: 5000 }),
    };
  }
  capture(getSeq: () => number) {
    return new Promise<
      { seq: number; cols: number; rows: number; data: string } | undefined
    >((resolve) => {
      if (this.disposed) return resolve(undefined);
      const finish = () => {
        if (!this.captures.delete(finish)) return;
        resolve(
          this.disposed ? undefined : { seq: getSeq(), ...this.snapshot() },
        );
      };
      this.captures.add(finish);
      this.terminal.write("", finish);
    });
  }
  scroll(direction: "up" | "down", count: number, col: number, row: number) {
    const t = this.terminal;
    if (t.buffer.active.type !== "alternate") return "";
    if (col > t.cols || row > t.rows) return "";
    if (t.modes.mouseTrackingMode === "none") {
      const key =
        "\x1b" +
        (t.modes.applicationCursorKeysMode ? "O" : "[") +
        (direction === "up" ? "A" : "B");
      return key.repeat(count);
    }
    return Array.from(
      { length: count },
      () =>
        "\x1b[<" + (direction === "up" ? 64 : 65) + ";" + col + ";" + row + "M",
    ).join("");
  }
  dispose() {
    this.disposed = true;
    for (const finish of [...this.captures]) finish();
    this.terminal.dispose();
  }
}
