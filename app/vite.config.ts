import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// サブパス配信（simple-url-server配下など）でも動くよう相対ベースにする
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
