/* Eluntra Developer: コードエディター
   Monaco Editor（npmパッケージ同梱）を遅延読み込みする。読み込みに失敗した場合は
   プレーンな textarea にフォールバックし、その旨を表示する（空白画面にはしない）。 */

import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";

export interface EditorApi {
  format: () => void;
  find: () => void;
  focus: () => void;
}

export interface MarkerInfo {
  path: string;
  startLineNumber: number;
  message: string;
  severity: number;
}

interface Props {
  path: string | null;
  value: string;
  dark: boolean;
  onChange: (value: string) => void;
  onReady?: (api: EditorApi) => void;
  onMarkers?: (markers: MarkerInfo[]) => void;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown", py: "python", java: "java", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", go: "go", rs: "rust", php: "php",
  sql: "sql", yaml: "yaml", yml: "yaml", xml: "xml", svg: "xml", sh: "shell", bash: "shell",
  toml: "ini", ini: "ini", dockerfile: "dockerfile",
};

const EDITOR_MOBILE_QUERY = "(max-width: 1023.98px)";

function editorFontSize(): number {
  return typeof window !== "undefined" && window.matchMedia(EDITOR_MOBILE_QUERY).matches ? 16 : 13;
}

export function langOf(path: string): string {
  const base = path.split("/").pop() || "";
  if (base === "Dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] || "plaintext";
}

let monacoPromise: Promise<typeof Monaco> | null = null;

async function loadMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      const [monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
        import("monaco-editor"),
        import("monaco-editor/editor/editor.worker.js?worker"),
        import("monaco-editor/language/json/json.worker.js?worker"),
        import("monaco-editor/language/css/css.worker.js?worker"),
        import("monaco-editor/language/html/html.worker.js?worker"),
        import("monaco-editor/language/typescript/ts.worker.js?worker"),
      ]);
      const g = self as unknown as { MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker } };
      g.MonacoEnvironment = {
        getWorker(_id: string, label: string) {
          if (label === "json") return new jsonWorker.default();
          if (label === "css" || label === "scss" || label === "less") return new cssWorker.default();
          if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker.default();
          if (label === "typescript" || label === "javascript") return new tsWorker.default();
          return new editorWorker.default();
        },
      };
      // monaco 0.57 では languages.typescript が型上 deprecated 扱いで、実体が無い場合もあるため防御的に参照する
      // （設定できなくても TS/JS の診断はデフォルト設定で動作する）
      try {
        interface TsApi {
          typescriptDefaults?: { setCompilerOptions: (o: Record<string, unknown>) => void };
          ScriptTarget?: Record<string, number>;
          ModuleKind?: Record<string, number>;
          ModuleResolutionKind?: Record<string, number>;
          JsxEmit?: Record<string, number>;
        }
        const tsApi = (monaco.languages as unknown as { typescript?: TsApi }).typescript;
        if (tsApi?.typescriptDefaults && tsApi.ScriptTarget && tsApi.ModuleKind && tsApi.ModuleResolutionKind && tsApi.JsxEmit) {
          tsApi.typescriptDefaults.setCompilerOptions({
            target: tsApi.ScriptTarget.ES2022,
            module: tsApi.ModuleKind.ESNext,
            moduleResolution: tsApi.ModuleResolutionKind.NodeJs,
            jsx: tsApi.JsxEmit.ReactJSX,
            allowNonTsExtensions: true,
            esModuleInterop: true,
            strict: true,
          });
        }
      } catch {
        /* コンパイラ設定を適用できない環境ではデフォルトで継続 */
      }
      return monaco;
    })();
  }
  return monacoPromise;
}

