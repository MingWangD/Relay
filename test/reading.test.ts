import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/client/reading.ts";
test("conclusions render headings, lists, code and safe links without executing source HTML", () => {
  const source =
    "# 结论\n\n**完成**\n- 第一点\n- 第二点\n\n```ts\nconst n = 1;\n```\n[文档](https://example.com)\n[危险](javascript:alert(1))\n<img src=x onerror=alert(1)>";
  const html = renderMarkdown(source);
  assert.match(html, /<h2>结论<\/h2>/);
  assert.match(html, /<strong>完成<\/strong>/);
  assert.match(html, /<ul><li>第一点/);
  assert.match(html, /<pre><code>const n = 1;/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="javascript:|<img|<script/);
  assert.match(html, /&lt;img/);
});
