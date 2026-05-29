import { useMemo } from "react";
import { marked } from "marked";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";

marked.setOptions({
  gfm: true,
  breaks: false,
  async: false,
});

// Custom renderer: pass code blocks through highlight.js, escape inline code,
// and wrap pre with our own classes so spacing matches the rest of the UI.
const renderer = new marked.Renderer();
renderer.code = function code({ text, lang }) {
  const language = (lang ?? "").trim();
  const valid = language && hljs.getLanguage(language) ? language : null;
  let html: string;
  try {
    html = valid
      ? hljs.highlight(text, { language: valid }).value
      : hljs.highlightAuto(text).value;
  } catch {
    html = escapeText(text);
  }
  const label = valid ?? "";
  return `<pre class="claw-code"><div class="claw-code-bar">${escapeText(label || "code")}</div><code class="hljs">${html}</code></pre>`;
};
renderer.codespan = function codespan({ text }) {
  // marked already entity-encodes the text field for codespan tokens
  // (verified against marked v14: `` `"a"` `` arrives as `&quot;a&quot;`).
  // Re-escaping would double-encode `&` and surface literal `&quot;` in the
  // rendered output for any quoted code reference. Code blocks behave
  // differently and still need escaping in the fallback branch above.
  return `<code class="claw-inline-code">${text}</code>`;
};
renderer.link = function link({ href, title, tokens }) {
  const inner = this.parser.parseInline(tokens);
  const safeHref = String(href ?? "");
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
  return `<a class="claw-link" href="${escapeAttr(safeHref)}"${titleAttr} target="_blank" rel="noreferrer noopener">${inner}</a>`;
};
marked.use({ renderer });

// Escape text destined for an element body (`<code>X</code>`). Inside element
// content, only `&`, `<`, and `>` need entity-encoding — `"` and `'` are
// literal characters here. Escaping them produces visible `&quot;` artifacts
// inside inline code spans (e.g. agent-emitted `strftime("%G")`).
function escapeText(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Escape text destined for an attribute value (`title="X"`). Attributes also
// need quote escaping so the value can't break out of its delimiter.
function escapeAttr(input: string): string {
  return escapeText(input).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text) as string, [text]);
  return <div className="claw-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
