import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/client/reading.ts";

test("link attributes survive emphasis, parentheses, escaping and formatted labels", () => {
  for (const url of [
    "https://github.com/foo/bar/blob/main/__tests__/test.ts",
    "https://example.com/a*b?q=x&v=y",
    "https://example.com/a_(b)",
  ]) {
    const html = renderMarkdown(`[**issue**](${url})`);
    assert.ok(html.includes(`href="${url.replaceAll("&", "&amp;")}"`), html);
    assert.match(html, /<strong>issue<\/strong><\/a>/);
  }
  assert.match(
    renderMarkdown("\\*plain\\* `__code__`"),
    /\*plain\* <code>__code__<\/code>/,
  );
});
test("unsafe and relative URLs and source HTML never become active elements", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///tmp/a",
    "/api/state",
    "//example.com",
  ]) {
    assert.doesNotMatch(renderMarkdown(`[link](${url})`), /<a /);
  }
  assert.doesNotMatch(
    renderMarkdown("![image](https://example.com/x) <script>alert(1)</script>"),
    /<img|<script/,
  );
  assert.match(
    renderMarkdown("[mail](mailto:a@example.com)"),
    /href="mailto:a@example.com"/,
  );
});
