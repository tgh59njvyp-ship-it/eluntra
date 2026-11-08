# Eluntra デザインシステム（v7.0）

> v7.0（2026-11-08）でデザインを全面変更した。ユーザーが提示した参考UIを再現するもので、
> 以下の v7.0 セクションが現行の正であり、それ以前の節（静かな道具・グラデーション禁止・
> 影は浮く面だけ・Hero禁止）は v6 系の記録として残すが、現行デザインには適用しない。

## v7.0 デザインシステム（現行）

コンセプト：白い余白の上に、淡いブルーの波と、青→紫グラデーションの星ロゴ。
丸みのあるフォント、柔らかい影、ピル型の操作部品で統一する。

### ロゴ（`src/components/Logo.tsx`）
- 四芒星（星）：線形グラデーション #38BDF8 → #2E7CF6 → #6366F1 → #A855F7（左上→右下）
- 右上に小さな四芒星、周囲に細い軌道リング（楕円・-11°・左は淡く右は濃いグラデーション）
- ヘッダー（小）・ヒーロー（大・約172px）・サイドバー・ログイン画面で共用。favicon.svg も同じ星

### カラー（`src/styles/tokens.css`）
| 役割 | Light | Dark |
|---|---|---|
| --bg | #FFFFFF | #0A1424（深いネイビー） |
| --surface | #FFFFFF | #10223D |
| --ink | #0F1E3A | #EAF1FF |
| --text-2 | #68758C | #9DB0CC |
| --text-3 | #93A1B8 | #68799A |
| --accent | #2E7CF6 | #5B97FF |
| --accent-soft / --user-bubble | #EAF2FF | #16294D / #1A3160 |
| --pill-bg | #F1F5FB | #14294D |
| --line | #E6EDF7 | #1E3355 |
| 波 --wave-1/2/3 | #E8F1FF / #DCE9FF / #CFE2FF | #0E2142 / #0C1C38 / #0A1730 |

### タイポグラフィ
- フォント：ui-rounded / "Hiragino Maru Gothic ProN" / Hiragino Sans / Noto Sans JP の rounded スタック
- ヒーローの「Eluntra」は 58px・ウェイト800。見出しも同じ rounded で 800

### 形・影
- 角丸：カード 22px、コンポーザー 30px（ピル）、ボタン類は 999px を多用
- 影：カード `0 10px 28px rgba(31,78,160,.09)`、コンポーザー `0 14px 36px rgba(31,78,160,.13)` の柔らかい拡散影

### ホーム（チャットの空状態）
- ヘッダー：罫線なし。ハンバーガー＋ロゴ＋「Eluntra」、右にモデルピル（実際の選択中モデル名を表示）＋検索＋アカウント円
- ヒーロー：ロゴ大＋「Eluntra」＋「あなたの想像を、もっと先へ――」＋「最高のAIと、無限の可能性を。」
- 背景：下部に淡いブルーの波3層（SVG）、右上に淡い blob。ダークでは濃紺の波に切替
- 提案カード 2×2（白・角丸・柔らかい影・右に ›）：今日のおすすめを教えて（送信）／
  このコードを解説して（入力欄へ文面を入れてフォーカス）／この画像を分析して（添付ピッカー→画像が付いたら文面を入力）／
  勉強のコツを教えて（送信）

### コンポーザーとピル行
- コンポーザーは全幅ピル：左クリップ、右は青い円＋白い紙飛行機（送信中は停止ボタン）
- 下のピル行：
  - 「検索」：ON で次の送信をエージェント実行にし、最初に web_search するよう指示する（`conf.webSearch`、`runAgent` の `webSearchFirst`）
  - 「ファイルを添付」：既存の添付ピッカー
  - 「画像を生成」：画像モード。ON で placeholder が「画像の説明を入力...」に変わり、送信で画像生成
    （`src/lib/imagegen.ts`：Gemini キーがあれば gemini-2.5-flash-image、無ければ OpenAI gpt-image-1。
    結果は画像添付つきメッセージ＋ダウンロードリンク。キーが無い場合は設定への案内エラーを表示）
  - 「…」：ボトムシート（Agent Mode／コードモード／思考レベル／現在のモデル）。有効な項目があるとピルにドット表示

