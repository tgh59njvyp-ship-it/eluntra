import DOMPurify from "dompurify";
import { Marked } from "marked";
import { memo, useMemo } from "react";
import { isPreviewableLang } from "../lib/preview";

/* 軽量Markdown描画：markedで変換し、DOMPurifyで無害化してから表示する。
   コードブロックには言語名とコピーボタンの置き場を付け、クリック処理は親側の委譲で受ける。
   プレビュー可能な言語（html/xml/svg/css/js）にはプレビューボタンも付ける。 */

const marked = new Marked({ breaks: true, gfm: true });

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const langEsc = (lang || "").replace(/"/g, "&quot;");
      const previewBtn = isPreviewableLang(lang)
        ? `<button type="button" class="codecopy" data-preview="1" data-lang="${langEsc}">プレビュー</button>`
        : "";
      return `<div class="codeblock"><div class="codeblock-head"><span>${langEsc || "code"}</span><span class="codeblock-actions">${previewBtn}<button type="button" class="codecopy" data-copy="1">コピー</button></span></div><pre><code>${esc}</code></pre></div>`;
    },
  },
});

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text || "", { async: false }) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["data-copy", "data-preview", "data-lang"] });
  }, [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** 完成コードの抽出（コードモード用：最後のHTMLコードブロック、なければ全文） */
export function extractHtml(text: string): string | null {
  const blocks = [...text.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const body = blocks[i][1].trim();
    if (/<(html|!doctype|div|section|main|body)/i.test(body)) return body;
  }
  const trimmed = (text || "").trim();
  if (/^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed)) return trimmed;
  return null;
}
