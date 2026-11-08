import { useMemo, useState } from "react";
import { buildPreviewDoc } from "../lib/preview";
import { Icon } from "./icons";

/* コードブロックのプレビュー（全画面シート）。
   iframe は sandbox="allow-scripts" のみ（allow-same-origin を付けない）で、
   アプリ本体のオリジンからは隔離して表示する。 */
export function CodePreviewSheet({
  target,
  onClose,
  toast,
}: {
  target: { code: string; lang: string } | null;
  onClose: () => void;
  toast: (msg: string) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const built = useMemo(
    () => (target ? buildPreviewDoc(target.code, target.lang) : null),
    [target],
  );
  if (!target || !built) return null;

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(target.code);
      toast("コピーしました");
    } catch {
      toast("コピーに失敗しました");
    }
  };
  const downloadHtml = () => {
    const blob = new Blob([built.doc], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "preview.html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const openTab = () => {
    const blob = new Blob([built.doc], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank", "noopener");
    if (!w) toast("新しいタブを開けませんでした。ポップアップの許可を確認してください");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  return (
    <>
      <div className="sheet-back on" onClick={onClose} />
      <div className="sheet previewSheet on" role="dialog" aria-label="コードプレビュー">
        <div className="sheet-head">
          <h2>プレビュー</h2>
          <span className="pill-state">{target.lang || "html"}</span>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="プレビューを閉じる">
            <Icon name="x" />
          </button>
        </div>
        <div className="preview-toolbar">
          <button type="button" className="btn secondary sm" onClick={() => setNonce((n) => n + 1)}>
            <Icon name="refresh" className="ic sm" /> 再読み込み
          </button>
          <button type="button" className="btn secondary sm" onClick={() => void copyCode()}>
            <Icon name="copy" className="ic sm" /> コードをコピー
          </button>
          <button type="button" className="btn secondary sm" onClick={downloadHtml}>
            <Icon name="download" className="ic sm" /> ダウンロード
          </button>
          <button type="button" className="btn secondary sm" onClick={openTab}>
            <Icon name="ext" className="ic sm" /> 新しいタブ
          </button>
        </div>
        {built.caption && <div className="preview-caption">{built.caption}</div>}
        <iframe
          key={nonce}
          className="preview-iframe"
          title="コードプレビュー"
          sandbox="allow-scripts"
          srcDoc={built.doc}
        />
      </div>
    </>
  );
}
