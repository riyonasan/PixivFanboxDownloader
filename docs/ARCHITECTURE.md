# 現在の構成

Manifest V3のChrome拡張。TypeScriptをwebpackで`content.js`と`background.js`へまとめ、既存の`dist`静的ファイルと読み込む。FANBOX専用のPython補助サービスに、保存受付と永続Eagle FIFOを実装する。FIFO版は実機へ配置済みで、通常保存とFIFOによる既存Eagle原本照合を確認した。OS自動ログインによる本体再起動後のGUI・専用ブラウザ起動を確認した。認証付き取得の無人再開とログオフ後の常駐は未確認。

| 担当 | 主な実装 |
|---|---|
| FANBOXページのUI・投稿取得 | `src/ts/content.ts`、`API.ts`、`setting/`、`download/` |
| バックグラウンド処理 | `src/ts/background.ts`、`auto/AutoScheduler.ts` |
| 既存Eagle API連携 | `src/ts/eagle/Eagle.ts` |
| 1件保存UI・認証付き転送 | `src/ts/spool/SpoolProof.ts`、`SpoolBackground.ts`、`SpoolClient.ts` |
| 通常ファイル・受付の永続化 | `services/spool_proof/service.py` |
| 専用収集の設定・状態UI | `SpoolRuntime.ts`、`SpoolPanel.ts` |
| FIFO・容量・管理API | `services/spool_proof/runtime.py`、`fifo.py` |
| UNC登録・Eagle原本照合 | `services/spool_proof/eagle_client.py` |

通常取得はブラウザのダウンロード機能を使う。既存Eagle経路はブラウザ側で認証付き取得し、必要な場合はdata URLとして`localhost:41595`へ渡す。1件保存経路は別に、ブラウザから1 MiBずつ`127.0.0.1:18096`へ送る。補助サービスが取得URLやCookieを受け取って再取得する経路はない。

| 状態 | 保存場所・扱い |
|---|---|
| 拡張設定、自動取得状態 | `chrome.storage.local` |
| 通常取得・Eagle履歴 | IndexedDB。ブラウザプロファイルに属する |
| 通知先 | Git外の`.env`から生成する`dist/ntfy-config.json` |
| 保存受付・サイズ・ハッシュ、FIFO・設定反映・通知 | 補助サービスのローカルSQLite |
| 原本・未完了の転送 | 同じローカルデータディレクトリの`objects/` |
| 保存サービスのAPIトークン | 非公開ファイルと専用拡張設定。通常設定exportには含めない |

実証版はPython標準ライブラリの単一HTTPサーバーで、loopbackのファイル受付だけを提供する。FIFO版はloopback受付と指定Tailnet IPの管理APIを同じ受付スレッドで扱い、別スレッド・別SQLite接続で登録処理を行う。Linuxのプロセスロックで同一保存先の二重起動を防ぐ。Bearerトークン・拡張Originと管理側の接続元を確認する。任意パス読取・削除APIはない。確定意図、ファイルの同期、サイズ・ハッシュ照合、SQLite受付を使い、確定途中の停止から復旧する。詳細は [保存実証手順](FANBOX_FILE_PROOF.md) を参照。

自動取得はChrome起動中のalarmsで動く。1件保存実証は手動操作。専用collector設定で明示有効にした環境では、取得済みbytesを補助サービスへ送り、Eagle停止中も保存を続ける。既存の通常取得と直接Eagle登録は従来設定で動く。ミニPCの専用プロファイルでPNG1件の認証付き取得とブラウザ・補助サービス再起動後の保持を実証済み。本人承認のOS自動ログイン後、本体再起動からGUI・専用ブラウザ・保存サービスの自動起動とデータ保持を確認した。認証保管庫がロック状態のため、認証付き取得の無人再開は未確認。実証用の読み取り専用SMB共有からEagleへ1件登録し、Windows上とミニPCの読み取り共有の両方で原本のサイズ・SHA-256一致を確認した。FIFO版の配備と認証付き読取接続は確認済み。通常保存2件のFIFO受付と既存原本照合、メインPCスリープ中の認証付き保存、Eagle停止中の待機と復帰後の照合を確認した。FIFOからの新規item POSTは未確認。送信意図とマーカーをitem POST前に記録し、再起動後は照合だけを行う。設定反映は取得条件だけを許可し、カーソル・保留・実行中記事・履歴を上書きしない。原本削除は未実装。詳細は [FIFO仕様](FANBOX_FIFO.md)。

Nodeの模擬テストはブラウザ転送を、Pythonテストはファイル・SQLite・HTTPと復旧を確認する。webpackはコンパイル確認。これらを実アカウント、実Chromium UI、Eagle、再起動・スリープからの復帰の確認と区別する。
