# Eluntra（v6.8・作り直し版）

30社のAIプロバイダーを、自分のAPIキー（BYOK）で使うAIチャットプラットフォーム。さらに、OpenAI互換のカスタム接続を自分で何件でも作れます。
v6.0は旧バージョンのコードを流用せず、React 18 + Vite + TypeScript（strict）で1から作り直した版です。

- 公開URL: **https://eluntra.vercel.app（正はこちらに一本化）**。旧URL https://simple-url-server.lovable.app/s/eluntra/ は v6.7 で引っ越し案内（リダイレクト＋引き継ぎ用エクスポーター）へ置き換えた（下記 v6.7 の変更）
- ソース: `app/`（React + TypeScript）。開発の正はこの版です
- ルートの `index.html` は旧版（v4.12単一HTML）の凍結コピーです。今後は更新しません

## 引き継ぎ互換
- localStorage のキーと形式は旧版と同一（eluntra_keys / eluntra_tested / eluntra_models / eluntra_conf / eluntra_sessions / eluntra_notes / eluntra_theme など）。旧版で保存したキー・会話・設定はそのまま読み込めます
- Supabase（共用プロジェクト）のログイン（GitHub / Google / Apple、PKCE）と同期（eluntra_sync、会話IDで統合）も互換。v6.8 からは APIキー・カスタム接続・コネクタの接続情報も同期対象になり、ログインした端末へ引き継がれる（下記 v6.8 の変更）

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
- BYOK（複数欄キー対応・マスキング・接続テスト・モデル一覧の自動/手動取得・取得日時・お気に入り）
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

## v6.7の変更（URL統合）

- **公開URLを https://eluntra.vercel.app に一本化した**
  - 背景：Vercel 側が古い版に戻る事故は、Vercel↔GitHub 連携の自動デプロイが GitHub 同期のたびにリポジトリ直下の旧アプリを上書きしていたことが原因で、連携を切断して根治済み（GitHub 同期ではもう上書きされない）
  - 旧URL（simple-url-server.lovable.app/s/eluntra/）は単一HTMLのスタブ（`sus-stub.html`）に置き換えた。通常アクセスは「引っ越しました」表示の後 eluntra.vercel.app へ自動遷移する。ただし `?migrate_export=1` 付きで eluntra.vercel.app から iframe 埋め込みされた場合に限り、後述の引き継ぎエクスポーターとして動作する（遅れての引き継ぎに対応するため残置）
- **データの引き継ぎ機能を追加**（`lib/migrate.ts`、設定「データの引き継ぎ」）
  - APIキー等は localStorage（オリジンごと）に保存されクラウド同期されないため、旧オリジン→新オリジンへの移行手段を用意した
  - 送信側：アプリ（およびスタブ）が `?migrate_export=1` かつ iframe 内で開かれた場合に、localStorage の `eluntra_*` 全項目を親へ postMessage する。宛先は本番では `https://eluntra.vercel.app` に厳密限定（開発時のみ localhost 同士を許可）
  - 受信側：設定の引き継ぎ画面が旧URLを iframe で読み込み、origin を厳密検証して受け取り、内訳（APIキー／会話／カスタム／コネクタの件数）を確認してから取り込む。同名キーは引き継ぎ側が優先し、無い項目は残す。取り込み後にリロードして完了トーストを表示
  - **データがサーバーを経由することは一切ない**（同一端末・同一ブラウザ内での postMessage のみ）。引き継ぎは利用者本人が自分のスマホで実行する必要がある
  - ローカル二オリジン検証済み：別ポート同士で、送信側に仕込んだキー2件・会話1件・カスタム1件が受信側へ移ることを実ブラウザ（CDP駆動）で確認
- **モデル選択シートの「最近使用」セクションを削除した**（ユーザーの指示）。store の recents 自体は互換のため残置し、UIとシート内の描画コードのみ撤去

## v6.8の変更（ログインでAPIキーとデータを引き継ぎ）

