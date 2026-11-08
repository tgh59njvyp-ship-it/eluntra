# Eluntra アプリ（v7.0）

React 18 + Vite + TypeScript（strict）で1から作り直した Eluntra 本体です。
v7.0 で UI を参考デザインに合わせて全面刷新（白＋淡いブルーの波、グラデーションの星ロゴ、
ピル型コンポーザーとピル行）。デザインの正は `../DESIGN.md` の v7.0 節。

## v7.0 の追加・変更
- `src/components/Logo.tsx` — 星＋小星＋軌道リングの SVG ロゴ（ヘッダー／ヒーロー／ログインで共用）
- チャット空状態をヒーロー化（ロゴ大＋タグライン＋提案カード2×2＋波背景）
- ヘッダー再構成（ロゴ＋モデルピル＋検索＋アカウント円）。検索は会話検索シート（`SearchSheet.tsx`）
- コンポーザーをピル型にし、下にピル行（検索／ファイルを添付／画像を生成／…）
- `src/lib/imagegen.ts` — 画像生成（Gemini gemini-2.5-flash-image → OpenAI gpt-image-1）
- 「検索」ピルは `conf.webSearch`：送信時にエージェント実行＋ web_search 優先の指示（`agent/engine.ts` の `webSearchFirst`）
- 「…」シートに Agent Mode／コードモード／思考レベル／現在のモデルを集約

## 構成
- `src/App.tsx` — 画面構成と送信フロー（自動リカバリ・Auto フォールバック）
- `src/components/` — Sidebar / ChatPane / ModelSheet / Settings / CodeMode / Welcome / Markdown / icons
- `src/lib/store.ts` — 状態と localStorage 保存（旧版と同一キー・形式で互換）
- `src/lib/providers/registry.ts` — プロバイダー30社のレジストリ
- `src/lib/providers/chat.ts` — アダプター（接続テスト・モデル取得・チャット送信）
- `src/lib/providers/bedrock.ts` — AWS SigV4 署名
- `src/lib/providers/transport.ts` — 中継サーバー経由/直接の切替、エラー文の生成
- `src/lib/auto.ts` — Eluntra Auto（質問分類スコアリング）
- `src/lib/agent/engine.ts` — エージェント実行ループ（ツール8種、最大8手順）
- `src/lib/connectors/registry.ts` — コネクタ16種（実働5種）
- `src/lib/auth.ts` — Supabase ログイン（PKCE）と同期（会話IDで統合）
- `src/lib/files.ts` — 添付ファイル読み取り、Zip生成
- `src/styles/` — デザイントークンとコンポーネントCSS（Tailwind不使用）

## コマンド
```bash
npm install
npm run dev
npm run build   # tsc --noEmit && vite build
```