### その他の画面
- サイドバー、シート、設定、メッセージ（ユーザーバブル＝淡いブルー、assistant＝地のまま）は
  レイアウトを変えず、新トークン（色・角丸・影）でテーマ適用した

---

# Eluntra デザインシステム（v6.0・作り直し版）【旧・記録】

Eluntraは「30社のAIを、自分のキーで、1つの静かな画面から使う」ためのチャット道具。
v6.0は旧コードを流用せず、React + TypeScript で1から設計し直した。
装飾でAIらしさを演出しない。罫線・余白・タイポグラフィだけで階層を作る。

## 禁止事項
- 絵文字をUIアイコンに使わない（アイコンは線描きSVGのみ）
- 意味のないグラデーションを使わない
- 全要素をカード化して影を付けない（影は浮く面＝シート／モーダルだけ）
- 巨大なHeroを置かない（開いたらすぐチャットできる画面にする）
- ボタンを無秩序に増やさない

## カラー
| 役割 | Light（標準） | Dark |
|---|---|---|
| --bg | #FFFFFF | #131313 |
| --bg-sub | #F7F7F5 | #171717 |
| --ink | #1B1B18 | #F2F2EE |
| --text-2 | #5C5C55 | #B5B5AC |
| --text-3 | #8E8E85 | #7E7E74 |
| --line | #E8E7E1 | #2C2C2C |
| --line-strong | #D8D6CC | #45453F |
| --accent | #2563EB（控えめなブルー） | #7AA5F8 |
| --accent-soft | #EEF3FE | #1C2740 |
| --user-bubble | #EEF3FE | #1C2740 |
| --error | #B3261E / bg #FDF0EF | #FF9A92 / bg #33201E |
| --success | #1E6B4A | #7ED3A8 |

色は「白＋墨色＋ブルー1色＋意味色」だけ。プロバイダーは色付き文字タイル（2文字・各社1色）でのみ色を使う。
テーマはライトが標準。ダークは設定で切替（端末に保存）。

## タイポグラフィ
- 見出し: "Hiragino Mincho ProN", "Yu Mincho", serif（ロゴと空状態・入口の見出しのみ）
- 本文: -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif / 15.5px / 1.75
- 等幅: ui-monospace（モデル名・キー・数値）

## 余白・角丸・影
- スペーシング: 4 / 8 / 12 / 16 / 24 / 32
- 角丸: sm 8px / md 12px / lg 16px / full（ピル・円）
- 影: 面には付けない。シート／モーダルのみ

## コンポーネント
- ボタン高さ 44px（小 36px）。Primary=ブルー単色／Secondary=罫線／Ghost=透明
- アイコンボタン 44×44、SVG 24px・線幅1.8
- 入力欄は角丸22px、フォント16px（iOSズーム防止）、focus時はブルー枠＋ソフトリング
- 状態: hover / active / focus-visible / disabled / loading / empty を用意する

## レイアウト
- デスクトップ: 左サイドバー 288px（会話一覧＋設定）＋チャット列（最大幅 780px 中央。コードモードは 1080px＋プレビュー分割）
- モバイル: サイドバーはドロワー、設定はシート、モデル選択はボトムシート

## 滑らかさ（高リフレッシュレート配慮）
- アニメーションは transform / opacity のみ
- ストリーミング描画は requestAnimationFrame でバッチ化
- 会話要素に content-visibility: auto
- prefers-reduced-motion では遷移を無効化

## v6.0の設計判断
- プロバイダーは「レジストリ＋アダプター」方式。会社追加はレジストリ1件＋必要ならアダプター1つ
- エージェントはネイティブ関数呼び出しに依存しない「モデルがJSONでツールを選ぶ」方式で全社共通に動かす
- 保存データ（localStorageキーと形式・Supabase同期先）は旧版と互換を維持し、ユーザーのキー・会話を引き継ぐ

