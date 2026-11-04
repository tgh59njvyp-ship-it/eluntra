import { defineConfig } from "vite";

// GitHub Pages等のサブパス配信でも動くよう、相対ベースにする
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
