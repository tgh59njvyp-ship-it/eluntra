# Eluntra（v6.5・作り直し版）

30社のAIプロバイダーを、自分のAPIキー（BYOK）で使うAIチャットプラットフォーム。さらに、OpenAI互換のカスタム接続を自分で何件でも作れます。
v6.0は旧バージョンのコードを流用せず、React 18 + Vite + TypeScript（strict）で1から作り直した版です。

- 公開URL: https://eluntra.vercel.app ／ https://simple-url-server.lovable.app/s/eluntra/
- ソース: `app/`（React + TypeScript）。開発の正はこの版です
- ルートの `index.html` は旧版（v4.12単一HTML）の凍結コピーです。今後は更新しません

## 引き継ぎ互換
- localStorage のキーと形式は旧版と同一（eluntra_keys / eluntra_tested / eluntra_models / eluntra_conf / eluntra_sessions / eluntra_notes / eluntra_theme など）。旧版で保存したキー・会話・設定はそのまま読み込めます
- Supabase（共用プロジェクト）のログイン（GitHub / Google / Apple、PKCE）と同期（eluntra_sync、会話IDで統合）も互換。APIキーは同期対象外で、端末内にのみ保存されます

## 対応プロバイダー（30社＋カスタム）
OpenAI / Google Gemini / Anthropic / Mistral AI / Groq / OpenRouter / Cohere / Cloudflare Workers AI / SambaNova / DeepSeek / xAI / Together AI / Fireworks AI / Cerebras / Perplexity / NVIDIA NIM / Hugging Face / Replicate / Amazon Bedrock / Azure AI Foundry / Google Vertex AI / GitHub Models / AI21 Labs / Aleph Alpha / Novita AI / Hyperbolic / SiliconFlow / Ollama / LM Studio / llama.cpp ＋ カスタム（任意のOpenAI互換エンドポイントを複数・名前つきで追加可能）

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
- Agent Mode（Web検索・ページ取得・JS実行・日時・メモ・コネクタツール・Supabase操作・ブラウザ、最大8手順、出典表示）
- コネクタ17種（公式ロゴ表示。接続はログイン式が基本で、実働はトークン方式の GitHub / YouTube / Notion / Slack / Discord の5種と Supabase。GitHubはデバイスフロー実装済みだがアプリ側の有効化待ち。Supabaseのログイン式はOAuthアプリ登録が必要なため「準備中」と明示。詳細は下記 v6.5 の変更）
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

## v6.5.1の変更（Supabaseログイン式の有効化）

- **Supabase のログイン式接続（OAuth）を有効化した**（v6.5 節の「未有効化（準備中）」状態を置き換える）。2026-11-08 に実施・確認した内容：
  - Supabase 側に OAuth アプリ「Eluntra」を登録（所属組織：tgh59njvyp-ship-it's Org）。リダイレクトURI は `https://eluntra.vercel.app/connectors/callback`、スコープは Projects RW ＋ Database RW
  - Vercel プロジェクト eluntra の環境変数 `OAUTH_SUPABASE_CLIENT_ID` / `OAUTH_SUPABASE_CLIENT_SECRET` を登録済み（値はこのリポジトリにも記録しない）
  - `lib/connectors/oauth.ts` に発行された client_id（公開値）を設定し、`oauthReady("supabase")` が true になる状態にした
  - 実測：認可エンドポイントが PKCE パラメータつきで Supabase の同意画面へリダイレクトすること、トークン交換エンドポイント `/api/oauth/exchange` が Supabase へ到達すること（ダミーの認可コードでは `exchange_failed` を返し、`not_configured` ではない）を確認済み
  - ユーザー本人の実接続（同意→トークン取得）の往復は未検証

## v6.5の変更