- **アカウント同期の対象を拡張した**（ユーザーの明示指示「ログインしたらAPIとかデータを引き継げるようにして」による方針変更。v6.7 までは APIキーを同期対象外としていた）
  - 同期ペイロード（`lib/auth.ts` の `collect`/`SyncData`）に `keys`（プロバイダーAPIキー）・`customs`（カスタムプロバイダー、キー含む）・`connectors` / `connectorAccounts`（コネクタ接続情報）・`fetchedModels`（取得済みモデル一覧）・`modelFlags`（無料/通常の分類）・`favorites`・`theme` を追加。従来の sessions / conf / notes / codes と合わせて、ログインすれば新規ブラウザ・別端末でも設定一式が復元される
  - ペイロードの新フィールドはすべて任意。旧ペイロード（キー類なし）を取り込んでも既存の適用処理がそのまま動き、ローカルのキーは消えない
- **取り込みは統合（マージ）で統一し、データを消さない**
  - レコード型（keys / connectors / connectorAccounts / fetchedModels / modelFlags / favorites）は項目単位で統合：クラウドにある項目はクラウド優先、ローカルだけにある項目は保持する
  - customs は ID 単位で統合（同 ID はクラウド優先、ローカルだけの ID は保持、クラウドだけの ID は追加）。sessions は従来どおり会話 ID で統合
  - theme はクラウドにあればその値を適用する
  - pull の適用後にマージ済み状態が push され、端末間の内容は和集合へ収束する
- **push の自動化**：`store.update()` が同期対象スライスの変更を `onDataChanged` で通知し、`auth.ts` がログイン中のみ 2.5 秒デバウンスで `pushSync()` を予約するようにした。キー・カスタム・コネクタの変更も、従来の明示 push（送信後・「今すぐ同期」・エージェント実行後）に加えて自動で同期される。pushSync 自体は update() を呼ばないためループしない
- **同期しないもの（従来どおり）**：認証セッション自体（`eluntra_auth`）、OAuth の pending（`eluntra_oauth_pending`）、最終同期時刻（`eluntra_last_sync`）、sessionStorage の内容（エージェントのブラウザセッション等）、移行ヘルパーの状態
- **保存先と権限**：キーは本人の Supabase アカウントの専用行（`eluntra_sync`、RLS で自分の行だけ読み書き可能）に保存される。ログイン中はサーバー側にキーが保存されることを設定・Welcome の文言で明示した。ログアウトしてもクラウド側のデータは消えず、次回ログインで戻る（設定の「データ管理」は端末内データの削除のみで、クラウド側は対象外のまま）
- **検証**：実コードの `collect`/`apply` を esbuild でバンドルし、localStorage シム上で3シナリオ（旧ペイロード×ローカルキーあり→保持／空ローカル×クラウドキーあり→復元／両方あり→和集合・競合はクラウド優先）を実行し全21件のアサーションが合格。実アカウントでの二端末ログイン往復は未検証（利用者本人のアカウントが必要なため）

## v6.6の変更

- **通常ログインでアカウントを選べるようにした**（Fix A）
  - 症状：GitHub（Google側の身份に紐づくアカウント）でログインした後、別のGitHubアカウント（Apple側）でログインしようとしても、プロバイダ側に残っているセッションが黙って再利用され、常に戻されてしまう
  - 対応：`lib/auth.ts` の `loginWith` で、github / google の認可URLに `prompt=select_account` を付与した。GoTrue はこのパラメータをプロバイダの認可URLへそのまま転送することを実測で確認済み（リダイレクト先 Location に `prompt=select_account` が含まれる）。GitHub / Google はアカウント選択画面を出すため、ブラウザに残ったセッションと違うアカウントでも入り直せる。Apple には付けていない
  - ログアウトの後始末も強化：`logout()` で保存セッション（`eluntra_auth`）に加えて、未完了ログインの PKCE 検証子（sessionStorage）と同期の最終時刻 `eluntra_last_sync` も消す。後者は別アカウントのクラウドデータ取り込み判定に使うため、残すとアカウント切替時に取り込みが抑制され得た
  - **Apple ログインボタンの扱い**：共用 Supabase プロジェクトの Apple プロバイダは 2026-11-04 時点で未有効化だったため再実測した。`GET /auth/v1/authorize?provider=apple&redirect_to=...` は **400 を返し appleid.apple.com へリダイレクトしない＝現在も未有効化**。押せるとエラー画面に落ちて「Googleに戻された」ように見えるため、Welcome（ログイン画面）と設定のアカウント欄の両方で Apple ボタンを **無効＋「（準備中）」表示** に変更した。有効化するには Supabase 側で Apple プロバイダの設定（Services ID 等）が必要
