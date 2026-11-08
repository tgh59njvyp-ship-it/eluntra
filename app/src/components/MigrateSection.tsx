import { useEffect, useRef, useState } from "react";
import {
  applyImport, EXPORT_MESSAGE_TYPE, isDevHost, legacyBase, legacyOrigin, summarizeExport,
  type ExportSummary,
} from "../lib/migrate";

type Phase = "idle" | "waiting" | "confirm" | "error";

/**
 * 設定画面の「データの引き継ぎ」セクション。
 * 以前のURL（SUS）を iframe で読み込み、ブラウザ同士の postMessage で
 * localStorage のデータを受け取る。サーバーは一切経由しない。
 */
export function MigrateSection() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [frameSrc, setFrameSrc] = useState("");
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const dataRef = useRef<Record<string, string> | null>(null);
  const timerRef = useRef<number>(0);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  const cleanup = () => {
    window.removeEventListener("message", onMessage);
    window.clearTimeout(timerRef.current);
  };

  const onMessage = (e: MessageEvent) => {
    if (phaseRef.current !== "waiting") return;
    const expected = legacyOrigin();
    const devOk =
      isDevHost() && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(e.origin);
    if (e.origin !== expected && !devOk) return;
    const msg = e.data as { type?: string; data?: Record<string, string> } | null;
    if (!msg || msg.type !== EXPORT_MESSAGE_TYPE || !msg.data || typeof msg.data !== "object") return;
    dataRef.current = msg.data;
    setSummary(summarizeExport(msg.data));
    cleanup();
    setPhase("confirm");
  };

  const start = () => {
    dataRef.current = null;
    setSummary(null);
    setFrameSrc(`${legacyBase()}?migrate_export=1`);
    setPhase("waiting");
    window.addEventListener("message", onMessage);
    timerRef.current = window.setTimeout(() => {
      if (phaseRef.current === "waiting") {
        cleanup();
        setPhase("error");
      }
    }, 10000);
  };

  const cancel = () => {
    cleanup();
    dataRef.current = null;
    setSummary(null);
    setFrameSrc("");
    setPhase("idle");
  };

  const confirm = () => {
    if (!dataRef.current) return;
    applyImport(dataRef.current);
    location.reload();
  };

  useEffect(() => cleanup, []);

  return (
    <>
      <div className="set-sec">データの引き継ぎ</div>
      <p className="set-desc">
        Eluntraは https://eluntra.vercel.app に引っ越しました。以前のURL（simple-url-server.lovable.app）で使っていたキー・会話・設定を、このURLへ引き継げます。引き継ぎはこの端末のブラウザ内で直接行われ、サーバーへは送信されません。
      </p>
      {phase === "idle" && (
        <button type="button" className="btn secondary sm" onClick={start}>
          以前のURLから引き継ぐ
        </button>
      )}
      {(phase === "waiting" || phase === "confirm") && (
        <div>
          <iframe
            title="以前のURLからの引き継ぎ"
            src={frameSrc}
            style={{ width: "100%", height: 110, border: "1px solid var(--line)", borderRadius: 10, background: "#fff" }}
          />
          {phase === "waiting" && (
            <p className="set-desc" style={{ marginTop: 8 }}>
              以前のURLからデータを読み取っています…
            </p>
          )}
          {phase === "confirm" && summary && (
            <>
              <p className="set-desc" style={{ marginTop: 8 }}>
                以前のURLからデータが届きました。取り込むと、このURL側の同じ項目は引き継ぎ内容で上書きされます。
                <br />
                内訳：APIキー {summary.keyCount}件／会話 {summary.sessionCount}件／カスタム {summary.customCount}件／コネクタ {summary.connectorCount}件（保存項目 合計{summary.totalKeys}件）
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn primary sm" onClick={confirm}>
                  取り込む
                </button>
                <button type="button" className="btn ghost sm" onClick={cancel}>
                  やめる
                </button>
              </div>
            </>
          )}
          {phase === "waiting" && (
            <button type="button" className="btn ghost sm" onClick={cancel}>
              やめる
            </button>
          )}
        </div>
      )}
      {phase === "error" && (
        <>
          <p className="set-desc">
            以前のURLから応答がありませんでした。対処：以前のURLを開いたことのある、この端末の同じブラウザで試してください。以前のURL側にデータが保存されていない場合は、引き継ぐものがありません。
          </p>
          <button type="button" className="btn secondary sm" onClick={start}>
            もう一度試す
          </button>
        </>
      )}
    </>
  );
}
