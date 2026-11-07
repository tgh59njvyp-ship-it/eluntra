# Eluntra デザインシステム（v6.0・作り直し版）

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