- **コードのプレビュー機能を追加**（Feature B）
  - チャット（通常モード／コードモード共通の `ChatPane`＋`Markdown`）のコードブロックで、言語が html / xml / svg / css / js / javascript の場合に「プレビュー」ボタンを表示する（従来の完成コード用パネル `CodePreview` はそのまま）
  - 表示は全画面シート（`components/CodePreviewSheet.tsx`）。中身は `<iframe sandbox="allow-scripts" srcDoc>` で、**allow-same-origin は付けない**（アプリ本体のオリジンから隔離）。組み立ては `lib/preview.ts`：
    - 完全なHTML文書（`<!DOCTYPE` / `<html` で始まる）はそのまま
    - HTML断片は最小テンプレート（viewport・基本スタイル）で包む旨をシート内に注記
    - CSS単体は `<style>` として見本要素（見出し・段落・ボタン・フォーム・表）に適用し、その旨を注記
    - JS単体は console.log 等の出力をページ内に集める仕掛けと一緒に実行し、結果エリアに表示する旨を注記。埋め込み時に `</script>` / `</style>` の閉じタグ文字列はエスケープする
  - ツールバー：再読み込み／コードをコピー／ダウンロード（組み立て後のHTMLを `preview.html` で保存）／新しいタブで開く（Blob URL）
  - 制限：プレビューは隔離された iframe 内の表示のみで、外部ファイルの相対参照（別ファイルの CSS/JS/画像）は読み込まれない。生成コードが完結した単一HTMLの場合に最も正確

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

## v7.1の変更（Eluntra Developer：AIソフトウェア開発環境）

Eluntra Code（軽量なコード生成・編集）とは別に、本格的なAI開発環境「Eluntra Developer」を追加した。

