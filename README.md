# youtube-wine-tool

YouTube のブラインドテイスティング動画から、出題ワインの情報（ワイン名 / 生産者 / 品種 / 国 / 産地 / ヴィンテージ）を自動で抽出して表にする Web ツール。ブラウザ内 (localStorage) に一覧を蓄積し、CSV／TSV でエクスポート可能。

- 本番URL: (デプロイ後に追記)
- リポジトリ: mkttkhsh/youtube-wine-tool (public)
- ホスティング: Cloudflare Workers（Worker が UI・字幕取得・Gemini呼び出しを一体で担う）

## しくみ

1. UI で YouTube URL を入力 → `POST /api/extract`
2. Worker が `watch` ページを取得し `ytInitialPlayerResponse` から `captionTracks` を抽出
3. 日本語字幕（優先）→ 日本語自動字幕 → 英語 → 最初の1本 の順にフォールバックしてXML字幕を取得
4. タイトル・概要欄・字幕テキストを Gemini（既定 `gemini-3.6-flash`）に渡し、JSON スキーマで構造化されたワイン配列を返す
5. UI 側では編集可能なテーブルを表示。行の追加・削除・編集ができ、「一覧に保存」で localStorage に蓄積

## 開発

```
npm install
npx wrangler login          # 初回のみ
npx wrangler secret put GEMINI_API_KEY   # Gemini API キーを登録
npm run dev                 # http://localhost:8787
npm run deploy              # 本番デプロイ
```

## 制約

- 字幕が完全に無効な動画は概要欄のみで抽出（精度は低下）
- Gemini フリー枠を消費するため、公開エンドポイントは必要に応じてパスフレーズ保護を追加してください
- 保存先は現状ブラウザ内 localStorage のみ。将来的に Firestore 同期を追加予定
