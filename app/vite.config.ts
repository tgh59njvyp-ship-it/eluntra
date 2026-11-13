import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// サブパス配信（simple-url-server配下など）でも動くよう相対ベースにする
// playgrounds.html は Playgrounds（AIコード生成）の独立エントリ。本体と同じオリジンで
// localStorage（APIキー・設定・ログインセッション）を共有する。
// 旧 developer.html は public/developer.html の静的スタブとして dist に入り、
// playgrounds.html へ転送する（v8.0.0 の改称対応）。
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        playgrounds: fileURLToPath(new URL("./playgrounds.html", import.meta.url)),
      },
    },
  },
});