- **コネクタに Supabase を追加（17種目）**。ロゴは Simple Icons（現行版）から取得し `app/public/logos/conn-supabase.svg` に同梱
  - 接続方法は2つ：
    - **ブラウザでログイン（OAuth）**：Supabase Management API の OAuth 2.0（認可 `https://api.supabase.com/v1/oauth/authorize`、トークン `https://api.supabase.com/v1/oauth/token`、スコープ `projects:read projects:write`）。`lib/connectors/oauth.ts` の汎用PKCEエンジンにサービス定義を追加した。**有効化の状態：現時点では未有効化（「準備中」表示）**。有効化に必要なのは、(1) Supabase 側で OAuth アプリを登録しリダイレクトURI `https://eluntra.vercel.app/connectors/callback` を許可すること、(2) 発行された client_id を `oauth.ts` の `SUPABASE_CLIENT_ID` に入れて `clientIdKnown: true` にすること、(3) Vercel 環境変数 `OAUTH_SUPABASE_CLIENT_ID` / `OAUTH_SUPABASE_CLIENT_SECRET` を登録すること、(4) 再デプロイ。トークン交換エンドポイント `/api/oauth/exchange` は環境変数をサービス名から汎用的に読むため変更不要だったが、転送先の許可リスト（SERVICES）に supabase のエントリが無かったため1件追加した（アカウント表示はプロジェクト一覧の先頭の名前、無ければ "Supabase"）。Supabase にはプロフィール取得用エンドポイントが無いため、接続確認はプロジェクト一覧の成功で代替する。リフレッシュトークンが発行される場合も保存はアクセストークンのみで、失効したら再接続する運用
    - **トークンで接続（上級者向け）**：プロジェクトURL／サービスロールキー／アクセストークン sbp_（任意）の3欄。URL＋サービスロールキー、または sbp_ 単独で「接続済み」になる。保存形式は他のトークンコネクタと同じ `eluntra_connectors` 枠に JSON 文字列で一体化し、端末内のみ保存（Supabase 同期の collect 対象は sessions/conf/notes/code のみで、コネクタ情報は含まれないことを確認済み）。サービスロールキーはフルアクセス権限を持つ旨を入力欄の説明に明記した
  - 接続テスト：URL＋サービスロールキー時は `GET {url}/rest/v1/`（apikey＋Authorization）、sbp_ 時は `GET https://api.supabase.com/v1/projects`
- **エージェントに Supabase ツールを追加**（コネクタ接続時のみ実働。未接続時は接続を促す日本語メッセージを返す）
  - `supabase_tables`：テーブル一覧（REST 時は PostgREST の OpenAPI ルートから、Management のみ時は information_schema への SQL で）
  - `supabase_select`：行の読み取り（REST GET、limit 最大50、任意で「列名=値」フィルタ。REST 情報が無い場合は SQL 経路）
  - `supabase_insert` / `supabase_update` / `supabase_delete`：REST の POST/PATCH/DELETE（サービスロールキーのみ）。update/delete はフィルタ必須で、全件書き込みは拒否する
  - `supabase_sql`：Management API `POST /v1/projects/{ref}/database/query`（sbp_ または OAuth トークン。ref はプロジェクトURLから、無い場合はプロジェクト一覧の先頭）
  - `supabase_auth_users`：Auth Admin API で「ログイン機能」のユーザー管理（一覧／作成／削除、サービスロールキー）
  - 通信は Supabase API が CORS 対応のため直接。ネットワーク層の失敗時のみ `/api/custom-proxy` 経由で1回再試行する。結果は長さを切り詰め、キー類はツール結果に含めない
- **エージェントに「ブラウザ」ツールを追加**（ブラウザ連携）
  - 実ブラウザエンジンは Web アプリ内では動かせないため、サーバー補助の軽量ブラウザとして正直に設計：新ルート `deploy/api/browser.js`（Vercel Node Function）がページ取得・本文/リンク/フォーム抽出・フォーム送信を行う。SSRF ガードは custom-proxy と同方式（https のみ、リテラルIP＋DNS解決後アドレスの内部レンジ拒否）。リダイレクトは最大5ホップ、各ホップで再検証。応答サイズ上限 2MB、本文は約6000字まで
  - クライアント側（`lib/agent/browser.ts`）は現在のページと Cookie ジャーを sessionStorage に保持し（同期対象外）、ツールの action は open / click（リンク番号）/ submit（フォーム番号＋値）/ read
  - **制限**：JavaScript で描画されるページや、ログインが必要なページは開けない場合があります（ツール説明にも明記）

## v6.4の変更

