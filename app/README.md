# Eluntra（TypeScript版）

EluntraのTypeScript版です。Vite + TypeScript（strict）で構築し、機能はルートの単一HTML版と同一です。
保存データ（localStorageのキーと形式）も単一HTML版と互換性があります。

## 開発

```bash
npm install
npm run dev        # 開発サーバー（http://localhost:5173）
npm run build      # 型チェック + 本番ビルド（dist/ に出力）
npm run preview    # ビルド成果物のプレビュー
npm run typecheck  # 型チェックのみ
```

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | Viteのエントリ（画面の骨格） |
| `src/main.ts` | 起動・イベント配線・送信フロー |
| `src/render.ts` | 画面描画（チャット・設定・モデルシート等） |
| `src/api.ts` | 各社API呼び出し（接続テスト／モデル取得／チャット） |
| `src/providers.ts` | プロバイダー8社の定義 |
| `src/state.ts` | 状態管理とlocalStorage永続化 |
| `src/markdown.ts` | 最小Markdownレンダラ |
| `src/types.ts` | 共通型定義 |
| `src/util.ts` | 小物ユーティリティ |
| `src/styles.css` | デザインシステム準拠のスタイル |

## ルートの単一HTML版との関係

- ルートの `../index.html` はビルド不要でそのまま開ける単一ファイル版として残しています
- 機能追加・改修はこちらのTypeScript版を正として進め、必要に応じて単一HTML版へ反映します

## ログインと同期

Supabase Authで GitHub / Google / Apple ログインができます（Appleは提供側の設定完了後に有効）。ログインすると会話と設定をクラウドに同期できます。APIキーは端末内にのみ保存され、同期対象には含みません。
