# 技術引き継ぎ

更新日: 2026-10-10 JST。再開ブランチは`feat/minipc-file-proof`。再開の基点は`2cc3292d7875863066f80ebd0ca300c80e338f8b`（この文書を含むコミット番号ではない）。個人用テンプレートを既存構成へ統合済み。pushは依頼されていない。

## 目的・未達条件

CLD-012の順序は認証付き1件保存 → Eagle登録実証 → 永続FIFO → 本移行。最初の実ファイル保存、本人の内容確認、ブラウザ・補助サービス再起動後の保持がまだ未達。後段へ進めない。ミニPCの別作業終了が伝えられ、専用環境への配置は再開済み。

## 現在の根拠

- 1件保存の実装`71e3225`と、同じPC内のトークン初期設定`41b04c1`をローカルコミット済み。各変更は独立したGPT-6.1 Sol/highの最終レビュー済み。
- ローカルで保存テスト14件、ブラウザ模擬テスト24件、既存自動取得テスト13件、webpackビルド成功。Linuxでも保存テスト14件成功。実FANBOXの取得成功は示していない。
- 専用補助サービス`fanbox-proof-storage.service`はloopback `18096`で稼働し、認証付きhealth応答を確認済み。Eagle・原本削除は無効。
- ミニPCはUbuntu 26.04.1、Python 3.14.4。空き容量は配置時約387 GiB。既存ブラウザ・他サービス・共有は変更していない。
- 専用Chrome for Testing 151の起動はsandbox初期化で終了。AppArmorの制限プロファイルへ移ったブラウザの子プロセスが`sys_admin`を拒否されたことをカーネルログで確認。再試行を止め、独立した原因・方針レビュー済み。

## 専用環境と保護対象

実際のSSH接続先・端末固有パスは承認済みローカル接続設定を使う。専用配置は利用者ホーム内の`services/fanbox-file-proof`。その中の`dist/`、`browser-profile/`、`services/spool_proof/data/`と`secrets/`を使う。トークンはミニPC内で生成済みで、チャット・Git・配布ZIPへ出していない。期待するunpacked拡張IDは配置パスから算出済みだが、実際の読込IDは未確認。

ブラウザの専用unitは停止中。補助サービスはtransient user unitであり、本体再起動後の自動起動はまだ設定していない。元の収集環境の切替も行っていない。

導入前からの変更は今回のコミットへ含めない: `Readme-JA.md`、`dist/js/background.js`とmap、`dist/js/content.js`とmap、`src/ts/InitHomePage.ts`、`src/ts/auto/AutoScheduler.ts`、`src/ts/auto/AutoTypes.ts`、未追跡`tests/auto-scheduler.cjs`。これらの9ファイルは導入前後のハッシュを照合して保護する。

## 次の操作

1. [DEV_WORKFLOW](../DEV_WORKFLOW.md) に従い、ブランチと未コミット変更を確認する。テンプレート統合のコミットはGit履歴で確認する。
2. OS変更は利用者が承認済み。既存Chrome for Testing一式のroot所有・一般user書込不可の専用コピー`/opt/fanbox-chromium-proof`と、実行ファイル1パスだけの`userns`許可profile `/etc/apparmor.d/fanbox-chromium-proof`を適用する。全体のsysctl解除や`--no-sandbox`は使わない。例外はChromiumのsandboxを利用可能にするもので、新しい全面的なAppArmor隔離ではない。専用コピーの更新は別途必要。
3. 配置先衝突なし、source 303ファイル約407 MB、symlinkなし、十分な空き容量を確認済み。ただし`sudo -n`は対話認証が必要なため、OS変更はまだ適用していない。専用配置内の`apply-fanbox-sandbox.py`をミニPCの通常ユーザーが下記で一度実行する。パスワードはOSのsudoプロンプトだけへ入力し、チャットへ送らない。スクリプトは既存対象を上書きせず、コピーの全ファイルのハッシュ・root所有・書込権を確認し、当該profileだけ読み込む。成功表示は`FANBOX_SANDBOX_READY`。
   ```bash
   sudo /usr/bin/python3 "$HOME/services/fanbox-file-proof/apply-fanbox-sandbox.py"
   ```
   成功後はエージェントが配置とprofileを読み戻し、専用ブラウザを自動再起動なしで1回起動する。既存のサービスやブラウザは操作しない。
4. 本人が専用ウィンドウを確認してFANBOXへログインし、閲覧できる有料投稿の小さな添付を選ぶ。保存・サイズ・SHA-256・内容・再起動保持を確認する。Cookieは転送しない。

コマンドと通常の作業手順は [DEV_WORKFLOW](../DEV_WORKFLOW.md)、保存操作は [FANBOX_FILE_PROOF.md](FANBOX_FILE_PROOF.md)。今回の具体的なOS変更承認を、他の権限・共有・セキュリティ設定変更へ広げない。

## Notionと同期

Notion対応先は利用者指定のCLD-012、または承認済みローカル対応表から確認する。CLD-012の利用可否・sandbox対応の制約・実機未確認の説明を反映し、読み戻し確認済み。タスクのプロパティは変更していない。技術的な再開詳細・テストログはこの文書とGitへ集約する。

本ブランチは未push。ローカル変更の消失や別PCでの二重作業を避けるため、同期が承認されるまでは元PCで継続する。秘密ファイル・原本・プロファイルはGitで移動しない。
