import { useState } from "react";
import { downloadZip } from "../lib/files";
import { useStore } from "../lib/store";
import { Icon } from "./icons";

const WIDTHS: Array<{ label: string; value: number | null }> = [
  { label: "390", value: 390 },
  { label: "430", value: 430 },
  { label: "768", value: 768 },
  { label: "1280", value: 1280 },
  { label: "全幅", value: null },
];

export function CodePreview({ sessionId, show, onClose }: { sessionId: string | null; show: boolean; onClose: () => void }) {
  const codes = useStore((s) => s.codes);
  const [width, setWidth] = useState<number | null>(390);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const html = sessionId ? codes[sessionId] || "" : "";

  return (
    <div className={`code-preview${show ? " show" : ""}`}>
      <div className="code-preview-bar">
        <button type="button" className={`widthbtn${tab === "preview" ? " on" : ""}`} onClick={() => setTab("preview")}>
          プレビュー
        </button>
        <button type="button" className={`widthbtn${tab === "code" ? " on" : ""}`} onClick={() => setTab("code")}>
          コード
        </button>
        <span style={{ width: 8 }} />
        {WIDTHS.map((w) => (
          <button
            key={w.label}
            type="button"
            className={`widthbtn${width === w.value ? " on" : ""}`}
            onClick={() => setWidth(w.value)}
          >
            {w.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn secondary sm"
          disabled={!html}
          onClick={() => downloadZip({ "index.html": html }, "eluntra-code.zip")}
        >
          <Icon name="download" className="ic sm" /> Zip保存
        </button>
        <button type="button" className="iconbtn only-sp" onClick={onClose} aria-label="プレビューを閉じる">
          <Icon name="x" />
        </button>
      </div>
      {tab === "preview" ? (
        <div className="preview-frame-wrap">
          {html ? (
            <iframe
              title="プレビュー"
              className="preview-frame"
              style={{ width: width ? `${width}px` : "100%" }}
              sandbox="allow-scripts"
              srcDoc={html}
            />
          ) : (
            <div style={{ color: "var(--text-3)", fontSize: 14, paddingTop: 40 }}>
              まだ完成コードがありません。左のチャットで作りたいものを伝えると、ここにプレビューが出ます。
            </div>
          )}
        </div>
      ) : (
        <div className="code-view">{html || "（コードはまだありません）"}</div>
      )}
    </div>
  );
}
