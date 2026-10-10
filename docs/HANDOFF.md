# 技術引き継ぎ

更新日: 2026-10-10 JST。再開ブランチは`feat/minipc-file-proof`。再開の基点は`30f75e0`（この文書を含むコミット番号ではない）。個人用テンプレート統合済み。pushは依頼されていない。

## 目的・受入状況

CLD-012の順序は認証付き1件保存 → Eagle登録実証 → 永続FIFO → 本移行。**最初の保存実証は成立した。** 次は削除を無効にしたUNC経由のEagle登録1件と、Eagle原本のサイズ・SHA-256照合。FIFO、本移行、自動削除は未着手。

## 確認済みの根拠

- Linuxの専用Chromiumで本人がFANBOXへログインし、閲覧可能な有料投稿のPNG1件を保存した。通常ファイル、SQLite、UI、確認用に読み戻したコピーのサイズ・SHA-256が一致。本人が内容の一致と正常表示を確認した。
- エージェントが専用ブラウザと補助サービスを再起動した。本人がログイン保持と同じファイルの再受付で同一受付ID・サイズ・SHA-256が返ることを確認。再受付後も原本は1件で、ローカルの原本ハッシュは一致した。
- 補助サービスの認証付きhealth、実際に読み込まれた拡張ID、専用プロファイル、AppArmorの実プロセスラベルを確認。Cookieは転送せず、Eagle登録・原本削除は実行していない。
- ローカル保存テスト14件、ブラウザ模擬テスト24件、既存自動取得テスト13件、webpack成功。Linux保存テスト14件成功。これらと上記の実機確認は区別する。

## 専用環境と制約

SSH接続先・端末固有パスは承認済みローカル接続設定を使う。利用者ホーム内の`services/fanbox-file-proof`が専用配置で、`dist/`、`browser-profile/`、`services/spool_proof/data/`と`secrets/`を使う。秘密値、取得ファイル名・ID・画像・ハッシュなどの私的な実証データは公開Gitへ入れない。

Ubuntu 26.04.1、Python 3.14.4、Chrome for Testing 151。配置時の空きは約387 GiB。`/opt/fanbox-chromium-proof`と`/etc/apparmor.d/fanbox-chromium-proof`は本人承認後に適用済み。全303ファイルのコピー一致・root所有・一般user書込不可・symlinkなし、完全一致パスのprofile内容を読み戻した。Chromium実プロセスにprofileが適用され、OS全体のuser namespace制限は有効のまま。専用ブラウザ一式の更新は別途必要。

`fanbox-proof-storage.service`はloopback `18096`、`fanbox-proof-browser.service`は専用プロファイルで稼働中。どちらもtransient user unit。本体再起動後の自動起動、遠隔セッション終了時の常駐、大容量ファイル、認証切れ・容量復旧、メインPCスリープ中の取得は未実証。遠隔ログインの画面セッション切替でブラウザが終了したため、その時点の遠隔セッションで起動し直した。今回の保存実証を常時収集の成立とは扱わない。

既存の他サービス・ブラウザ・共有は変更していない。元の収集環境の切替は行っていない。

## 既存変更の保護

今回へ含めない変更: `Readme-JA.md`、`dist/js/background.js`とmap、`dist/js/content.js`とmap、`src/ts/InitHomePage.ts`、`src/ts/auto/AutoScheduler.ts`、`src/ts/auto/AutoTypes.ts`、未追跡`tests/auto-scheduler.cjs`。9ファイルは導入前後のハッシュを照合して保護している。

## 次の操作

1. [DEV_WORKFLOW](../DEV_WORKFLOW.md) に従い、ブランチと未コミット変更を確認する。
2. 既存のSMB共有とEagle接続環境を読み取り確認し、保存原本をUNCで読める方法と、既存の`FANBOX/...`命名・重複判定を確認する。追加の共有・権限変更が必要なら具体案を提示する。
3. 削除無効で`addFromPath`を1件実証し、Eagle内原本のサイズ・SHA-256まで照合する。未照合・成否不明時は原本を保持し、盲目的な再POSTをしない。
4. この実証が成立してから永続FIFOへ進む。現在の専用保存APIへ任意パス読取・削除APIを追加しない。

## Notionと同期

Notion対応先は利用者指定のCLD-012、または承認済みローカル対応表から確認する。利用可否と制約だけを区切りで反映し、タスクのプロパティは変更しない。技術的な再開詳細・検証記録はこの文書とGitへ集約する。本ブランチは未push。原本・プロファイル・秘密ファイルはGitで移動しない。
