# Eluntra（v6.1・作り直し版）

30社のAIプロバイダーを、自分のAPIキー（BYOK）で使うAIチャットプラットフォーム。
v6.0は旧バージョンのコードを流用せず、React 18 + Vite + TypeScript（strict）で1から作り直した版です。

- 公開URL: https://eluntra.vercel.app ／ https://simple-url-server.lovable.app/s/eluntra/
- ソース: `app/`（React + TypeScript）。開発の正はこの版です
- ルートの `index.html` は旧版（v4.12単一HTML）の凍結コピーです。今後は更新しません

## 引き継ぎ互換
- localStorage のキーと形式は旧版と同一（eluntra_keys / eluntra_tested / eluntra_models / eluntra_conf / eluntra_sessions / eluntra_notes / eluntra_theme など）。旧版で保存したキー・会話・設定はそのまま読み込めます
- Supabase（共用プロジェクト）のログイン（GitHub / Google / Apple、PKCE）と同期（eluntra_sync、会話IDで統合）も互換。APIキーは同期対象外で、端末内にのみ保存されます

## 対応プロバイダー（30社）
OpenAI / Google Gemini / Anthropic / Mistral AI / Groq / OpenRouter / Cohere / Cloudflare Workers AI / SambaNova / DeepSeek / xAI / Together AI / Fireworks AI / Cerebras / Perplexity / NVIDIA NIM / Hugging Face / Replicate / Amazon Bedrock / Azure AI Foundry / Google Vertex AI / GitHub Models / AI21 Labs / Aleph Alpha / Novita AI / Hyperbolic / SiliconFlow / Ollama / LM Studio / llama.cpp

方式差（正直な注記）:
- Perplexity：モデル一覧APIがありません。公式モデルを初期値として表示します
- Amazon Bedrock：APIキー方式ではなくAWS署名（SigV4）で接続します。モデル利用にはBedrock側の有効化が必要です
- Azure：モデル名はAzure側のデプロイ名です
- Google Vertex AI：アクセストークンは約1時間で失効します
- Replicate：Predictions API方式でストリーミングしません。モデルごとに入力形式が異なり動かない場合があります
- Aleph Alpha：独自形式のため互換方式での送信を試みる実装で、実キー未検証です
- ローカルAI（Ollama等）：スマホからは自宅PCの localhost に届きません

## 機能
- BYOK（複数欄キー対応・マスキング・接続テスト・モデル一覧の自動/手動取得・取得日時・お気に入り・最近使用）
- Eluntra Auto（質問分類でスコアリングし、選択理由を表示。失敗時は次候補へ自動切替）
- 思考レベル Low / Medium / High / Super high（対応範囲で実リクエストへ反映）
- Agent Mode（Web検索・ページ取得・JS実行・日時・メモ・コネクタツール、最大8手順、出典表示）
- コネクタ16種（実働は GitHub / YouTube / Notion / Slack / Discord の5種。残りはOAuth登録が必要なため未対応と明示）
- ファイル添付（テキスト系と画像。PDF・DOCX・XLSXは未対応と明示）
- コードモード（端末幅プレビュー 390/430/768/1280/全幅、コード表示、Zip保存）
- チャット（ストリーミング、Markdown、履歴の検索・削除、再生成、編集、コピー）

## 開発
```bash
cd app
npm install
npm run dev     # 開発サーバー
npm run build   # tsc strict + vite build
```

## 未検証について
実キーでのチャット往復・接続テストは全社とも未検証です（キーは利用者の端末内にのみ存在するため）。
各社のエンドポイント到達性はキーなしリクエストで確認済みです（401/403等）。

## v6.1の変更

- モデル選択のプロバイダー部分を、タップで縦スクロールリストが開く「選択ボックス」式に変更（先頭に Eluntra Auto、選択中はチェック表示）
- プロバイダー表示を各社の公式ブランドロゴに全面変更（29社分を SVG で同梱。出典の内訳は DESIGN.md の v6.1 節を参照）。llama.cpp のみ公式マークが両ライブラリに無いためモノグラムのまま