export function Editor({ path, value, dark, onChange, onReady, onMarkers }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const modelsRef = useRef(new Map<string, Monaco.editor.ITextModel>());
  const [failed, setFailed] = useState(false);
  const [readyTick, setReadyTick] = useState(0);
  const valueRef = useRef(value);
  const pathRef = useRef(path);
  const onChangeRef = useRef(onChange);
  const onMarkersRef = useRef(onMarkers);
  valueRef.current = value;
  pathRef.current = path;
  onChangeRef.current = onChange;
  onMarkersRef.current = onMarkers;

  function getOrCreateModel(monaco: typeof Monaco, p: string, content: string) {
    let model = modelsRef.current.get(p);
    if (!model) {
      const uri = monaco.Uri.parse(`file:///${p}`);
      model = monaco.editor.getModel(uri) || monaco.editor.createModel(content, langOf(p), uri);
      modelsRef.current.set(p, model);
    }
    return model;
  }

  function applyModel() {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    const p = pathRef.current;
    if (!monaco || !editor) return;
    if (!p) {
      editor.setModel(null);
      return;
    }
    const model = getOrCreateModel(monaco, p, valueRef.current);
    const isCurrent = editor.getModel() === model;
    // AI編集・Undo・タブ切替など外部要因で内容が食い違う場合はモデルへ反映する
    // （編集中の自己発火 onChange は値が一致するため影響しない）
    if (!isCurrent || model.getValue() !== valueRef.current) {
      if (model.getValue() !== valueRef.current) model.setValue(valueRef.current);
    }
    if (!isCurrent) editor.setModel(model);
  }

  // 初期化
  useEffect(() => {
    let disposed = false;
    let markerSub: { dispose: () => void } | null = null;
    (async () => {
      try {
        const monaco = await loadMonaco();
        if (disposed || !hostRef.current) return;
        monacoRef.current = monaco;
        const editor = monaco.editor.create(hostRef.current, {
          value: "",
          language: "plaintext",
          theme: "vs",
          automaticLayout: true,
          fontSize: editorFontSize(),
          minimap: { enabled: false },
          lineNumbers: "on",
          folding: true,
          formatOnPaste: true,
          tabSize: 2,
          scrollBeyondLastLine: false,
          padding: { top: 8 },
        });
        editorRef.current = editor;
        editor.onDidChangeModelContent(() => {
          const model = editor.getModel();
          if (model) onChangeRef.current(model.getValue());
        });
        markerSub = monaco.editor.onDidChangeMarkers(() => {
          const out: MarkerInfo[] = [];
          for (const m of monaco.editor.getModelMarkers({})) {
            out.push({
              path: m.resource.path.replace(/^\//, ""),
              startLineNumber: m.startLineNumber,
              message: m.message,
              severity: m.severity,
            });
          }
          onMarkersRef.current?.(out.slice(0, 100));
        });
        onReady?.({
          format: () => void editor.getAction("editor.action.formatDocument")?.run(),
          find: () => void editor.getAction("actions.find")?.run(),
          focus: () => editor.focus(),
        });
        setReadyTick((n) => n + 1);
      } catch (e) {
        console.warn("[Eluntra Developer] Monacoの初期化に失敗したため簡易エディターに切り替えます", e);
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      markerSub?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
      modelsRef.current.forEach((m) => m.dispose());
      modelsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    applyModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, value, readyTick]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (monaco) monaco.editor.setTheme(dark ? "vs-dark" : "vs");
  }, [dark, readyTick]);

  /* スマホ幅では16px、デスクトップでは13px。開いたまま幅が変わっても追随する */
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(EDITOR_MOBILE_QUERY);
    const update = () => editorRef.current?.updateOptions({ fontSize: mq.matches ? 16 : 13 });
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [readyTick]);

  if (failed) {
    return (
      <div className="dev-editor-fallback">
        <div className="dev-editor-note">
          エディター（Monaco）を読み込めなかったため、プレーンなテキスト編集に切り替えています。編集・保存はそのまま使えます。
        </div>
        <textarea
          className="dev-editor-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          aria-label="コードエディター（簡易）"
        />
      </div>
    );
  }

  return <div ref={hostRef} className="dev-editor-host" />;
}
