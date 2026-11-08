/* エージェント単体テスト用バンドル生成: providers/chat を mock-chat.mjs に差し替えて
   src/developer 配下を Node で実行できる形にまとめる。 */
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const stubChat = {
  name: "stub-chat",
  setup(build) {
    build.onResolve({ filter: /lib\/providers\/chat$/ }, () => ({
      path: path.join(here, "mock-chat.mjs"),
    }));
  },
};

await esbuild.build({
  entryPoints: [path.join(here, "entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(here, ".bundle.mjs"),
  plugins: [stubChat],
  external: ["sql.js", "@electric-sql/pglite", "pyodide"],
  logLevel: "warning",
});
console.log("bundle ok");
