/* コードブロックのプレビュー用ドキュメント組み立て。
   iframe sandbox="allow-scripts"（allow-same-origin は付けない）で srcDoc として表示する前提。
   完全なHTML文書はそのまま、断片は最小テンプレートで包む。
   CSS単体は <style> として見本要素に適用し、JS単体は console 出力をページ内に表示する。 */

export type PreviewKind = "full" | "fragment" | "css" | "js";

export interface PreviewDoc {
  doc: string;
  kind: PreviewKind;
  /** 包んだ場合にUIへ出す説明（そのままの場合は null） */
  caption: string | null;
}

const PREVIEWABLE = new Set(["html", "xml", "svg", "css", "js", "javascript"]);

export function isPreviewableLang(lang: string | undefined | null): boolean {
  return PREVIEWABLE.has((lang || "").trim().toLowerCase());
}

const BASE_STYLE = [
  "body{font-family:system-ui,-apple-system,'Hiragino Sans',sans-serif;margin:16px;color:#1c1a15;line-height:1.6}",
  "img,svg{max-width:100%;height:auto}",
].join("\n");

function wrapFragment(body: string, headExtra = ""): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${BASE_STYLE}</style>`,
    headExtra,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}

/** スクリプト内に埋め込むとき、閉じタグ文字列で文書が壊れないようにする */
function escapeClose(code: string, tag: "script" | "style"): string {
  return code.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
}

const CONSOLE_CAPTURE = [
  "(function(){",
  "var out=document.getElementById('__console_out');",
  "function fmt(a){if(typeof a==='string')return a;try{return JSON.stringify(a,null,2)}catch(e){return String(a)}}",
  "['log','info','warn','error'].forEach(function(k){var orig=console[k].bind(console);console[k]=function(){out.textContent+=Array.prototype.map.call(arguments,fmt).join(' ')+'\\n';orig.apply(null,arguments)}});",
  "window.addEventListener('error',function(e){out.textContent+='Error: '+(e.message||'error')+'\\n'});",
  "})();",
].join("\n");

const DEMO_BODY = [
  "<h1>見出し1 Heading</h1>",
  "<h2>見出し2</h2>",
  "<p>段落のテキストです。リンクは <a href='#'>こちら</a>。ボタンとフォームの見本も置いています。</p>",
  "<button type='button'>ボタン</button>",
  "<ul><li>リスト項目1</li><li>リスト項目2</li></ul>",
  "<form onsubmit='return false'><label>入力欄 <input type='text' placeholder='テキスト'></label> <input type='submit' value='送信'></form>",
  "<table border='1' cellspacing='0' cellpadding='6'><tr><th>表</th><th>見本</th></tr><tr><td>A</td><td>1</td></tr></table>",
].join("\n");

export function buildPreviewDoc(code: string, lang: string | undefined | null): PreviewDoc {
  const l = (lang || "").trim().toLowerCase();
  const src = code ?? "";
  if (l === "css") {
    return {
      doc: wrapFragment(DEMO_BODY, `<style>${escapeClose(src, "style")}</style>`),
      kind: "css",
      caption: "CSS単体のため、見本の要素にスタイルを適用して表示しています",
    };
  }
  if (l === "js" || l === "javascript") {
    const body = [
      "<h2 style='font-size:15px;margin:0 0 8px'>実行結果（console出力）</h2>",
      "<pre id='__console_out' style='font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap;background:#f6f4ee;border:1px solid #e3ddcf;border-radius:8px;padding:10px;min-height:60px'></pre>",
      `<script>${CONSOLE_CAPTURE}</script>`,
      `<script>${escapeClose(src, "script")}</script>`,
    ].join("\n");
    return {
      doc: wrapFragment(body),
      kind: "js",
      caption: "JavaScript単体のため、console.log などの出力をページ内に表示しています",
    };
  }
  // html / xml / svg / 不明
  const trimmed = src.trim();
  if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return { doc: src, kind: "full", caption: null };
  }
  return {
    doc: wrapFragment(src),
    kind: "fragment",
    caption: "HTMLの断片のため、最小のページに包んで表示しています",
  };
}
