import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// サブパス配信（simple-url-server配下など）でも動くよう相対ベースにする
// developer.html は Eluntra Developer（AI開発環境）の独立エントリ。本体と同じオリジンで
// localStorage（APIキー・設定・ログインセッション）を共有する。
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        developer: fileURLToPath(new URL("./developer.html", import.meta.url)),
      },
    },
  },
});