## v6.1（2026-11-07）プロバイダー選択ボックスと公式ロゴ

- モデル選択シートのプロバイダー部分は、2列グリッドをやめて「選択ボックス」式にした：枠線のある横長の箱（公式ロゴ＋プロバイダー名＋接続状態＋シェブロン）をタップすると、縦スクロールのリストがシート内に展開する。先頭は Eluntra Auto、選択中にはチェック。選択するとリストが閉じ、ボックス表示が切り替わる。開閉は transform/opacity のみの軽いアニメーション
- プロバイダー表示は頭文字モノグラムをやめ、各社の公式ブランドロゴ（SVGを `app/public/logos/` に同梱し、実行時に外部CDNへ取りに行かない）。表示は白地タイルにロゴを載せる形で統一
- ロゴ出典（会社ごと）：
  - Simple Icons：OpenAI（simple-icons v14系。現行版では削除されていたため当該バージョンから取得）／Google Gemini／Anthropic／Mistral AI／OpenRouter／Cloudflare／DeepSeek／Perplexity／NVIDIA／Hugging Face／Replicate／GitHub Models／Ollama／LM Studio
  - Lobe Icons（@lobehub/icons-static-svg）：Groq／Cohere／SambaNova／xAI／Together AI／Fireworks AI／Cerebras／Amazon Bedrock／Azure／Google Vertex AI／AI21 Labs／Aleph Alpha／Novita AI／Hyperbolic／SiliconFlow（Lobeでは「SiliconCloud」表記）
  - ロゴなし：llama.cpp（両ライブラリに公式マークが実在しないため、捏造せずモノグラムのまま）

## v6.2（2026-11-08）コネクタ公式ロゴとログイン式接続

- コネクタ16種の表示も公式ブランドロゴに変更（SVGを `app/public/logos/conn-<id>.svg` に同梱し、実行時に外部へ取りに行かない。白地タイルで統一）
- ロゴ出典：全16種とも Simple Icons。GitHub／YouTube／Notion／Discord／Slack／Google Drive／Google Calendar／Gmail／Google Docs／Google Sheets／Dropbox／Linear／Trello／Jira は simple-icons v13、Microsoft OneDrive／Microsoft Outlook は現行版で削除されていたため v11 から取得。入れられなかったコネクタは無し
- 接続体験は「押すとログイン画面に飛んで、ログインしたら繋がる」ChatGPT式を主役にした：
  - GitHub：デバイスフローを実装（アプリ内コード表示→GitHubの画面でログイン＋コード入力→ポーリングで自動接続、アカウント名表示・切断可）。GitHubのデバイス系エンドポイントはCORSヘッダーを返さないため、Vercel中継 `/api/oauth/github-device`（転送先は該当2エンドポイントのみ）経由。ただし 2026-11-08 の実測で、ログイン用GitHubアプリ側のデバイスフローが未有効化（`device_flow_disabled`）のため現時点では開始できない。アプリ内では有効化手順（GitHubアプリ設定で Allow device flow をオン）を表示し、有効化後はそのまま動く
  - その他：認可コード＋PKCEの汎用エンジンとサービス別設定テーブル（認可URL／トークンURL／スコープ／ユーザー情報URL）を実装。戻り先は `https://eluntra.vercel.app/connectors/callback`、トークン交換は Vercel `/api/oauth/exchange` が client_secret（環境変数 `OAUTH_<SERVICE>_CLIENT_ID/_CLIENT_SECRET`、現時点では未登録）で行う。未登録のサービスは認可画面へ飛ばす前にアプリ内で「アプリ登録が必要」という説明を表示し、「準備中」と明示する
  - Google系：client_id は Supabase ログイン用アプリのものが取得できたが、リダイレクトURIが Supabase コールバック専用のため、コネクタ用には REDIRECT_URI の追加登録とシークレットの環境変数登録が別途必要
  - Trello：認可コード方式ではなく独自方式のため汎用エンジンの対象外と明記
  - トークン貼り付けは主UIから撤去し、実働5種（GitHub／YouTube／Notion／Slack／Discord）の行末に「トークンで接続（上級者向け）」の折りたたみとしてのみ残した。トークン接続済みのサービスは従来どおり「接続中」と表示される

