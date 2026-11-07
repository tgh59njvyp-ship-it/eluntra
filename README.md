# Eluntra

30社のAIを、自分のAPIキー（BYOK）で使うAIチャットサービスです（v5.0）。
ブラウザから各社APIへ直接つなぐ方式を基本にし、ブラウザから直接つなげない会社のために
Vercelの中継サーバー（`server/`、キーは保存・記録しない）も使えます。

## 2つの版があります

- **TypeScript版**（`app/`）: Vite + TypeScript（strict）。正はこちら。今後の機能追加・改修はここで行います（詳細は `app/README.md`）
- **単一HTML版**（ルートの `index.html`）: v4.12時点の単一ファイル版として残置しています。v5.0の機能はTypeScript版にあります

## 対応プロバイダー（30社）

| # | プロバイダー | 方式 | 備考 |
|---|---|---|---|
| 1 | OpenAI | OpenAI互換・ストリーミング | reasoning_effort対応モデルでは思考レベルを反映 |
| 2 | Google Gemini | Gemini API・ストリーミング | 2.5系では thinkingConfig で思考レベルを反映 |
| 3 | Anthropic | Messages API | 対応モデルでは thinking budget で思考レベルを反映 |
| 4 | Mistral AI | OpenAI互換 | |
| 5 | Groq | OpenAI互換 | 無料枠にLlamaチャットモデルは無い（2026-11-07確認） |
| 6 | OpenRouter | OpenAI互換 | |
| 7 | Cohere | Chat API v2 | |
| 8 | Cloudflare Workers AI | OpenAI互換 | Account ID＋トークンの2欄 |
| 9 | SambaNova Cloud | OpenAI互換 | ブラウザ直接不可のため中継経由のみ |
| 10 | DeepSeek | OpenAI互換 | |
| 11 | xAI | OpenAI互換 | |
| 12 | Together AI | OpenAI互換 | |
| 13 | Fireworks AI | OpenAI互換 | |
| 14 | Cerebras | OpenAI互換 | |
| 15 | Perplexity | 独自パス（/chat/completions） | **モデル一覧APIなし**（公式仕様）。初期値は公式ドキュメント記載の sonar 系。citationsが返れば出典表示 |
| 16 | NVIDIA NIM | OpenAI互換 | |
| 17 | Hugging Face | Router（OpenAI互換） | |
| 18 | Replicate | Predictions API | **LLM専用の一覧APIなし**。公式モデルを初期値表示。チャットは非ストリーミング（Prefer: wait）。実キー未検証 |
| 19 | Amazon Bedrock | Converse API＋**SigV4署名**（WebCrypto自前実装） | 入力はアクセスキーID／シークレット／リージョンの3欄。CORS・署名・IAM権限で失敗する場合あり。実キー未検証 |
| 20 | Azure AI Foundry | Azure OpenAI形式 | エンドポイントURL＋APIキー（api-keyヘッダー）。モデル名＝デプロイ名。実キー未検証 |
| 21 | Google Vertex AI | Gemini形式（generateContent） | プロジェクトID／ロケーション／アクセストークンの3欄。**トークンは約1時間で失効**。一覧APIは使わず初期値のみ。実キー未検証 |
| 22 | GitHub Models | OpenAI互換＋カタログAPI | 認証はGitHub PAT。モデルIDは publisher/model 形式 |
| 23 | AI21 Labs | OpenAI風 | 一覧APIが確認できないため、失敗時は jamba-large / jamba-mini を初期値として案内 |
| 24 | Aleph Alpha | 独自形式が本来の仕様 | 互換形式での送信を試みる実装。実キー未検証で、失敗する場合があります |
| 25 | Novita AI | OpenAI互換 | |
| 26 | Hyperbolic | OpenAI互換 | |
| 27 | SiliconFlow | OpenAI互換 | |
| 28 | Ollama（ローカル） | OpenAI互換＋/api/tags | キー不要。中継を経由せず直接接続。スマホからは自分のPCのlocalhostに届きません |
| 29 | LM Studio（ローカル） | OpenAI互換 | キー不要。ベースURL変更可。同上の到達範囲の制限あり |
| 30 | llama.cpp（ローカル） | OpenAI互換 | キー不要。ベースURL変更可。同上の到達範囲の制限あり |

