/* 本体エージェント診断用バンドル生成: providers/chat は差し替えず実物を Node で実行する。
   fetch はテスト側でスタブし、各社の応答はスキーマ的に正しい形で返す。 */
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(here, "agent-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(here, ".agent-bundle.mjs"),
  logLevel: "warning",
});
console.log("agent bundle ok");