- **カスタムプロバイダーを複数作成・名前変更可能に**（v6.3 は単一の静的エントリだった）
  - 保存形式：新 localStorage キー `eluntra_customs` に `CustomEntry[]`（`{ id, name, base, key }`）として保存。ID は `custom-<base36時刻>-<連番+乱数>` で作成後に不変。キーを含むため APIキー同様に端末内のみ保存し、Supabase 同期（collect の対象は sessions/conf/notes/code のみ）には含めない
  - 静的レジストリの `custom` エントリは廃止。実行時は store の `customDef(entry)` で ProviderDef を合成し、`allProviders()` / `providerDefOf(id)` / `isCustomId(id)` で組み込み30社と統一的に解決する（Auto の候補にも入り、PRIORITY に無い id は最下位ランクとして扱い -1 バグを回避）
  - 設定画面に専用セクション「カスタムプロバイダー」を新設：名前（編集可）・ベースURL・APIキー（任意）の行を何件でも追加でき、保存／接続テスト／一覧を取得／削除（確認ダイアログつき）が各行で可能
  - 移行：v6.3 の `keys["custom"]`（"base::key"）が残っていれば、初回起動時に名前「カスタム」のエントリへ自動移行し、取得済みモデル・分類・テスト状態・選択中モデル・現在のプロバイダー指定も新しい id へ引き継ぐ（旧キーは削除）
- **CORS対策：カスタムの通信を Vercel バックエンド経由に変更**（v6.3 のブラウザ直接接続を廃止）
  - 新ルート `deploy/api/custom-proxy.js`（Vercel Node Function）。契約は既存中継と同じ `x-target-url` ヘッダー方式で、GET/POST、Authorization / Content-Type / Accept のみ転送し、応答はステータスと Content-Type を保ってストリーミングで返す（SSE 通過）。リダイレクトは追従せずそのまま返す
  - SSRFガード：https のみ／localhost・*.local・*.internal を拒否／リテラルIPと **DNS解決後の全アドレス** について、プライベート・ループバック・リンクローカル帯（10/8、127/8、172.16/12、192.168/16、169.254/16、0/8、::1、fc00::/7、fe80::/10、IPv4射影IPv6含む）を拒否。不合格は 400/403 の JSON エラー。Authorization とボディは記録しない。リクエストボディ上限 10MB
  - Node ランタイムにした理由：Edge では node:dns が使えず、DNS解決結果まで検証できないため。本番検証済み（公開ドメイン名で 127.0.0.1 を返す localtest.me も 403 で遮断）
  - クライアント側は ProviderDef の `backendProxy` フラグ（v6.3 の `direct` を置き換え）で transport を切り替え、カスタムは常にこの中継のみを使う（直接接続へのフォールバックなし）
  - 組み込み30社の /api/proxy（許可リスト方式）は変更なし
- 表記を「31社」→「30社」に戻し、カスタムは別建てで案内（タイトル・OG・各画面）。版表示は v6.4

## v6.3の変更

- プロバイダー「カスタム」を追加（31社目）。ベースURL（必須）とAPIキー（任意・キー不要の接続先では空欄可）を入力すると、任意のOpenAI互換エンドポイントに接続できる
  - モデル一覧は {ベースURL}/models から取得。モデル選択シートを開くたびに自動で最新化する（失敗時は静かに失敗し、手動の「一覧を取得」で理由を確認できる）
  - 無料／通常の分類：接続先が価格情報を返す場合は「prompt・completion の価格が両方0」のモデルを無料と判定（OpenRouter形式の pricing に対応）。モデルIDが `:free` で終わる、または区切り文字つきで `free` を含む場合も無料。判定材料がないモデルは「通常モデル」に入る。分類はカスタムと OpenRouter で保存され、モデル選択シートで「無料モデル」「通常モデル」の見出し＋「無料」バッジで表示する
  - 接続方式：中継サーバー（/api/proxy）のホスト許可リストに無い任意ホストへ送るため、カスタムはブラウザから直接接続する（ProviderDef の `direct` フラグ）。このため接続先の CORS 設定が前提になる。Auto の候補には入る（local ではないため）
  - 表示ロゴは線描きスライダーの自作 SVG（public/logos/custom.svg）
- 表記を「30社」→「31社」に更新（タイトル・OG・各画面）
