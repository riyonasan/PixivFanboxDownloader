# 開発と引き継ぎ

個人用テンプレートの不足部分だけを既存構成へ統合した。参照元は [codex-personal-project-template](https://github.com/riyonasan/codex-personal-project-template/tree/ca520f236c1e7bf314f394075f149047f8be059a)。共有Codex設定は別管理とし、この導入では変更しない。

## 開始時

共有`AGENTS.md`と上書き設定を確認し、プロジェクトの [AGENTS.md](AGENTS.md) と [HANDOFF](docs/HANDOFF.md) を読む。

```text
git status --short --branch
git branch --show-current
git remote -v
git fetch origin
git branch -vv
```

remoteに認証情報が含まれる場合は表示せず、ホストとリポジトリだけ確認する。`origin`は`riyonasan/PixivFanboxDownloader`、`upstream`は本家。既定ブランチは`master`。現在の継続作業はHANDOFFのブランチを使う。既存の未コミット変更を削除・stash・別作業へ取り込まない。

別PCへ移る場合は、未完了の作業を作業ブランチでローカルコミットし、明示承認されたときだけpushする。承認済みpush後は両PCのコミット一致を確認する。未pushの間は元PCで継続する。`pull --ff-only`やブランチ切替は、作業ツリーと対象ブランチが安全な場合にだけ行う。

## 実在するコマンド

TypeScript、webpack、Node.jsを利用する。新cloneでは`npm install`で依存を導入する。lockfileは現行運用でGit除外されており、有効なローカル`package-lock.json`がある環境では`npm ci`も使える。テンプレート導入だけを理由に追跡方針は変えない。実証サービスはPython 3.11以上の標準ライブラリのみで動く。既存`.env.example`は通知用`NTFY_URL`の例であり、新しい環境変数は追加しない。

```text
node --test tests/spool-proof.cjs tests/spool-runtime.cjs
python -B -m unittest discover -s services/spool_proof -p "test_*.py" -v
```

`tests/auto-scheduler.cjs`は別作業の未追跡ファイルで、cloneしただけで利用可能とは扱わない。既存13件は新しいSpoolRuntime依存だけを通常動作用のstubに置き換えた外部fixtureで検証した。元ファイルは保護しており、直接実行するにはその依存fixtureの追加が必要。新しい追跡対象のテストは上記コマンドだけで動く。Linuxを補助サービスの実行対象とし、HTTPを含むPython試験もLinuxで確認する。

既存の`dist/js`を保護するビルド例（PowerShell）:

```powershell
node node_modules/webpack-cli/bin/cli.js --config webpack.conf.js --output-path "$env:TEMP/fanbox-proof-build/js"
```

このビルドはJSの検証用で、静的ファイルのコピーや通知設定の生成は行わない。通常の`npm run ts`は通知設定と`dist/js`を生成する。`npm run build`はさらにLESS・全体整形・ZIP作成も行う。目的と差分を確認して使い分ける。

## 終了時

必要な検証と共有規則に従う独立レビューを終え、今回のファイルだけを明示してステージする。

```text
git diff
git status --short
git add -- FILE1 FILE2 docs/HANDOFF.md
git diff --cached
git commit -m "describe the coherent change"
git status --short --branch
```

HANDOFFには未達の受入条件、最新の根拠、次の操作を残す。実装履歴はGit、利用方法・現在の制約・合意事項は承認範囲内のNotion本文に置く。タスク状態を自動更新しない。push、配備、OS設定変更はそれぞれの承認範囲を確認する。

`.env`、通知設定、APIトークン、SQLite、原本、ブラウザ状態はGitで移動しない。必要なら承認済みの非公開バックアップを別に作る。`.gitignore`追加だけでは追跡済みファイルや過去の履歴から秘密情報は消えない。
