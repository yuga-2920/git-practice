# エージェント連携の運用

Issue に `agent:ready` ラベルを付けると、Mac またはクラウドのエージェントが実装し、ドラフト PR を作ります。マージは人が行います。

## 処理の流れ

1. `agent-router.yml` が、Issue の作成者とラベルを付けた人が `yuga-2920` であることを確かめます。
2. 変数 `MAC_HEARTBEAT_AT` が5分以内なら `run:mac` を付け、古ければ `run:cloud` を付けて `agent-cloud.yml` を起動します。
3. `run:mac` のまま5分たつと、ルーターがクラウドへ切り替えます。
4. Mac では Codex が計画し、Claude Code が実装します。クラウドでは Claude Code が計画と実装を担当します。
5. 実行側が `agent/issue-<番号>` ブランチを push し、ドラフト PR を作ります。

Mac が1件を処理しているあいだはハートビートを更新しないため、5分を超えて届いた Issue はクラウドで処理します。

## ラベル

| ラベル | 意味 |
|---|---|
| `agent:ready` | 実行を依頼する |
| `run:mac` | Mac の着手を待っている |
| `run:cloud` | クラウドの着手を待っている |
| `status:running` | エージェントが実行している |
| `needs-human` | 自動実行を止め、人の判断を待っている |

## 安全のための制限

- Claude Code が使えるツールは、ファイルの読み取り、検索、編集だけです。シェルとネットワークのツールは渡しません。
- Claude Code には、認証情報やプロセスの環境変数が置かれる場所の読み取りを禁止します。
- Mac の Codex は読み取り専用のサンドボックスで計画だけを作ります。
- 計画と変更に認証情報らしい文字列が含まれる場合は、公開せずに `needs-human` で止めます。この検査は、暗号化や独自の符号化をした文字列までは検出できません。
- リモートブランチの作成に成功した実行側だけが着手するため、同じ Issue を二重に実装しません。
- commit、push、PR の作成は、エージェントの終了後にプログラムが行います。
- `.github/`、`agent/`、`.claude/`、`.codex/` と主要な設定ファイルが変更された場合は、push せずに `needs-human` で止めます。
- 自動マージと自動デプロイは行いません。

## Mac の常駐プログラムの導入

`main` にこの仕組みをマージしたあとで、次のコマンドを実行します。

```bash
cd ~/Projects/git-practice && git switch main && git pull --ff-only
```

```bash
sed -e "s#__NODE__#$(node -p process.execPath)#" -e "s#__HOME__#$HOME#g" -e "s#__PATH__#$PATH#" agent/launchd/com.yuga.git-practice-agent.plist > ~/Library/LaunchAgents/com.yuga.git-practice-agent.plist
```

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.yuga.git-practice-agent.plist
```

停止するときは次のコマンドを実行します。

```bash
launchctl bootout "gui/$(id -u)/com.yuga.git-practice-agent"
```

ログは `~/Library/Logs/git-practice-agent.log` に出力します。

## 止まったときの対応

`needs-human` が付いた Issue は自動で再実行しません。Issue のコメントと実行ログを確かめてください。再実行するときは、`agent/issue-<番号>` ブランチが残っていれば削除し、`needs-human` と `agent:ready` を外してから `agent:ready` を付け直します。

Mac が実行中に停止した場合は、次に Mac が起動したときに `needs-human` を付けます。クラウド実行が失敗、中断した場合は、同じワークフローの `recover` ジョブが `needs-human` を付けます。

`CLAUDE_CODE_OAUTH_TOKEN` の有効期限は1年です。期限が切れる前に `claude setup-token` で作り直し、Secret を更新してください。
