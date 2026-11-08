# Eluntra（v6.3・作り直し版）

31社のAIプロバイダーを、自分のAPIキー（BYOK）で使うAIチャットプラットフォーム。
v6.0は旧バージョンのコードを流用せず、React 18 + Vite + TypeScript（strict）で1から作り直した版です。

- 公開URL: https://eluntra.vercel.app ／ https://simple-url-server.lovable.app/s/eluntra/
- ソース: `app/`（React + TypeScript）。開発の正はこの版です
- ルートの `index.html` は旧版（v4.12単一HTML）の凍結コピーです。今後は更新しません

## 引き継ぎ互換
- localStorage のキーと形式は旧版と同一（eluntra_keys / eluntra_tested / eluntra_models / eluntra_conf / eluntra_sessions / eluntra_notes / eluntra_theme など）。旧版で保存したキー・会話・設定はそのまま読み込めます
- Supabase（共用プロジェクト）のログイン（GitHub / Google / Apple、PKCE）と同期（eluntra_sync、会話IDで統合）も互換。APIキーは同期対象外で、端末内にのみ保存されます

## 対応プロバイダー（31社）
OpenAI / Google Gemini / Anthropic / Mistral AI / Groq / OpenRouter / Cohere / Cloudflare Workers AI / SambaNova / DeepSeek / xAI / Together AI / Fireworks AI / Cerebras / Perplexity / NVIDIA NIM / Hugging Face / Replicate / Amazon Bedrock / Azure AI Foundry / Google Vertex AI / GitHub Models / AI21 Labs / Aleph Alpha / Novita AI / Hyperbolic / SiliconFlow / Ollama / LM Studio / llama.cpp / カスタム（任意のOpenAI互換エンドポイント）

方式差（正直な注記）:
- Perplexity：モデル一覧APIがありません。公式モデルを初期値として表示します
- Amazon Bedrock：APIキー方式ではなくAWS署名（SigV4）で接続します。モデル利用にはBedrock側の有効化が必要です
- Azure：モデル名はAzure側のデプロイ名です
- Google Vertex AI：アクセストークンは約1時間で失効します
- Replicate：Predictions API方式でストリーミングしません。モデルごとに入力形式が異なり動かない場合があります
- Aleph Alpha：独自形式のため互換方式での送信を試みる実装で、実キー未検証です
- ローカルAI（Ollama等）：スマホからは自宅PCの localhost に届きません
- カスタム：接続は中継サーバーを介さずブラウザから直接行います（中継の許可リスト外のホストでも使えるようにするため）。そのため接続先がブラウザからのアクセス（CORS）を許可していない場合はつながりません

## 機能
- BYOK（複数欄キー対応・マスキング・接続テスト・モデル一覧の自動/手動取得・取得日時・お気に入り・最近使用）
- Eluntra Auto（質問分類でスコアリングし、選択理由を表示。失敗時は次候補へ自動切替）
- 思考レベル Low / Medium / High / Super high（対応範囲で実リクエストへ反映）
- Agent Mode（Web検索・ページ取得・JS実行・日時・メモ・コネクタツール、最大8手順、出典表示）
- コネクタ16種（公式ロゴ表示。接続はログイン式が基本で、実働はトークン方式の GitHub / YouTube / Notion / Slack / Discord の5種。GitHubはデバイスフロー実装済みだがアプリ側の有効化待ち。その他はOAuthアプリ登録が必要なため「準備中」と明示。詳細は下記 v6.2 の変更）
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

## v6.2の変更

- コネクタ16種の表示を各社の公式ブランドロゴに変更（全種 Simple Icons から取得し SVG 同梱。内訳は DESIGN.md の v6.2 節を参照）
- コネクタの接続を「押すとログイン画面に飛ぶ」方式を主役に作り替え：
  - GitHub：デバイスフローを実装。中継は Vercel の `/api/oauth/github-device`。ただし 2026-11-08 実測で、ログイン用GitHubアプリのデバイスフローが未有効化（device_flow_disabled）のため未接続。有効化手順はアプリ内と DESIGN.md に記載。有効化されれば追加実装なしで接続できる
  - その他のサービス：認可コード＋PKCE の汎用エンジン＋設定テーブル、戻り先ページ（/connectors/callback）、トークン交換エンドポイント（/api/oauth/exchange、シークレットは Vercel 環境変数・未登録）まで基盤を実装。実際に繋げるには各サービスの開発者画面でのアプリ登録（リダイレクト先 https://eluntra.vercel.app/connectors/callback とクライアント情報）＋シークレットの環境変数登録が必要で、未登録の間はアプリ内で説明を表示して「準備中」とする
  - Google系について：client_id は既存ログイン用アプリから取得できたが、そのリダイレクトURIは Supabase コールバック（https://rzgldbedsjocmvqrfdhf.supabase.co/auth/v1/callback）専用登録のため、コネクタ用リダイレクトURIの追加登録なしには認可が進まない。これが「あと何をすれば繋がるか」の具体的な残作業
  - トークン入力欄は主UIから撤去し、実働5種のみ「トークンで接続（上級者向け）」の折りたたみに残置

## v6.3の変更

- プロバイダー「カスタム」を追加（31社目）。ベースURL（必須）とAPIキー（任意・キー不要の接続先では空欄可）を入力すると、任意のOpenAI互換エンドポイントに接続できる
  - モデル一覧は {ベースURL}/models から取得。モデル選択シートを開くたびに自動で最新化する（失敗時は静かに失敗し、手動の「一覧を取得」で理由を確認できる）
  - 無料／通常の分類：接続先が価格情報を返す場合は「prompt・completion の価格が両方0」のモデルを無料と判定（OpenRouter形式の pricing に対応）。モデルIDが `:free` で終わる、または区切り文字つきで `free` を含む場合も無料。判定材料がないモデルは「通常モデル」に入る。分類はカスタムと OpenRouter で保存され、モデル選択シートで「無料モデル」「通常モデル」の見出し＋「無料」バッジで表示する
  - 接続方式：中継サーバー（/api/proxy）のホスト許可リストに無い任意ホストへ送るため、カスタムはブラウザから直接接続する（ProviderDef の `direct` フラグ）。このため接続先の CORS 設定が前提になる。Auto の候補には入る（local ではないため）
  - 表示ロゴは線描きスライダーの自作 SVG（public/logos/custom.svg）
- 表記を「30社」→「31社」に更新（タイトル・OG・各画面）