## v6.5（2026-11-08）Supabaseコネクタとブラウザツール

- コネクタに Supabase を追加し17種に。ロゴ（`conn-supabase.svg`）は Simple Icons（現行版）から取得
- Supabase の接続は2方式：ログイン式（Management API OAuth、`OAUTH_SERVICES.supabase`。アプリ登録が済むまで「準備中」）とトークン式（プロジェクトURL＋サービスロールキー＋任意で sbp_、接続情報を JSON で端末内保存・同期対象外）
- エージェントの Supabase ツール（tables/select/insert/update/delete/sql/auth_users）はコネクタ接続時のみ実働し、未接続時は接続を促すメッセージを返す。update/delete はフィルタ必須で全件書き込みを拒否する
- エージェントに「ブラウザ」ツールを追加。実ブラウザではなく Vercel Node Function `/api/browser`（サーバー側の軽量ブラウザ：取得・リンク/フォーム抽出・送信、Cookie はクライアント側 sessionStorage で保持）。制限（JS描画不可・ログイン必須ページ不可）はツール説明と README に明記する

## v6.8（2026-11-08）アカウント同期の拡張（キー引き継ぎ）

- 方針変更（ユーザー明示指示）：v6.7 までは「APIキーは端末外に出さない」が設計原則だったが、「ログインしたらAPIとかデータを引き継げるようにして」という指示を受け、同期対象を拡張した
- 同期範囲：sessions / conf / notes / codes（従来）＋ keys / customs / connectors / connectorAccounts / fetchedModels / modelFlags / favorites / theme（追加）。保存先は従来どおり本人の `eluntra_sync` 行（RLS で自分の行のみ読み書き可能）
- 統合規則：置き換えは禁止。レコード型は項目単位（クラウド優先・ローカルのみの項目は保持）、配列型（customs・sessions・notes）は ID 単位で統合する。旧ペイロード（新フィールドなし）の取り込みでローカルデータが消えることはない
- push 経路：明示呼び出し（送信後・手動同期・エージェント後）に加え、`store.onDataChanged` 購読によるデバウンス自動 push（ログイン中のみ）。push 側は store を更新しないためループしない
- 除外：認証セッション・OAuth pending・最終同期時刻・sessionStorage 内容は同期しない。ログアウトでクラウド側データは消さない（次回ログインで復元されるのが本機能の目的）

## v7.1（2026-11-08）Eluntra Developer のレイアウト

- Developer（`app/src/developer/`、入口 `developer.html`）は v7トークン（`tokens.css`）をそのまま使い、専用CSS（`dev.css`）でレイアウトだけを定義する。本体の app.css は読み込まない（ボタン等の最小限だけ複製）
- デスクトップ（≥1024px）: ヘッダー（戻る/ロゴ/プロジェクト名/モデルピル）＋左288px（プロジェクト・ファイルツリー・GitHub入口）＋中央（タブ＋Monaco＋ツールバー）＋右368px（AI Developer：モード選択・実行ストリーム・変更カード・入力欄）＋下部バーから開くターミナル/プレビュー/問題パネル（288px）
- モバイル（<1024px）: 下部タブ（ファイル/エディタ/AI/プレビュー/ターミナル）で1画面ずつ全画面表示。タップ対象は44px以上を目安にする
- アイコンは線描きSVGのみ（本体 `icons.tsx` と Developer専用の追加分）。絵文字は使わない。GitHubはコネクタ公式ロゴ画像を使う
- 差分は追加=緑系・削除=赤系の背景で行番号（旧/新）つき統一形式。変更カードは影つきカードで、AIパネルの実行ストリーム内に時系列で並べる
- ダークテーマはトークンの `[data-theme="dark"]` をそのまま利用し、Monacoも vs-dark に切り替える