- 入口: **https://eluntra.vercel.app/developer.html**（本体サイドバーの「Developer」から新しいタブで開く）。本体とは別エントリだが同一オリジンのため、本体の localStorage（APIキー `eluntra_keys`、カスタム接続、`eluntra_conf`、コネクタ状態、テーマ、Supabaseログインセッション `eluntra_auth`）をそのまま共有する。未ログイン時は案内を表示し、AI開発とGitHub操作は無効化する（閲覧・編集は可能）
- ファイルシステム: プロジェクトを `eluntra_dev_projects`（localStorage）に実保存。複数プロジェクト、テンプレート（空／静的サイト／React+TypeScript(Vite)）、作成・名前変更・削除・移動、プロジェクト全体検索、行単位LCS差分、ファイル単位Undo/Redo、自動保存、変更履歴、JSON書き出し/読み込み
- エディター: Monaco Editor（npm同梱、遅延読み込み）。シンタックスハイライト（主要言語）、行番号、タブ、検索・置換、整形、折りたたみ、TypeScript/JavaScriptの診断（問題パネルに表示）。読み込み失敗時はプレーンなテキスト編集へフォールバックし、その旨を表示する
- ターミナル／プレビュー: WebContainer（ブラウザ内Node.js）。`/developer.html` にだけ COOP/COEP ヘッダー（`deploy/vercel.json`）を付け crossOriginIsolated 化。コマンド実行（npm install / npm run dev / node 等、停止ボタン、120秒上限）、開発サーバーの server-ready URL を iframe プレビュー（モバイル/タブレット/PC幅切替）。ファイル編集はコンテナへ自動同期。静的プロジェクト向けに index.html へ css/js を埋め込む静的プレビューも併設。起動できない環境では理由（crossOriginIsolatedでない／60秒タイムアウト等）を表示する
- AI開発エージェント: 本体のプロバイダー層を再利用（現在の選択モデル＋Eluntra Auto、思考レベルも共通設定）。モードは PLAN / BUILD / DEBUG / REVIEW / ASK / AUTO。PLAN・REVIEW・ASK では書き込みツールをコード側で拒否する。ツールは fs_list / fs_read / fs_write / fs_edit / fs_delete / code_search / term_exec / preview_info（すべて実実行）。既存ファイルの上書き・削除は、このセッションで作ったファイル以外は実行前にインライン確認を出す。変更はすべて差分サマリ付きの変更カード（個別に元に戻すボタン付き）で表示する。上限は25手順、同一呼び出し・同一エラーの繰り返しは3回で停止する。実行していない作業を完了と表示しない
- GitHub連携: 本体のGitHubコネクタのトークンで api.github.com へ直接アクセス。接続状態（ログイン名）、リポジトリ一覧、開く（ツリー＋ファイル内容を新規プロジェクトとして取得。バイナリ・256KB超・package-lock は対象外と明示）、新規リポジトリ作成、コミット＆プッシュ（Git Data API で全ファイル＋削除を反映。実行前にHEADとの変更一覧を表示）、再取得（Pull）、 Pull Request作成。ブランチの新規作成・切替は未対応（現在のブランチ表示のみ）と明示した
- UI: デスクトップは左（プロジェクト/ツリー/GitHub）＋中央（エディター）＋右（AIチャット/実行状況）＋下部（ターミナル/プレビュー/問題）。モバイルは下部タブ（ファイル/エディタ/AI/プレビュー/ターミナル）で全画面切替。v7トークン準拠、ダークテーマ対応

### v7.1で対応していないもの（仕様上の制約）
（注: このうち「Pythonの実行」「PostgreSQLの実行」「GitHubのブランチ作成・切替」は v7.2 で対応済み。末尾の v7.2 節を参照）
- Node.js以外のランタイム実行（Python / Java / C / C++ / Go / Rust / PHP）: WebContainerがNode.js専用のため。編集（Monacoのハイライト）は可能
- データベースサーバー（PostgreSQL / MySQL / MongoDB）の実行とコンテナ隔離: ブラウザ内では提供できない。Supabaseは外部APIとして生成コードから使う形（利用者自身のキー）か、本体コネクタ経由で利用する
- 本物のOSシェル／システムパッケージ／任意バイナリの実行
- GitHubのブランチ作成・切替

### v7.1の検証状況
- FS層の単体テスト28件（作成/編集/リネーム/削除/検索/差分/Undo・Redo/ツール層/差分の取り消し）: 全通過
- エージェント統合テスト10件（ローカルの偽OpenAI互換エンドポイントで実駆動）: BUILDでの作成・上書き・確認回数・確認拒否時の不変・PLANでの書き込み拒否を実測し全通過
- 画面: ローカル配信＋ヘッドレスChromeで、デスクトップ1280px（Reactテンプレート＋MonacoのTSXハイライト＋診断6件を問題数として表示）とモバイル390px（ファイル/エディタ/AIタブ）を撮影確認
- WebContainer: この開発VMのヘッドレスChromeは外部CDNへ到達できない（トンネル接続失敗）ため、起動そのものは未検証。crossOriginIsolated=true は実測。起動できない場合は60秒でタイムアウトし、理由をターミナルとパネルに表示することを実測した。実ブラウザ（インターネット接続あり）での起動・npm install・開発サーバーは未検証
- GitHub連携の実操作（開く/作成/プッシュ/PR）: コード実装とUI表示まで。実アカウントでの往復は未検証（利用者のトークンは端末側にのみ存在するため）

