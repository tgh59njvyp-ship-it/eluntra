import { esc } from "./util";

/**
 * 最小Markdownレンダラ（安全側に倒した自前実装）。
 * コードブロック→見出し→リスト→引用→段落のみ対応し、生HTMLは必ずエスケープする。
 */
export function md(src: string): string {
  const blocks: string[] = [];
  let s = String(src || "");
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang: string, code: string) => {
    blocks.push("<pre><code data-lang=\"" + _lang + "\">" + esc(code.replace(/\n$/, "")) + "</code></pre>");
    return "\u0001" + (blocks.length - 1) + "\u0001";
  });

  const lines = s.split("\n");
  let html = "";
  let inUl = false;
  let inOl = false;
  let inQ = false;
  const closeLists = (): void => {
    if (inUl) { html += "</ul>"; inUl = false; }
    if (inOl) { html += "</ol>"; inOl = false; }
    if (inQ) { html += "</blockquote>"; inQ = false; }
  };
  const inline = (t: string): string =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(
        /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );

  for (const line of lines) {
    if (/^\u0001\d+\u0001$/.test(line.trim())) {
      closeLists();
      html += blocks[Number(line.trim().slice(1, -1))];
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      closeLists();
      const lv = (line.match(/^#+/) as RegExpMatchArray)[0].length;
      html += `<h${lv + 2}>` + inline(line.replace(/^#+\s/, "")) + `</h${lv + 2}>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inUl) { closeLists(); html += "<ul>"; inUl = true; }
      html += "<li>" + inline(line.replace(/^\s*[-*]\s+/, "")) + "</li>";
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (!inOl) { closeLists(); html += "<ol>"; inOl = true; }
      html += "<li>" + inline(line.replace(/^\s*\d+[.)]\s+/, "")) + "</li>";
      continue;
    }
    if (/^>\s?/.test(line)) {
      if (!inQ) { closeLists(); html += "<blockquote>"; inQ = true; }
      html += inline(line.replace(/^>\s?/, "")) + "<br>";
      continue;
    }
    closeLists();
    if (line.trim() === "") continue;
    html += "<p>" + inline(line) + "</p>";
  }
  closeLists();
  return html;
}