## v5.0の主な機能

- **モデル自動取得**：キーで各社の一覧APIから取得し、取得日時を保存・表示。一覧APIがない会社はその旨を明示し、架空のモデルで補完しません
- **モデル選択**：プロバイダー→モデル／検索／お気に入り（星）／最近使用／「接続済みのみ表示」。能力表示は確認できた範囲だけ
- **Eluntra Auto（高度化）**：質問を分類（コード／数学・論理／画像／長文／簡単／一般）して接続済みモデルをスコアリングし、選択理由を表示。失敗時は既存の自動切替（経路切替・会社切替）と併存
- **思考レベル（Low/Medium/High/Super high）**：実際のリクエストへ反映（OpenAI互換の reasoning_effort、Anthropicの thinking budget、Gemini/Vertexの thinkingConfig、非対応社はシステム指示の補強のみ。効果を保証する表現はしません）
- **Agent Mode**：Web検索（/api/search、DuckDuckGo経由）とページ取得（/api/fetchpage、SSRF防止つき）を追加。実行段階（タスクを分析中／検索中／ページを確認中／情報を整理中／回答を作成中）を表示し、使った出典リンクを回答に保持・表示。外部サイトの指示には従わない設計
- **コネクタ（16種のレジストリ）**：実働はトークン方式で本当に動く5種（GitHub＝PATでリポジトリ一覧、YouTube＝Data APIキーで検索、Notion＝インテグレーショントークンで検索、Slack＝Botトークンで auth.test、Discord＝Botトークンで情報取得）。残り11種（Google系5・Microsoft系2・Dropbox・Linear・Trello・Jira）は「OAuthアプリの登録が必要なため未対応」と表示し、接続済みには見せません。トークンはAPIキーとは別のキーで端末内のみに保存
- **ファイル添付**：テキストファイル（txt/md/json/csv/コード等）は内容を読んで送信、画像（png/jpeg/webp/gif）は対応形式の会社（OpenAI互換の image_url／Geminiの inlineData／Anthropicの base64）でのみ送信。非対応の会社では「テキストのみで送る」旨を事前に案内。**PDF／DOCX／XLSXは未対応**で、選ぶと理由を表示
- **240Hz配慮**：アニメーションは transform/opacity 中心、ストリーミング描画は requestAnimationFrame でバッチ、会話要素に content-visibility:auto。リフレッシュレートはブラウザとディスプレイに任せます

## 仕様

- **BYOK専用**: キーは端末のブラウザ内（localStorage）にのみ保存され、選んだ会社のAPIへ送られます。中継サーバーを使う場合も、キーは中継に保存・記録されません
- **会話の保存**: 端末内に保存。ログイン（Supabase Auth：GitHub/Google/Apple）時は会話と設定をクラウド同期（v4.12の統合方式：端末の会話を消さない）。APIキーとコネクタのトークンは同期対象外
- **エラー表示**: v4.11の方針を維持。画面に出すのはユーザー側の問題（キー違い・未設定・モデル無し・上限）だけ。それ以外は経路・会社を自動で切り替えて再送し、最後は一言だけ表示

## ファイル

- `app/` — TypeScript版（Viteプロジェクト、`app/src/` にソース一式）
- `server/api/proxy.js` — 中継サーバー（対応30社のドメインのみ許可、Azure/Bedrock/Vertexはサフィックス許可）
- `server/api/search.js` — エージェント用Web検索（DuckDuckGo html/lite → JSON）
- `server/api/fetchpage.js` — エージェント用ページ取得（SSRF防止：プライベートIP/localhost拒否・サイズ上限・タイムアウト）
- `index.html` — 単一HTML版（v4.12時点のもの）
- `DESIGN.md` — デザインシステム定義

## 注意

- 料金は各社のAPI従量課金がそのまま適用されます
- 実キーでの生成往復は、キーを入れた本人環境でのみ検証可能です。本書・アプリ内で「未検証」と書いた会社（Bedrock／Vertex／Replicate／Azure／コネクタ実働分など）は、Claude側に実キーがないため未検証です