## v7.2の変更（Eluntra Developer：未対応項目の実装）

v7.1で「対応していないもの」として明示していた項目のうち、GitHubブランチ・Python実行・データベース（SQLite/PostgreSQL）を実装した。ランタイムは外部CDNではなく自サイト配信のアセットから読み込む方式に統一し、この開発VMのヘッドレスChrome（外部CDN到達不可）でもローカルで実測できるようにした。

- GitHubブランチ: 紐付け中リポジトリのブランチ一覧（先端SHA・保護フラグつき）、ブランチ作成（Git Data API の `POST /git/refs`、起点ブランチを選択可能）、ブランチ切替（対象ブランチの内容で再取得し、プロジェクトの `{repo, branch, headSha}` を更新。未プッシュの変更がある場合は確認ダイアログを出す）。コミット＆プッシュの送信先はプロジェクトに保存された現在のブランチ。Pull Request の base はブランチ一覧から選択する（head は現在のブランチ）
- Python実行: Pyodide（CPython 3.14.2 のWASM版）を `public/pyodide/` に自己ホスト（`scripts/copy-runtime-assets.mjs` が prebuild で node_modules からコピー）。ターミナルで `python file.py` / `python -c "..."` / `python`（対話モード。変数は保持される）/ `pip install <パッケージ>`（micropip 経由、純Pythonパッケージのみ）が動作する。実行前にプロジェクトファイルを Pyodide の FS（/project）へ同期し、実行後に作成・変更・削除されたファイルをプロジェクトへ反映する（反映件数をターミナルに表示）。`.py` ファイルを開くとエディタに「実行」ボタンが出る。AIエージェントの `term_exec` も Python 系コマンドを Pyodide へ振り分ける。制約: ソケット・スレッドは使えない、C拡張パッケージは wheel があるものだけ、実行はメインスレッド（無限ループは画面が止まる）
- データベース: 下部パネルに「データベース」タブを追加（モバイルではターミナル内のサブタブ）。SQLite は sql.js、PostgreSQL は PGlite（どちらもWASMで実際に動作）。プロジェクトごとに複数DBを作成でき、データは端末の IndexedDB に永続化する（SQLite はバイト列を都度保存、PostgreSQL は PGlite の idb:// ストレージ）。SQLコンソール（複数文可、結果を表で表示、行数・変更行数・エラーはエンジンの文面をそのまま表示）、スキーマブラウザ（テーブルと列）、サンプルテーブル作成、SQLite の .db 書き出し/読み込みに対応。AIエージェントには db_list / db_schema / db_query ツールを追加（書き込みSQLは PLAN・REVIEW・ASK ではコード側で拒否、SELECT等は全モード可）
- PHP: `@php-wasm/web`（WordPress Playground のランタイム）で試行したが未対応のまま。理由は2つ。(1) ローダーが PHP 8.0〜8.5 の全バージョンパッケージを静的に取り込み、各 `.wasm` を "ESM integration proposal for Wasm" 形式で import するため、Vite/Rollup の標準ビルドでは扱えない（ビルドエラーになることを実測）。(2) バンドラを外して Emscripten モジュールを直接ホストする方式は、Playground のローダー契約（ランタイムID管理・FS・イベント）の再実装が必要で、範囲外と判断した。部分実装は残していない

### v7.2でも対応していないもの
- MySQL / MongoDB サーバーの実行: ブラウザ内で動かせるWASMサーバーの実装が存在しないため（生成コードから外部サービスへ接続する形のみ。なおブラウザから直接TCP接続はできないため、それもサーバー側コードとしての生成のみ）
- Java / C / C++ / Go / Rust の実行: 自己ホスト可能な信頼できるランタイムがないため。編集（Monacoのハイライト）は可能
- FastAPI / Flask 等のソケットサーバー: Pyodide ではスクリプト実行のみ（ソケットは開けない）
- 本物のOSシェル／システムパッケージ／任意バイナリの実行、コンテナ隔離
- PHP の実行（上記の理由）

