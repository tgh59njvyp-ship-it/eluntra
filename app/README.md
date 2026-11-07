# Eluntra アプリ（v6.0）

React 18 + Vite + TypeScript（strict）で1から作り直した Eluntra 本体です。

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
