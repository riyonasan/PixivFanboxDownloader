[Discord](https://discord.gg/u4wVMy7xJM)

# 概要

これは、Pixiv Fanbox上のファイルを一括ダウンロードするためのChromeブラウザ拡張機能です。

ファイルタイプのフィルタリング、ファイル名のカスタマイズ、複数の言語に対応しています。

**注意：** このプログラムはFanbox上の有料コンテンツを直接解除することはできません。有料コンテンツをダウンロードするには、まず購入する必要があります。

![screenshot](screenshot/ui-4.png)

# インストール

ChromeまたはEdgeブラウザの使用をお勧めします。

## オンラインインストール

Chrome Webストアからこの拡張機能をインストールできます：

[Pixiv Fanbox Downloader](https://chrome.google.com/webstore/detail/pixiv-fanbox-downloader/ihnfpdchjnmlehnoeffgcbakfmdjcckn)

## オフラインインストール

Pixivダウンローダーのオフラインインストールチュートリアルを参照してください：
[オフラインインストール](https://xuejianxianzun.github.io/PBDWiki/#/en/OfflineInstallation)

1点だけ異なる点があります：上記のチュートリアルではPixivダウンローダーのzipファイルをダウンロードするよう指示されていますが、代わりにFanboxダウンローダーのzipファイルをダウンロードしてください。このリポジトリの[releasesページ](https://github.com/xuejianxianzun/PixivFanboxDownloader/releases)からpixivfanboxDownloader.zipをダウンロードできます。

## Androidでの使用

以下のチュートリアルを参照してください：
[Microsoft Edge Canaryブラウザへのインストール](https://xuejianxianzun.github.io/PBDWiki/#/en/MicrosoftEdgeCanary)

1点だけ異なる点があります：上記のチュートリアルではPixivダウンローダーのcrxファイルをダウンロードするよう指示されていますが、代わりにFanboxダウンローダーのcrxファイルをダウンロードしてください。このリポジトリの[releasesページ](https://github.com/xuejianxianzun/PixivFanboxDownloader/releases)からPixiv-Fanbox-Downloader.crxをダウンロードできます。

# 使用方法

## このフォークのEagle連携

Eagleを起動して登録先のライブラリを開き、設定画面の「ファイルタイプ」の上にある「Eagleに登録」にチェックを入れると、通常ダウンロードの代わりにEagleへ送信します。チェックを外すと通常ダウンロードに戻ります。

- 対象のファイルタイプと命名設定は既存の設定を使用します。Eagleの `FANBOX` 配下に命名設定の階層を作り、既存の同名フォルダを再利用します。
- アイテムのURLには元のFANBOX記事URLを設定します。タグ・メモは追加せず、重複チェックや独自の上書き処理も行いません。
- FANBOX上のファイルは、拡張機能がブラウザのログイン状態を使って取得し、データをローカルEagleへ送信します。通常のダウンロードフォルダには保存せず、認証CookieをEagleに渡す必要もありません。ファイルを一時的にメモリに展開するため、大容量ファイルを扱うときは同時処理数を抑えてください。
- Eagleへの送信受付と取り込み完了は異なります。取り込み結果はEagleで確認してください。
- HTML本文内の画像・添付リンクは元のURLを参照するため、閲覧にはネット接続やFANBOXへのアクセス権が必要です。

この機能はローカルのEagle API（`http://localhost:41595`）を使用します。Chrome Webストア版には含まれないため、このフォークの `dist` フォルダを「パッケージ化されていない拡張機能」として読み込んでください。

## 通常ダウンロード

- この拡張機能をインストールした後、fanboxページを更新すると、ページの右側に青いダウンロードボタンが表示されます。このボタンをクリックして使用を開始してください。
- ダウンロードしたファイルはブラウザのダウンロードディレクトリに保存されます。別の場所に保存したい場合は、ブラウザのダウンロードディレクトリを変更する必要があります。
- ダウンロード時に「各ファイルの保存場所を尋ねる」ブラウザ設定をオフにしてください。そうしないと、保存先を尋ねるダイアログが表示されます。
- ダウンロードしたファイル名に異常がある場合、ダウンロード機能を持つ他のブラウザ拡張機能を無効にしてください。

# サポートとスポンサー

このツールが役に立ったと感じた場合、サポートやスポンサーをしていただければ幸いです (*╹▽╹*)

Patreon:

<a href='https://www.patreon.com/xuejianxianzun'><img src='https://c5.patreon.com/external/logo/become_a_patron_button.png' alt='Become a patron' width='140px' /></a>