### v7.2の検証状況
- ノード単体・統合テスト: コア53件（GitHubブランチのAPI構築をfetchモックで検証、SQLite・PGlite の作成/実行/スキーマ/サンプル/削除、SQL読み書き判定、Pythonコマンド解析、変更反映）・FS回帰28件・エージェント回帰10件・エージェントDBツール6件（モックLLM経由で db_query の実行と PLAN での書き込み拒否を実測）: 全通過
- ブラウザ実測（ローカル配信＋ヘッドレスChrome、実UI操作）15項目: Python のファイル実行・出力表示・生成ファイル（result.txt）のプロジェクト反映と保存、`python -c` の計算、対話モードでの変数保持、SQLite の作成・サンプル・スキーマ表示・SELECT結果表、PostgreSQL（PGlite）の作成・サンプル・スキーマ表示。コンソール例外なし。スクリーンショット: `shots/v72-python-terminal.png` / `v72-python-repl.png` / `v72-sqlite.png` / `v72-postgres.png`
- GitHubブランチの実アカウント往復（作成・切替・プッシュ）は未検証（利用者のトークンは端末側にのみ存在するため）。APIリクエストの構築とプロジェクトへのブランチ保存はモックで検証済み
- WebContainer（Node.js側）は v7.1 から引き続き起動未検証（外部CDN到達不可のため）。Pyodide / sql.js / PGlite は自己ホストのため同条件でも実測できた

## v7.2.1（バグ修正: Developerエージェントの探索ループ対策）
- 症状: AIが「プロジェクトの構成を確認」を繰り返し、ファイル作成に進まない事象への対策
- 探索予算: 読み取り専用ツール（fs_list / fs_read / code_search / preview_info / db_list / db_schema）が、書き込み・ターミナル実行を挟まず連続したら上限でツール層が実行を拒否し、理由と次にすべきことをツール結果として返す（上限は BUILD/AUTO/DEBUG で5回、PLAN/REVIEW/ASK で10回）。拒否はまず1回だけ警告として届け、その後も続く場合は停滞検出で止める
- 重複判定: 同じ結果になる読み取りは全文を返さず「取得済み」の要約だけを返す。fs_list は実装が引数を無視して常に全一覧を返すため、引数が違っても同一結果として扱う。ファイルが変更されたらキャッシュは破棄する
- 停滞検出: ファイル変更・ターミナル実行・最終回答のいずれも無い手順が6回続いたら停止し、何を何回繰り返したかと再試行方法（もう一度送る／BUILD・AUTOで試す／指示を具体的に）を明記した日本語メッセージを出す
- プロンプト: ファイルツリーと package.json はシステムプロンプトに提示済みであること、fs_list は特定の再確認用であること、BUILD/AUTO/DEBUG では最初の数手順以内に作成・編集・実行を始めることを明記
- 進捗表示: 各手順に番号（n/25）と具体的な対象（ツール名＋パス/コマンド）を表示するようにした
- 検証: 台本モデルで「引数を変えた fs_list 連打」「異なるファイルの連続読み取り」「PLAN での広い探索」などを再現する単体テスト（`app/tests/dev-agent.test.mjs`、全57件）が通過。通常の BUILD フロー・確認フロー・DB のモード制限・FS 純粋関数の回帰も含む。利用者の実モデル・実キーでの再現確認は未実施（端末側にのみ存在するため）

## v7.2.2（Developerをログインなしで利用可能に）
- v7.2.2: Eluntra Developer をログインなしで利用可能に（AIは端末内のBYOKキー、GitHubはコネクタの接続状態で動作。本体のログインゲートは変更なし）
- DeveloperApp のログイン状態チェックと、パネル側の「ログインが必要です」バナー／AI送信時のログインブロックを削除。GitHubシートはコネクタのトークンがあれば（Eluntra未ログインでも）表示される
