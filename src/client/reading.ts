const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function inline(source: string): string {
  const code: string[] = [];
  let text = escape(source).replace(/`([^`]+)`/g, (_, s) => {
    code.push(`<code>${s}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });
  text = text
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, url) => {
      if (!/^(https?:\/\/|mailto:)/i.test(url)) return label;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}
// All source is escaped. Only these elements and safe link schemes enter the DOM.
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n"),
    out: string[] = [];
  let paragraph: string[] = [],
    list: string | undefined,
    block: string[] | undefined;
  const flush = () => {
    if (paragraph.length)
      out.push(`<p>${inline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
    paragraph = [];
  };
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = undefined;
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush();
      close();
      if (block) {
        out.push(`<pre><code>${escape(block.join("\n"))}</code></pre>`);
        block = undefined;
      } else block = [];
      continue;
    }
    if (block) {
      block.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      close();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      close();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      flush();
      const next = item[1] ? "ul" : "ol";
      if (list !== next) {
        close();
        list = next;
        out.push(`<${list}>`);
      }
      out.push(`<li>${inline(item[2])}</li>`);
      continue;
    }
    close();
    paragraph.push(line);
  }
  flush();
  close();
  if (block) out.push(`<pre><code>${escape(block.join("\n"))}</code></pre>`);
  return out.join("");
}
// Keep disclosure, request and message nodes stable; xterm owns terminal-slot children.
export function updateMarkup(target: HTMLElement, html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const key = (node: Node) =>
    node instanceof HTMLElement
      ? (node.dataset.key ??
        node.dataset.request ??
        node.dataset.process ??
        node.dataset.slot)
      : undefined;
  const signature = (node: Node) =>
    `${node.nodeType}:${node.nodeName}:${key(node) || ""}`;
  function reconcile(parent: Node, source: Node) {
    const remaining = new Set(parent.childNodes);
    const matches = new Map<string, { nodes: ChildNode[]; index: number }>();
    for (const old of remaining) {
      const id = signature(old);
      const bucket = matches.get(id);
      if (bucket) bucket.nodes.push(old);
      else matches.set(id, { nodes: [old], index: 0 });
    }
    let previous: Node | null = null;
    for (const next of [...source.childNodes]) {
      const bucket = matches.get(signature(next));
      const match = bucket?.nodes[bucket.index++];
      const current = match ?? next.cloneNode(false);
      if (match) remaining.delete(match);
      if (current instanceof Element && next instanceof Element) {
        for (const attr of [...current.attributes])
          if (
            !next.hasAttribute(attr.name) &&
            !(current instanceof HTMLDetailsElement && attr.name === "open")
          )
            current.removeAttribute(attr.name);
        for (const attr of [...next.attributes])
          if (
            !(current instanceof HTMLDetailsElement && attr.name === "open") &&
            current.getAttribute(attr.name) !== attr.value
          )
            current.setAttribute(attr.name, attr.value);
        if (!match && current instanceof HTMLDetailsElement)
          current.open = next.hasAttribute("open");
        if (!(current instanceof HTMLElement && current.dataset.slot))
          reconcile(current, next);
      } else if (current.nodeValue !== next.nodeValue)
        current.nodeValue = next.nodeValue;
      const position: ChildNode | null = previous
        ? previous.nextSibling
        : parent.firstChild;
      if (current !== position) parent.insertBefore(current, position);
      previous = current;
    }
    for (const old of remaining) parent.removeChild(old);
  }
  reconcile(target, template.content);
}
