import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { tryRunExporter } from "./lib/migrate";
import "./styles/tokens.css";
import "./styles/app.css";

const rootEl = document.getElementById("root")!;

/* 引き継ぎの送信側として開かれた場合は、アプリ本体を描画せず送信だけ行う */
if (tryRunExporter()) {
  rootEl.innerHTML =
    '<div style="font-family:system-ui,sans-serif;padding:24px;font-size:14px;color:#333">引き継ぎデータを送信しました。</div>';
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
