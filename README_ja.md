<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  エージェントを専用コンテナで安全に実行するAIアシスタント。軽量で、理解しやすく、あなたのニーズに完全にカスタマイズできるように設計されています。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">ドキュメント</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ko.md">한국어</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## このフォークについて

これは [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) のフォークです。アップストリームの `main` を追跡しながら、次の機能を追加しています。

- **トピックエージェント** — エージェントが自分のいるチャットの隣に新しいトピックを開き、そこへ*新しい*エージェントを配置できます。`spawn_topic_agent` の呼び出し1回で、トピック、エージェントグループ、配線、そして同じ人たちがそのエージェントと話すためのアクセス権まで、すべてホスト側で作成されます。Telegramのフォーラム型スーパーグループ向けに書かれていますが、必要なプラットフォーム機能は `adapter.createThread` だけです。[docs/topic-spawn.md](docs/topic-spawn.md) を参照。
- **ライブ進捗** — 数秒たっても終わらないターンでは、ホストが使い捨てのメッセージを1通投稿し、エージェントの現在の推論行、直近のツール呼び出し、経過時間を表示します。ターンの進行に合わせて編集し、本当の返信が届いた時点で削除します。これが不可欠な経路になることはありません。どの失敗経路も、配信失敗ではなく「進捗メッセージなし」に縮退します。[ライブ進捗](docs/architecture.md#live-progress) を参照。
- **Telegram同梱** — アダプターがこのツリーに含まれているため `/add-telegram` は不要です。さらにフォーラムトピックのルーティング、ボットへの返信による起動、入力中表示の修正を上乗せしています。

**アップストリームへの追随。** このフォークは [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) を置き換えるものではなく、その上に足しているだけです。upstreamリモートを一度追加すれば、いつでも更新を取り込めます。

```bash
git remote add upstream https://github.com/nanocoai/nanoclaw.git
```

あとはClaude Codeで`/update-nanoclaw`を実行すれば、変更点をプレビューしてマージできます。`/add-<channel>`と`/add-<provider>`スキルはアップストリームの`channels`／`providers`ブランチから直接アダプターを取得するため、常に最新です。このフォークは意図的にそれらをミラーしていません。ミラーすると、コピーした日の内容で凍結されてしまうからです。

Telegramを使う場合の注意点が1つあります。`src/channels/telegram.ts`はアップストリームの`channels`ブランチが所有しているため、`/add-telegram`の再適用や`/update-skills`の実行で上書きされ、このフォークのフォーラム機能を支える配線が黙って失われます。そのときは`src/channels/telegram-forum-wiring.test.ts`が赤くなります。どちらのコマンドの後にも実行してください。

以降はアップストリームのREADMEで、cloneのURLだけをこのフォークに向けてあります。

## NanoClawを作った理由

[OpenClaw](https://github.com/openclaw/openclaw)は素晴らしいプロジェクトですが、自分が理解しきれない複雑なソフトウェアに生活へのフルアクセスを与えたまま安心して眠れるとは思えませんでした。OpenClawは約50万行のコード、53の設定ファイル、70以上の依存関係を持っています。セキュリティはアプリケーションレベル（許可リスト、ペアリングコード）であり、真のOSレベルの分離ではありません。すべてが共有メモリを持つ1つのNodeプロセスで動作します。

NanoClawは同じコア機能を提供しますが、理解できる規模のコードベースで実現しています。1つのプロセスと少数のファイル。エージェントは単なるパーミッションチェックの背後ではなく、ファイルシステム分離された独自のLinuxコンテナで実行されます。

## クイックスタート

```bash
git clone https://github.com/weijie-ng/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh`は、まっさらなマシンから、メッセージを送れる名前付きエージェントが動く状態までを一気通貫で案内します。NodeやpnpmやDockerが無ければインストールし、AnthropicクレデンシャルをOneCLIに登録し、エージェントコンテナをビルドし、最初のチャネル（iMessage、Telegram、Discord、WhatsApp、またはローカルCLI）とペアリングします。途中でステップが失敗すれば自動的にClaude Codeが呼び出され、原因を診断して中断箇所から再開します。

<details>
<summary><strong>NanoClaw v1からの移行ですか？</strong></summary>

v1インストールの隣に新しいv2チェックアウトを作り、その中で実行します。

```bash
git clone https://github.com/weijie-ng/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash migrate-v2.sh
```

`migrate-v2.sh`はv1インストール（兄弟ディレクトリ、または`NANOCLAW_V1_PATH=/path/to/nanoclaw`）を見つけ、状態をv2チェックアウトへ移行し、その後Claude Codeへ`exec`して、判断が必要な部分（オーナーの登録、共有メモリの移行、フォークのカスタマイズ再適用）を仕上げます。

このスクリプトはClaudeセッションの中からではなく、直接実行してください。決定的な処理の側では、Node/pnpmのブートストラップ、Docker、OneCLI、コンテナビルドのために対話的なプロンプトと実際のシェルI/Oが必要です。

**やること：** `.env`のマージ、`registered_groups`からのv2 DBシード、グループフォルダー＋セッションデータ＋スケジュールタスクのコピー、選択したチャネルアダプターのインストール、チャネル認証状態のコピー（WhatsAppのBaileysキーストアを含む。LIDマッピングは移行されず、Baileys v7アダプターがメッセージごとに解決します）、エージェントコンテナのビルド。

**やらないこと：** システムサービスの切り替え。プロンプトで*"switch to v2"*を選ぶか、テスト後に手動で切り替えてください。v1インストールはそのまま残ります。

変更点は[docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md)、開発ノートは[docs/migration-dev.md](docs/migration-dev.md)を参照してください。

</details>

## 設計思想

**理解できる規模。** 1つのプロセス、少数のソースファイル、マイクロサービスなし。NanoClawのコードベース全体を把握したいなら、Claude Codeに説明を求めれば十分です。

**分離によるセキュリティ。** エージェントはLinuxコンテナで実行され、明示的にマウントされたものだけが見えます。コマンドはホストではなくコンテナ内で実行されるため、Bashアクセスも安全です。

**個人ユーザー向け。** NanoClawはモノリシックなフレームワークではなく、各ユーザーのニーズに正確にフィットするソフトウェアです。肥大化するのではなく、オーダーメイドであるよう設計されています。自分のフォークを作り、Claude Codeにニーズに合わせて変更させます。

**カスタマイズ＝コード変更。** 設定の肥大化はありません。動作を変えたいならコードを変える。コードベースは変更しても安全な規模です。

**AIネイティブ、設計としてハイブリッド。** インストールとオンボーディングは最適化されたスクリプトのパスで、速く決定的です。判断が必要なところ（インストール失敗、対話的な決定、カスタマイズ）では、制御はシームレスにClaude Codeへ渡されます。セットアップ以降も、監視ダッシュボードやデバッグUIは用意しません。問題をチャットで説明すれば、Claude Codeが処理します。

**機能ではなくスキル。** トランクにはレジストリとインフラのみを同梱し、個別のチャネルアダプターや代替プロバイダーは含めません。チャネル（Discord、Slack、Telegram、WhatsAppなど）は長期運用される`channels`ブランチに、代替プロバイダー（OpenCode、Ollama）は`providers`ブランチに置かれます。`/add-telegram`や`/add-opencode`などを実行すると、スキルが必要なモジュールだけを正確にフォークへコピーします。要求していない機能は一切入りません。

**最高のハーネス、最高のモデル。** NanoClawはAnthropic公式のClaude Agent SDK経由でネイティブにClaude Codeを使用します。最新のClaudeモデルとClaude Codeの全ツールセット（自分のNanoClawフォークを変更・拡張する能力を含む）が手に入ります。他プロバイダーはドロップイン・オプションです。OpenAIのCodex（ChatGPTサブスクリプションまたはAPIキー）向けには`/add-codex`、OpenCode経由のOpenRouter、Google、DeepSeekなどには`/add-opencode`、ローカルのオープンウェイトモデルには`/add-ollama-provider`。プロバイダーはエージェントグループごとに設定可能です。

## サポート機能

- **マルチチャネルメッセージング** — WhatsApp、Telegram、Discord、Slack、Microsoft Teams、iMessage、Matrix、Google Chat、Webex、Linear、GitHub、WeChat、Resend経由のメール。`/add-<channel>`スキルでオンデマンドにインストール。1つでも複数でも同時に実行可能。
- **柔軟な分離モデル** — チャネルごとに専用エージェントを割り当てて完全プライバシーを確保することも、複数チャネルで1つのエージェントを共有して会話は分離しつつメモリを統一することも、複数チャネルを1つの共有セッションにまとめて会話を横断させることもできます。`/manage-channels`でチャネル単位に選択。[docs/isolation-model.md](docs/isolation-model.md)参照。
- **エージェントごとのワークスペース** — 各エージェントグループは独自の`CLAUDE.md`、独自のメモリ、独自のコンテナ、そしてあなたが許可したマウントのみを持ちます。明示的に配線しない限り、境界を越えるものはありません。
- **スケジュールタスク** — エージェントが実行する定期ジョブ。仕事が無いときに起こさずに済むよう、任意で[スクリプトゲート](docs/scheduled-tasks.md)を設定できます。
- **Webアクセス** — Webからの検索とコンテンツ取得。
- **コンテナ分離** — エージェントはDockerコンテナでサンドボックス化されます（macOS/Linux/WSL2）。
- **クレデンシャルのセキュリティ** — エージェントは生のAPIキーを保持しません。アウトバウンドリクエストは[OneCLI Agent Vault](https://github.com/onecli/onecli)を経由し、リクエスト時に認証情報を注入して、エージェントごとのポリシーとレート制限を適用します。
- **エージェントテンプレート** — `ncl groups create --template <ref>`で、再利用可能なバンドルからすぐ動くエージェント（指示＋MCPツール＋スキル、シークレットは含まない）を作成します。テンプレートはローカルの`templates/`フォルダーから読み込まれます。手で追加しても、[公開ライブラリ](https://github.com/nanocoai/nanoclaw-templates)からコピーしても構いません。[docs/templates.md](docs/templates.md)参照。

## アカウントと、マシンの外に出るもの

NanoClawにユーザーアカウントはありません。送信されるのは匿名のセットアップ診断だけで、
`NANOCLAW_NO_DIAGNOSTICS=1`で無効化できます。あなたのエージェント、メッセージ、ファイル、
キーがマシンの外に出ることはありません。

オプトインの例外が1つあります。エージェントイメージをローカルでビルドする代わりに、
[ビルド済みイメージを取得](docs/hardened-image.md)できます。私たちのイメージを取得するには
無料アカウントが必要なため、あなたのメールアドレスと、イメージを要求した時刻は私たちに見えます。
エージェントについては何も見えませんし、イメージが届いた後も何も見えません。
ローカルビルドはアカウント不要で、どこにも接続せず、こちらがデフォルトです。

## 使い方

トリガーワード（デフォルト：`@Andy`）でアシスタントに話しかけます：

```
@Andy 毎朝9時に営業パイプラインの概要を送って（Obsidian vaultフォルダにアクセス可能）
@Andy 毎週金曜に過去1週間のgit履歴をレビューして、差異があればREADMEを更新して
@Andy 毎週月曜の朝8時に、Hacker NewsとTechCrunchからAI関連のニュースをまとめてブリーフィングを送って
```

所有または管理しているチャネルからは、グループやタスクを管理できます：
```
@Andy 全グループのスケジュールタスクを一覧表示して
@Andy 月曜のブリーフィングタスクを一時停止して
@Andy Family Chatグループに参加して
```

## カスタマイズ

NanoClawは設定ファイルを使いません。変更したいときは、Claude Codeにやりたいことを伝えるだけです：

- 「トリガーワードを@Bobに変更して」
- 「今後はレスポンスをもっと短く直接的にして」
- 「おはようと言ったらカスタム挨拶を追加して」
- 「会話の要約を毎週保存して」

または`/customize`を実行すればガイド付きで変更できます。

コードベースは十分に小さいため、Claudeが安全に変更できます。

## コントリビューション

**機能を追加するのではなく、スキルを追加してください。**

新しいチャネルやエージェントプロバイダーを追加したい場合、トランクには追加しないでください。新しいチャネルアダプターは`channels`ブランチに、新しいエージェントプロバイダーは`providers`ブランチに追加します。ユーザーはそれぞれのフォークで`/add-<name>`スキルを実行し、スキルが必要なモジュールを標準パスへコピーし、登録を配線し、依存関係をピン留めします。

こうすることでトランクは純粋なレジストリ／インフラのまま保たれ、どのフォークもスリムなままです。ユーザーは求めたチャネルとプロバイダーだけを受け取り、それ以外は入りません。

### RFS（スキル募集）

現在、募集中のチャネル／プロバイダースキルはありません。提案はissueでお願いします。

## 必要条件

- macOSまたはLinux（WindowsはWSL2経由）
- Node.js 20以上とpnpm 10以上（インストーラーが未インストールなら両方をインストールします）
- [Docker Desktop](https://docker.com/products/docker-desktop)（macOS/Windows）または Docker Engine（Linux）
- [Claude Code](https://claude.ai/download)（`/customize`、`/debug`、セットアップ時のエラー復旧、全ての`/add-<channel>`スキルで使用）

## アーキテクチャ

```
メッセージングアプリ → ホストプロセス（ルーター） → inbound.db → コンテナ（Bun、Claude Agent SDK） → outbound.db → ホストプロセス（配信） → メッセージングアプリ
```

単一のNodeホストがセッションごとのエージェントコンテナをオーケストレーションします。メッセージが到着すると、ホストはエンティティモデル（ユーザー → メッセージンググループ → エージェントグループ → セッション）に沿ってルーティングし、セッションの`inbound.db`に書き込み、コンテナを起こします。コンテナ内部のagent-runnerは`inbound.db`をポーリングしてエージェントを実行し、レスポンスを`outbound.db`に書き込みます。ホストは`outbound.db`をポーリングし、チャネルアダプターを通じて配信します。

セッションごとに2つのSQLiteファイル、各ファイルにライターは1つだけ — クロスマウントの競合なし、IPCなし、stdinパイプなし。チャネルと代替プロバイダーは起動時に自己登録します。トランクはレジストリとChat SDKブリッジを同梱し、アダプター本体はフォークごとにスキルでインストールされます。

詳しいアーキテクチャ説明は[docs/architecture.md](docs/architecture.md)を、3階層の分離モデルについては[docs/isolation-model.md](docs/isolation-model.md)を参照してください。

主要ファイル：
- `src/index.ts` — エントリーポイント：DB初期化、チャネルアダプター、配信ポーリング、sweep
- `src/router.ts` — インバウンドルーティング：メッセージンググループ → エージェントグループ → セッション → `inbound.db`
- `src/delivery.ts` — `outbound.db`をポーリングし、アダプター経由で配信、システムアクションを処理
- `src/host-sweep.ts` — 60秒ごとのsweep：ストール検出、期限到来メッセージの起動、繰り返し
- `src/session-manager.ts` — セッションの解決、`inbound.db`と`outbound.db`のオープン
- `src/container-runner.ts` — エージェントグループごとのコンテナ起動、OneCLIによるクレデンシャル注入
- `src/db/` — セントラルDB（ユーザー、ロール、エージェントグループ、メッセージンググループ、配線、マイグレーション）
- `src/channels/` — チャネルアダプターのインフラ（アダプターは`/add-<channel>`スキルでインストール）
- `src/providers/` — ホスト側プロバイダー設定（`claude`はバンドル、その他はスキル経由）
- `container/agent-runner/` — Bun製agent-runner：ポーリングループ、MCPツール、プロバイダー抽象化
- `groups/<folder>/` — エージェントグループごとのファイルシステム（`CLAUDE.md`、スキル、コンテナ設定）

## FAQ

**なぜDockerなのか？**

Dockerはクロスプラットフォーム対応（macOS、Linux、WSL2経由のWindows）と成熟したエコシステムを提供します。

**LinuxやWindowsで実行できますか？**

はい。Dockerがデフォルトのランタイムで、macOS、Linux、Windows（WSL2経由）で動作します。`bash nanoclaw.sh`を実行するだけです。

**セキュリティは大丈夫ですか？**

エージェントはアプリケーションレベルのパーミッションチェックではなく、コンテナ内で実行されます。明示的にマウントされたディレクトリのみアクセス可能です。クレデンシャルはコンテナに渡されず、アウトバウンドAPIリクエストは[OneCLI Agent Vault](https://github.com/onecli/onecli)を経由し、プロキシレベルで認証を注入し、レートリミットやアクセスポリシーをサポートします。実行するものはレビューすべきですが、コードベースは実際にレビュー可能な規模です。完全なセキュリティモデルについては[セキュリティドキュメント](https://docs.nanoclaw.dev/concepts/security)を参照してください。

**なぜ設定ファイルがないのか？**

設定の肥大化を避けたいからです。すべてのユーザーがNanoClawをカスタマイズし、汎用的なシステムを設定するのではなくコードが自分の望み通りに動くようにすべきです。設定ファイルが欲しければClaudeに追加するよう伝えれば実現できます。

**サードパーティやオープンソースモデルを使えますか？**

はい。推奨される方法は`/add-opencode`（OpenCode設定経由でOpenRouter、OpenAI、Google、DeepSeekなど）か`/add-ollama-provider`（Ollama経由でローカルのオープンウェイトモデル）です。どちらもエージェントグループごとに設定可能なので、同じインストール内で異なるエージェントが異なるバックエンドで動作できます。

一時的な実験用には、Claude API互換のエンドポイントも`.env`で利用できます：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**問題のデバッグ方法は？**

Claude Codeに聞いてください。「スケジューラーが動いていないのはなぜ？」「最近のログには何がある？」「このメッセージに返信がなかったのはなぜ？」これがNanoClawの基盤となるAIネイティブなアプローチです。

**セットアップがうまくいかない場合は？**

ステップが失敗した場合、`nanoclaw.sh`は診断と再開のためにClaude Codeへ制御を渡します。それでも解決しなければ、`claude`を実行して`/debug`を呼び出してください。他のユーザーにも影響しそうな問題をClaudeが特定した場合は、該当のセットアップステップまたはスキルにPRを送ってください。

**NanoClawをアンインストールするには？**

```bash
bash nanoclaw.sh --uninstall
```

インストールごとにチェックアウト単位のidが付与されるため、アンインストーラーはそのコピーに属するものだけを削除します。バックグラウンドサービス、コンテナとイメージ、アプリデータとログ、エージェントのファイル、そしてこのコピーのOneCLIボルト上のエージェントです。共有されているもの（OneCLIアプリとあなたのクレデンシャル、マシン上の他のNanoClawコピー）はそのまま残ります。何を見つけたかを正確に表示し、グループごとに確認を求めます。あなたが同意するまで何も削除されません。変更せずに内容を確認するには`--dry-run`、プロンプトを省くには`--yes`を使います。`.env`は削除前にバックアップされます。仕上げにチェックアウトフォルダー自体を削除してください。

**どのような変更がコードベースに受け入れられますか？**

ベース設定に受け入れられるのは、セキュリティ修正、バグ修正、明確な改善のみです。それだけです。

それ以外（新機能、OS互換性、ハードウェアサポート、拡張など）はスキルとしてコントリビュートしてください。チャネルとプロバイダーのコードは`channels`／`providers`のレジストリブランチへ、それ以外は自己完結したスキルとして。[docs/customizing.md](docs/customizing.md)と[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。

これにより、ベースシステムを最小限に保ち、全ユーザーが不要な機能を継承することなく自分のインストールをカスタマイズできます。

## コミュニティ

質問やアイデアがありますか？[Discordに参加](https://discord.gg/VDdww8qS42)してください。

## 変更履歴

破壊的変更については[CHANGELOG.md](CHANGELOG.md)を、完全なリリース履歴はドキュメントサイトの[リリース履歴](https://docs.nanoclaw.dev/changelog)を参照してください。

## ライセンス

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
