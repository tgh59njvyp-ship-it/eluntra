# Eluntra

8社のAIを、自分のAPIキー（BYOK）で使うAIチャットサービス。
サーバーはありません（ブラウザから各社APIへ直接接続）。

## 2つの版があります

- **単一HTML版**（ルートの `index.html`）: ビルド不要、この1枚でそのまま動く静的サイト
- **TypeScript版**（`app/`）: Vite + TypeScript（strict）のプロジェクト版。機能は単一HTML版と同一で、保存データ（localStorage）も互換。今後の機能追加・改修はこちらを正として進めます（詳細は `app/README.md`）

## 対応プロバイダー（8社）

| # | プロバイダー | 方式 | キー取得 |
|---|---|---|---|
| 1 | OpenAI | OpenAI互換（ストリーミング） | https://platform.openai.com/api-keys |
| 2 | Google Gemini | Gemini API（ストリーミング） | https://aistudio.google.com/apikey |
| 3 | Anthropic | Messages API | https://console.anthropic.com/settings/keys |
| 4 | Mistral AI | OpenAI互換（ストリーミング） | https://console.mistral.ai/api-keys |
| 5 | Groq | OpenAI互換（ストリーミング） | https://console.groq.com/keys |
| 6 | OpenRouter | OpenAI互換（ストリーミング） | https://openrouter.ai/settings/keys |
| 7 | Cohere | Chat API v2 | https://dashboard.cohere.com/api-keys |
| 8 | DeepSeek | OpenAI互換（ストリーミング） | https://platform.deepseek.com/api_keys |

## 使い方

1. `index.html` をブラウザで開く（または任意の静的ホスティングに置く）
2. 右上の設定アイコンから、使う会社のAPIキーを貼って「保存」→「接続テスト」
3. 上部のモデルピルからモデルを選ぶ（「一覧を取得」で自分のキーで使えるモデルに更新可能）
4. そのままチャットする

## 仕様

- **BYOK専用**: キーは端末のブラウザ内（localStorage）にのみ保存され、選んだ会社のAPIへ直接送られます。Eluntra側にキーが渡ることはありません
- **会話の保存**: 会話履歴も端末内にのみ保存されます（端末間同期はありません）
- **機能**: 会話の複数セッション管理、ストリーミング応答、生成の停止、回答のコピー、システムプロンプト、Temperature調整、モデル一覧の実取得、カスタムモデルID指定、チャットのMarkdown書き出し、全データのエクスポート／全削除、ダークモード
- **エラー表示**: 日本語＋対処法つき（キー違い・上限・モデル不一致など）
- **デザイン**: `DESIGN.md` のデザインシステムに準拠（絵文字アイコンなし、グラデーションなし、線描きSVGのみ）

## ファイル

- `index.html` — 単一HTML版の本体（これ1枚で動作）
- `app/` — TypeScript版（Viteプロジェクト、`app/src/` にソース一式）
- `DESIGN.md` — デザインシステム定義
- `README.md` — このファイル

## 注意

- 料金は各社のAPI従量課金がそのまま適用されます
- ブラウザから各社APIへ直接接続する方式のため、会社やネットワークによっては接続テストのみ失敗する場合があります。その場合はチャット送信で確認してください

## ログインと同期

Supabase Authで GitHub / Google / Apple ログインができます（Appleは提供側の設定完了後に有効）。ログインすると会話と設定をクラウドに同期できます。APIキーは端末内にのみ保存され、同期対象には含みません。
