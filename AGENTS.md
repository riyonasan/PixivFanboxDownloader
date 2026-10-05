# 作業指針

- 原本dirtyをhash/patchで保全し、専用worktreeを使う。stash/reset/clean/削除で他の作業を消さない。同時編集を検出したら停止して報告する。
- 安全な入口はnpm run check、npm test、npm run build:check。配布や通知設定の生成を含むnpm run ts / npm run buildは検査で使わない。
- テストはダミー入力とChrome/DOM/外部サービスmockで行う。実記事取得、ブラウザauth、通知、Eagle、本番処理を検査で動かさない。
- .env、cookie、実記事、DB、画像・音声、秘密値を読まず、fixtureや報告へコピーしない。例設定はダミー値だけにする。
- dist/jsとmapは対応するソースからbuild:checkで生成する。個人通知設定dist/ntfy-config.jsonは送信しない。
- 本人originの正確なowner/repo/visibilityと送信対象を確認する。upstreamへpushしない。tag/Release、履歴rewrite、権限/公開範囲変更は行わない。
- 既存5.0.0を維持し、リリース日を推測しない。独自変更は日本語Keep a Changelog 1.1形式のCHANGELOG-JA.mdの未リリースへ記録する。
