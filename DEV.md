# 開発・検査

Node.js 22以上を使用します。依存は公式npmレジストリからlockfileどおり導入します。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build:check
```

checkは全ソースの型検査です。testはNode.js test runnerとTypeScript変換、VM上のChrome/storage/tab/clock/Eagle/ntfy/DOM mockを使用します。ダミー入力だけで実ブラウザ、認証情報、実記事、ネットワーク、Eagle、通知サービスへアクセスしません。

build:checkはwebpackだけを実行し、dist/jsのbundleとsource mapを更新します。.envを読み取るbuild-ntfy-config.js、配布pack、整形の一括書き換えは実行しません。従来のnpm run ts / npm run buildはローカル通知設定の生成や配布処理を含むので、検査入口として使用しないでください。

CIは型検査・mockテスト・webpackビルド後、check:distでcommit済みdist/jsとの一致を確認します。Secrets、実記事、通知先を使用しません。ソースを変更したらbuild:checkの出力もcommitします。LF改行を維持してください。

## 検査範囲

スケジューラは閲覧制限保留、24時間後の再試行、手動再確認、普通の失敗時の1時間待ち、成功時の保留削除、価格/有料条件の再適用、設定/走査/処理結果の競合、重複結果を確認します。

管理UIは新規の有料既定オフ、対象の保留件数、未保存時の再確認停止、保存応答までの入力ロック、保存失敗、二重クリック防止、storage更新、listener解除をDOM mockで確認します。実ブラウザのレイアウト・実FANBOX応答・実Eagle登録・実通知配信は未検証です。

## データ保護

.env、cookie、ブラウザ保存データ、実記事、DB、画像・音声は読み取ったりfixtureへコピーしたりしません。dist/ntfy-config.jsonは個人の通知先を含むためGit対象外です。.env.exampleはダミー値だけにします。個人設定を含む配布物をpublicリポジトリへ送らないでください。

本人originのowner/repo/公開範囲を送信前に確認します。upstreamへpushせず、tag/Release・公開範囲・権限・履歴を変更しません。原本dirtyを保全して専用worktreeで作業します。

packageとmanifestの既存5.0.0は維持します。新しい正式版・日付は宣言しません。独自変更履歴は[CHANGELOG-JA.md](CHANGELOG-JA.md)を参照してください。upstreamのchangelog.mdは既存履歴として維持しています。
