# 現在の構成

Manifest V3のChrome拡張。TypeScriptをwebpackで`content.js`と`background.js`へまとめ、既存の`dist`静的ファイルと読み込む。サービスの追加は1件保存実証のPython補助サービスだけで、テンプレート導入による実行構成変更はない。

| 担当 | 主な実装 |
|---|---|
| FANBOXページのUI・投稿取得 | `src/ts/content.ts`、`API.ts`、`setting/`、`download/` |
| バックグラウンド処理 | `src/ts/background.ts`、`auto/AutoScheduler.ts` |
| 既存Eagle API連携 | `src/ts/eagle/Eagle.ts` |
| 1件保存UI・認証付き転送 | `src/ts/spool/SpoolProof.ts`、`SpoolBackground.ts`、`SpoolClient.ts` |
| 通常ファイル・受付の永続化 | `services/spool_proof/service.py` |

通常取得はブラウザのダウンロード機能を使う。既存Eagle経路はブラウザ側で認証付き取得し、必要な場合はdata URLとして`localhost:41595`へ渡す。1件保存経路は別に、ブラウザから1 MiBずつ`127.0.0.1:18096`へ送る。補助サービスが取得URLやCookieを受け取って再取得する経路はない。

| 状態 | 保存場所・扱い |
|---|---|
| 拡張設定、自動取得状態 | `chrome.storage.local` |
| 通常取得・Eagle履歴 | IndexedDB。ブラウザプロファイルに属する |
| 通知先 | Git外の`.env`から生成する`dist/ntfy-config.json` |
| 保存受付・サイズ・ハッシュ | 補助サービスのローカルSQLite |
| 原本・未完了の転送 | 同じローカルデータディレクトリの`objects/` |
| 保存サービスのAPIトークン | 非公開ファイルと専用拡張設定。通常設定exportには含めない |

補助サービスはPython標準ライブラリの単一HTTPサーバーで、loopbackのファイル受付だけを提供する。Bearerトークンと拡張Originを確認する。任意パス読取・削除APIはない。確定意図、ファイルの同期、サイズ・ハッシュ照合、SQLite受付を使い、確定途中の停止から復旧する。詳細は [保存実証手順](FANBOX_FILE_PROOF.md) を参照。

自動取得はChrome起動中のalarmsで動く。1件保存実証は手動操作であり、その自動取得へまだ接続していない。ミニPCの専用プロファイルでPNG1件の認証付き取得とブラウザ・補助サービス再起動後の保持を実証済み。OS起動後の常駐・常時収集は未実証。Eagle FIFO、SMB連携、原本削除は未実装。

Nodeの模擬テストはブラウザ転送を、Pythonテストはファイル・SQLite・HTTPと復旧を確認する。webpackはコンパイル確認。これらを実アカウント、実Chromium UI、Eagle、再起動・スリープからの復帰の確認と区別する。
