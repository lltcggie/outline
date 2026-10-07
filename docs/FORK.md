# フォーク独自の変更と運用手順

このリポジトリは [outline/outline](https://github.com/outline/outline) のフォークで、自己ホスト運用向けの独自変更を含む。上流にない手順はすべてこのドキュメントにまとめる。デフォルトブランチは `main-custom`。

## GitLab連携のプレビューをユーザー個人の権限で取得する

### 変更の概要

GitLab連携のリンクプレビュー（展開・メンション）が、各ユーザー自身のGitLab権限で見える情報だけを表示するようになっている。上流との主な違いは次のとおり。

- 管理者が登録するワークスペース連携は、GitLab URLとOAuthアプリケーション（クライアントID・シークレット）だけを持つ。展開用のトークンは持たない。
- 各ユーザーは、設定 → GitLab の「Your account」から自分のGitLabアカウントを連携する。プレビューは本人のトークンだけで取得され、連携していないユーザーには通常のリンクとして表示される。閲覧者・ゲストも連携できる。
- 取得結果は外部メンション（Issue・マージリクエスト・プロジェクト・URL）に保存されない。保存済みのデータはサーバー側の保存時にも除去される。
- 展開キャッシュはユーザー単位になっている。GitHubやIframelyなど結果が全員同じプロバイダーだけがチーム内で共有される。
- 設定済みのGitLabインスタンスのURLは、本人が連携していない場合や解釈できないURLでも、Iframelyなど後続の展開プロバイダーに渡されない。
- `EDITOR_VERSION` のメジャー番号を上げている（17 → 18）。取得結果を保存する旧クライアントは共同編集サーバーから拒否され、再読み込みを促される。

### 環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `GITLAB_URL` | 任意（推奨） | 自己ホストのGitLabインスタンスのURL（`https` のみ）。Markdown・API・MCPで作られた `@[...](https://gitlab.example.com/...)` 形式のメンションを、Issue・マージリクエスト・プロジェクト型として認識するために使う。未設定の場合はURL型のまま残り、閲覧者の取得結果のタイトルが表示される。インスタンスへの接続自体はワークスペース設定で行う。 |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | 任意 | 上流と同じ。gitlab.com 用のOAuthアプリケーション。 |

OAuthアプリケーションのスコープ（`read_api read_user`）とコールバックURL（`/api/gitlab.callback`）は上流と同じ。

### 既存のインスタンスの移行手順

この変更より前のバージョンから更新する場合は、次の順に行う。

1. `GITLAB_URL` を設定してデプロイする。デプロイ直後は、旧方式の共有トークンを使わなくなるため、誰にもGitLabのプレビューが出ない。
2. 保存済みの展開データを消去するスクリプトを実行する。まず `--dry-run` で対象件数を確認する。

   ```bash
   node build/server/scripts/20261005000000-remove-unfurled-mention-data.js --dry-run
   ```

   件数を確認したら、`--dry-run` を外して実行する。

   ```bash
   node build/server/scripts/20261005000000-remove-unfurled-mention-data.js
   ```

   スクリプトは次を行う。再実行しても安全で、共同編集サーバーを止める必要はない。

   - 文書（`content`・`state`・`text`）、版履歴、コメント、コレクション、テンプレートから、外部メンションに保存された `unfurl` 属性を取り除き、`label` をURLに戻す。`text` の更新により検索インデックスも再計算される（`postgres` と `pgroonga` のインデックスはDB側で自動更新される。それ以外の `SEARCH_PROVIDER` の場合は、検索プロバイダーへの再登録が別途必要）。
   - 該当する `events.changes` を `NULL` にし、`"unfurl":` を含む `webhook_deliveries` の行を削除する。
   - Redisの展開キャッシュ（`unfurl:*`）とメール差分キャッシュ（`diff:*`）を削除する。
   - GitLabのワークスペース連携に残った旧方式のトークンとアカウント情報を削除し、同じインスタンスの重複した連携を1つにまとめる。

3. 管理者を含む全員に、設定 → GitLab で自分のGitLabアカウントを連携するよう案内する。既存のワークスペース連携（URL・クライアントID・シークレット）はそのまま使える。

### 注意事項

- 移行前に送信済みのWebhookやメールに含まれた内容は回収できない。
- GitHub・Linear連携は引き続きワークスペース共有のトークンで取得する。閲覧権限の分離が必要な場合は、これらの連携を有効にしないこと。Asana連携（後述）はユーザー単位で取得する。
- Iframelyを使わない場合は `IFRAMELY_API_KEY` / `IFRAMELY_URL` を設定しないこと。
- 上流をマージするとき、上流が `shared/editor/version.ts` の `EDITOR_VERSION` を上げていたら、こちらのメジャー番号が上流より大きくなるよう調整すること。

## インラインコメントの強調表示スタイルを設定で切り替える

### 変更の概要

インラインコメントが付いた本文の強調表示を、上流の「下線」（細い水色の下線、ホバーで塗りつぶし）と、Confluenceに近い「ハイライト」（黄色の背景と下線、ホバー・選択で濃くなる）から選べるようにした。上流では下線のみ。以前はnginxの `sub_filter` で `</head>` の直前にCSSを差し込んで同じ見た目にしていたが、本体の設定に置き換えた。

- ワークスペースの既定値: 設定 → 詳細 → 表示の「Comment highlight」。管理者が選び、「保存」で反映される（チーム設定 `commentMarkStyle`、既定は `underline`）。
- ユーザーごとの上書き: 設定 → 環境設定 → 表示の「Comment highlight」。未設定ならワークスペースの既定値に従う（ユーザー設定 `commentMarkStyle`）。「Separate editing」と同じ方式で、一度選ぶとその後ワークスペースの既定値を変えても本人には反映されない。
- 色はテーマで持つ（`shared/styles/theme.ts` の `buildCommentMarkTheme`）。ライトは `#FFF0B3` / ホバー `#FFE380` / 選択 `#FFC400`、下線 `#FFC400`。ダークは同じ黄色を半透明にしたもので、文字色はテーマのまま。印刷時は背景も下枠も下線も付かない（`Styles.ts` の `commentMarkStyle` に入れ子で書いた `@media print` が同じ詳細度で上書きする。上流の `@media print { .comment { … } }` は詳細度が低く効かないので、そちらには頼らない）。
- 有効なスタイルは `User` モデルの `commentMarkStyle`（ユーザー設定 → チーム設定 → `underline`）で決まり、`Theme` コンポーネントが `useBuildTheme` に渡す。テーマ側でスタイルごとの色（`commentMarkHoverBackground`・`commentMarkActiveBackground` など）を解決済みにしているので、`shared/editor/components/Styles.ts`（通常・ホバー）と `app/editor/index.tsx`（選択中・サイドバーからのホバー）はスタイルで分岐せず、下線か背景＋下枠かの描画だけ `Styles.ts` の `commentMarkDecoration` が切り替える。エディターへ個別にpropsを渡してはいない。

### 既存のインスタンスの移行手順

1. Outlineをこのバージョンに更新する。
2. nginx側の差し込み（`sub_filter '</head>' '<style id="outline-custom">…</style></head>'`、および `proxy_set_header Accept-Encoding ""`・`sub_filter_types`・`sub_filter_once` がこの目的だけなら、それらも）を削除してnginxを再読み込みする。残しておくと `!important` 付きのCSSが本体の設定より優先され、設定を変えても見た目が変わらない。
3. 設定 → 詳細で「Comment highlight」を「Highlight」にして保存する。

### 注意事項

- 上流をマージするとき、`shared/types.ts`（`CommentMarkStyle`、`UserPreference.CommentMarkStyle`、`TeamPreference.CommentMarkStyle`）、`shared/constants.ts` の `TeamPreferenceDefaults`、`server/routes/api/users/schema.ts`・`server/routes/api/teams/schema.ts` の `preferences` スキーマ（`strictObject` なので、項目が無いと保存時に拒否される）、`shared/styles/theme.ts` と `app/typings/styled-components.d.ts` のテーマ項目、`app/models/User.ts` の `commentMarkStyle`、`app/hooks/useBuildTheme.ts`・`app/components/Theme.tsx`・`app/scenes/Shared/index.tsx`（共有ページのテーマにも渡す）、`shared/editor/components/Styles.ts` の `commentMarkDecoration`、`app/editor/index.tsx` の `EditorContainer`、サイドバー引用の縦線色 `app/scenes/Document/components/Comments/HighlightText.ts`、設定画面（`app/scenes/Settings/Details.tsx`・`Preferences.tsx`、共通の選択肢 `app/hooks/useCommentMarkStyleOptions.ts`）に差分があれば、この機能を保つように解決する。
- 上流がコメントマークのクラス名（`EditorStyleHelper.comment`）や `data-resolved`・`data-draft`・`data-user-id` 属性を変えたら、`Styles.ts` の `commentMarkStyle` のセレクターを合わせる。

## Asana連携（タスク・プロジェクトのプレビューをユーザー個人の権限で取得する）

### 変更の概要

別リポジトリ [outline-asana-unfurl](https://github.com/lltcggie/outline-asana-unfurl) のプラグインを `plugins/asana` として本体に取り込んだ。もとはコンパイル済みファイルをコンテナにマウントし、1つのトークン（`ASANA_ACCESS_TOKEN`）で全員分のプレビューを取得していた。取り込みにあたり、GitLab連携と同じく各ユーザーが自分のAsanaアカウントを連携する方式に変え、本体を変更できなかったために冗長だった部分も本体側で解消した。上流にAsana連携はない。

- 管理者はAsanaのOAuthアプリケーションを作り、環境変数 `ASANA_CLIENT_ID` / `ASANA_CLIENT_SECRET` を設定する。各ユーザーは設定 → Asana の「Connect」で自分のAsanaアカウントを連携する（閲覧者・ゲストも可）。プレビューは本人のトークンだけで取得され、連携していないユーザーには通常のリンクとして表示される。1つのAsanaアカウントを連携できるのはワークスペース内で1人だけ。
- タスクはIssue型のメンションとして表示される（GitLabのIssueと同じ見た目）。インラインでは完了状態のアイコン・タスク名・セクション名、ホバーでは担当者・期限・説明（ノート）・所属するプロジェクトとセクションのラベル（プロジェクトの色付き）が出る。プロジェクトはProject型として、プロジェクトの色・名前・完了タスクの割合を表示し、ホバーでは説明・状態（アクティブ／アーカイブ）・オーナー・期日が出る。別リポジトリ版はURL型（汎用リンク表示）だった。
- 表示文言（「担当」「期限」「完了」など）は閲覧者の言語設定で翻訳される。別リポジトリ版は日本語の直書きだった。
- 貼り付けメニューの「メンション」は、連携の有無にかかわらず `ASANA_CLIENT_ID` が設定されていればタスク・プロジェクトのURLをIssue型・Project型にする。クライアントの `PluginManager` に `Hook.MentionProvider` を追加し、`plugins/asana/client/index.tsx` が登録したものを `app/utils/mention.ts` の `getMentionTypeForURL` が参照する。Markdown・API・MCPで作られたメンションはサーバー側の `MentionProvider` で型が決まる。
- 展開キャッシュはユーザー単位。`app.asana.com` のURLは、本人が連携していない場合や、受信トレイ・検索など解釈できないURLでも、Iframelyなど後続の展開プロバイダーに渡さない。`http://` で貼られたリンクも同じタスク・プロジェクトとして扱う（Asanaがhttpsにリダイレクトするため）。
- アクセストークンは1時間で期限切れになり、リフレッシュトークンで自動更新される。Asana側でアプリの認可を取り消すと、次にプレビューを取得したときにAsanaがトークンを拒否（401）し、リフレッシュも拒否されるので、連携は自動的に解除される（ログに `Asana access of user … was revoked` が出る）。設定 → Asana を開き直すと「Connect」に戻っているので、連携し直す。
- プロジェクトの完了タスクの割合は `task_counts` エンドポイントで取得する。このエンドポイントは他より厳しいレート制限が掛かるため、取得できなかったときは割合だけを省いてプロジェクトを表示する。
- 本体側の変更: `IntegrationService.Asana` の追加、`IssueTrackerIntegrationService` へのAsanaの追加とタスク用のステータスアイコン（`shared/components/IssueStatusIcon/AsanaIssueStatusIcon.tsx`）、展開結果のURLからサービスを判定する `shared/utils/integrations.ts`（メンションとホバープレビューで重複していた判定をまとめた）、LinkedAccount型の `presentSettings` へのAsanaアカウントの追加。環境変数は本体の `Environment` クラスで検証する。別リポジトリ版にあった起動ログの独自出力、data URIのアイコン、独自の環境変数パーサーは不要になった。

### 必要なもの

[Asanaの開発者コンソール](https://app.asana.com/0/my-apps)で OAuth アプリケーションを作る。

- リダイレクトURL: `<OutlineのURL>/api/asana.callback`
- パーミッション: 「OAuth scopes」を使う場合は `tasks:read`・`projects:read`・`users:read` を選ぶ。「Full permissions」のアプリケーションにした場合は、環境変数 `ASANA_OAUTH_SCOPES` を `default` にする（Full permissions のアプリケーションは個別のスコープを要求できず、スコープ付きのアプリケーションはスコープの指定が必須のため）。

### 環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `ASANA_CLIENT_ID` / `ASANA_CLIENT_SECRET` | 任意 | OAuthアプリケーションのクライアントIDとシークレット。両方設定すると連携が有効になる。片方だけ設定すると起動時に環境変数の検証エラーで停止する。 |
| `ASANA_OAUTH_SCOPES` | 任意 | 連携時に要求するスコープ（スペース区切り）。既定は `tasks:read projects:read users:read`。Full permissions のアプリケーションでは `default`。 |
| `ASANA_SHOW_SECTION` | 任意 | タスク名の横にセクション名を表示するか。既定は `true`。 |
| `ASANA_CACHE_SECONDS` | 任意 | タスク・プロジェクトの取得結果をユーザーごとにキャッシュする秒数（1以上。キャッシュは無効にできない）。既定は `300`。Asanaのレート制限（無料プラン 150回/分、有料プラン 1,500回/分）はトークン＝ユーザーごとに掛かる。制限に当たると、そのリンクは60秒ほど通常のリンクとして表示され、ログに `Failed to fetch resource from Asana` が出る。 |

### 既存のインスタンスの移行手順（別リポジトリ版のプラグインを使っていた場合）

1. **OAuthアプリケーションを作る。** 「必要なもの」のとおり。
2. **旧プラグインのマウントを外す。** `outline` サービスから、ボリュームのマウント `./asana-unfurl:/opt/outline/build/plugins/asana-unfurl:ro` を**必ず外す**。マウント先のディレクトリ名が同梱版（`build/plugins/asana`）と違うため、残っていると両方が読み込まれ、旧版が共有トークンで取得した内容が引き続き全員に表示される。
3. **環境変数を替える。** `ASANA_ACCESS_TOKEN`（`ASANA_ACCESS_TOKEN_FILE`）を削除し、`ASANA_CLIENT_ID` と `ASANA_CLIENT_SECRET` を設定する（`docker.env` と `environment:` のどちらに書くかの注意は旧READMEと同じ）。`ASANA_SHOW_SECTION`・`ASANA_CACHE_SECONDS` はそのまま使える。
4. **Outlineをこのバージョンに更新して再起動する。**

   ```bash
   docker compose up -d outline
   ```

5. **保存済みの展開データを消去する。** 旧版が取得した内容（タスク名・セクション・担当者・期限）は、GitLab連携の変更より前のクライアントではメンションの属性として文書に保存されていた。GitLab連携の移行手順2のスクリプト（`20261005000000-remove-unfurled-mention-data.js`）はサービスを問わず外部メンションの保存データを取り除くので、まだ実行していなければ実行する。実行済みなら不要。
6. **残っているキャッシュを消す（任意）。** 旧版の取得結果は最長 `ASANA_CACHE_SECONDS`（既定5分）、解釈できなかったリンクは最長1時間、Redisに残る。本人が連携した時点でその人の分は消えるが、全員分をすぐに消したい場合は次を実行する（上のスクリプトも消去する）。

   ```bash
   docker compose exec redis sh -c "redis-cli --scan --pattern 'unfurl:*' | xargs -r redis-cli del"
   ```

7. **全員に連携を案内する。** 管理者を含む全員に、設定 → Asana で自分のAsanaアカウントを連携してもらう。連携するまでAsanaのリンクは通常のリンクとして表示される。
8. **旧版用のアカウントを片付ける。** 旧版のために用意した連携専用のAsanaアカウントとそのPersonal Access Tokenは不要になるので失効させる。

### 注意事項

- 旧版で作られたメンションはURL型のまま残る。閲覧者が連携していれば名前は表示されるが、ステータスアイコンやセクションは付かない。Issue型にするには、リンクを貼り直してメンションを選ぶ。
- 旧版と違い、本人から見えないタスクは通常のリンクとして表示される（旧版は共有トークンから見えないタスクが通常のリンクになっていた）。
- Asanaのノート（notes）はプレーンテキストだが、ホバープレビューの説明はMarkdownとして描画される。そのため `plugins/asana/server/asana.ts` の `escapeMarkdown` で記号をエスケープし、改行を保ったまま渡している（300文字に切り詰めた後にエスケープするので、エスケープ分は上限に数えない）。
- タスクの作成者名は、Asana APIが本人以外の作成者名を返さない場合は取れない。そのときホバーには作成者なしで「作成 〜前」とだけ表示される（`app/components/HoverPreview/HoverPreviewIssue.tsx` を変更）。
- 上流をマージするとき、`shared/types.ts`（`IntegrationService.Asana`・`IssueTrackerIntegrationService`・LinkedAccount型の設定）、`server/models/Integration.ts` の `presentSettings`、`shared/components/IssueStatusIcon/index.tsx`、`shared/utils/integrations.ts` とその呼び出し元（`shared/editor/components/Mentions.tsx`・`app/components/HoverPreview/HoverPreviewIssue.tsx`）、`app/utils/PluginManager.ts` の `Hook.MentionProvider`、`app/utils/mention.ts` の `getMentionTypeForURL` とその呼び出し元（`app/editor/components/PasteMenu.tsx`）に差分があれば、Asana分を保つように解決する。
- 上流が `UnfurlResponse` のIssue型・Project型の項目を変えたら、`plugins/asana/server/asana.ts` の `unfurlTask`・`unfurlProject` を合わせる（`satisfies` で `yarn tsc` が止まる）。
- 連携が自動解除されるのは、Asanaのトークンエンドポイントがリフレッシュを `invalid_grant`（リフレッシュトークンの失効・取り消し）で拒否したときだけ。`ASANA_CLIENT_SECRET` の誤りやローテーション漏れは `invalid_client` で拒否されるため連携は保持され、ログに `Asana refused to refresh an access token, check ASANA_CLIENT_ID and ASANA_CLIENT_SECRET` がerrorで出る。アクセストークンは1時間で切れるので、シークレットを替えたら環境変数も同時に更新すること。
- OAuthアプリケーションや `ASANA_OAUTH_SCOPES` に必要なスコープが無いと、Asanaは403で `The following scopes must be present …` を返す。このときはログに `Asana refused the request for a missing OAuth scope` がwarnで出る（本人に見えないタスク・プロジェクトの403・404はdebugのみ）。Asanaが既存のエンドポイントにスコープ要件を追加したときもこの形で現れる。

### 開発・テスト

- `yarn test plugins/asana` でURLの解析・OAuthコールバック・展開のテストを実行する。Asana APIはモックする。
- `yarn test shared/utils/integrations.test.ts` でURLからのサービス判定のテストを実行する。

## PGroongaによる日本語検索（`SEARCH_PROVIDER=pgroonga`）

### 変更の概要

PostgreSQLの拡張 [PGroonga](https://pgroonga.github.io/ja/) を使う検索プロバイダープラグイン `plugins/search-pgroonga` を同梱している。もとは別リポジトリ [outline-search-pgroonga](https://github.com/lltcggie/outline-search-pgroonga) でコンパイル済みファイルをマウントして使っていたものを、本体に取り込んだ。有効にすると、本文の途中にある日本語（中国語・韓国語も）が部分一致で見つかるようになる。

- 標準プロバイダー（`plugins/search-postgres`）を継承し、テキスト一致とランキング以外（閲覧権限の絞り込み・フィルター・タイトル検索・コレクション検索・共有リンクからの検索・検索語の無い一覧）はそのまま使う。
- インデックスは今のPostgreSQLの中に作られ、文書の更新に自動で追随する。別の検索サーバーは不要で、検索プロバイダーへの再登録も要らない。
- 本文はエディターの保存データ（`documents.content`）から取り出す。編集した内容は保存された時点（入力が止まってから数秒）で検索に反映される。標準の検索（`documents.text` を使う）に反映されるのは、文書を閉じたときか最後の編集から5分後。
- 本文として検索されるのは、文字・メンションの名前・リンク先のURL・添付ファイルの名前・画像の代替テキスト。全角/半角・大文字/小文字・半角カナは区別しない。ひらがなとカタカナは区別する。
- 検索の書き方: `設計書 認証`（両方を含む。全角スペースでも可）、`"出張の記録"`（そのままの並び）、`出張 -東京`（除外）、`東京 OR 福岡`（`OR` は大文字）。
- 英語は語幹一致ではなく部分一致になる（`postgre` で `PostgreSQL` が見つかる一方、`run` で `ran` は見つからない）。
- インデックスの定義（拡張・本文抽出関数・`CREATE INDEX`）は `plugins/search-pgroonga/server/pgroongaIndex.ts` にあり、スクリプト `server/scripts/search-pgroonga-index.ts` で作成・削除する。マイグレーションにはしていない。拡張は任意なので、マイグレーションにするとPGroongaの無いDBで `yarn db:migrate` が失敗するか、無いときに飛ばすなら後からPGroongaを入れたときに作る道筋が別途要り、結局スクリプトが必要になるため。

### 必要なもの

- PGroonga 3.1.6以上が入ったPostgreSQL。Dockerなら `groonga/pgroonga` イメージ（PostgreSQL公式イメージにPGroongaを足したもの）。テスト済みの組み合わせはPostgreSQL 16 + PGroonga 3.1.8と、PostgreSQL 18 + PGroonga 4.0.9。
- 初回の `CREATE EXTENSION pgroonga` にはスーパーユーザー権限が要る。Outline公式のCompose例のDBユーザーはスーパーユーザーなのでそのまま使える。そうでない場合は、先にスーパーユーザーで `CREATE EXTENSION pgroonga;` をOutlineのデータベースに対して実行しておく。

### 環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `SEARCH_PROVIDER` | 任意 | `pgroonga` でこのプロバイダーを使う。未設定または `postgres` で標準の検索。 |

### 既存のインスタンスの移行手順

所要時間の大半はDBイメージの差し替え。先にバックアップを取る。以下はDocker Composeの例で、サービス名が `postgres`・`outline`、DBユーザーが `user`、DB名が `outline` の場合。

1. **バックアップを取る。**

   ```bash
   docker compose exec postgres pg_dump -U user outline > outline-backup.sql
   ```

2. **PostgreSQLをPGroonga入りのイメージに替える。** `postgres` サービスの `image` を `groonga/pgroonga` に替える。データディレクトリをそのまま使うため、**メジャーバージョンとベースOSは今と同じもの**を選ぶ（`postgres:16` → `groonga/pgroonga:4.0.9-debian-16`、`postgres:16-alpine` → `groonga/pgroonga:4.0.9-alpine-16`）。タグはPGroongaのバージョンを固定したもの（開発用・CIと同じ `4.0.9`）を使い、`latest-debian-16` のような浮動タグは避ける。今のメジャーバージョンは `docker compose exec postgres postgres --version` で確認できる。Dockerを使っていない場合は、PGroonga公式のインストール手順でパッケージを追加する。

   ```bash
   docker compose up -d postgres
   ```

3. **Outlineをこのバージョンに更新する。** `SEARCH_PROVIDER` はまだ設定しない（標準の検索のまま動く）。

4. **インデックスを作る。** Outlineのコンテナでスクリプトを実行する。インデックスは書き込みを止めずに作られる（`CREATE INDEX CONCURRENTLY`）ので、作成中もOutlineは普通に使える。文書の量に応じて数秒から数分かかる。

   ```bash
   docker compose exec outline node build/server/scripts/search-pgroonga-index.js install
   ```

   スクリプトは再実行しても安全。途中で止まった場合（無効なインデックスが残る）も、もう一度実行すれば作り直される。`permission denied to create extension` で止まったら、「必要なもの」のとおりスーパーユーザーで拡張を作ってから再実行する。

5. **有効にする。** `outline` サービスの環境変数（`docker.env` でも可）に `SEARCH_PROVIDER=pgroonga` を足して再起動する。

   ```bash
   docker compose up -d outline
   ```

6. **確認する。** 文の途中にある語（これまで見つからなかったもの）で検索する。インデックスが無い状態で有効にすると、検索時に `search-pgroonga-index.js install` の実行を促すエラーがログに出る。

#### 別リポジトリ版のプラグインを使っていた場合

outline-search-pgroonga のコンパイル済みプラグインをマウントしていたインスタンスは、上の手順のうち2は済んでいる。代わりに次を行う。

1. `outline` サービスから、ボリュームのマウント `./search-pgroonga:/opt/outline/build/plugins/search-pgroonga:ro` を**必ず外す**。残っていると、同梱のプラグインが古いコンパイル済みファイルで上書きされる。
2. 同梱版のインデックス `documents_pgroonga_v3_idx` は別リポジトリ版のどのインデックスとも定義が違うため、更新直後の検索はエラーになる。`SEARCH_PROVIDER` を外して標準の検索に戻してから、Outlineをこのバージョンに更新して再起動する。
3. 手順4・5を行う。スクリプトは新しいインデックスを作り、別リポジトリ版のインデックス（`documents_pgroonga_idx`、`documents_pgroonga_v2_idx`）が残っていれば削除する。

#### インデックス定義の履歴

インデックスの内容を変えたときは名前も変え（`documents_pgroonga_v<N>_idx`）、古い名前はスクリプトが削除する。古い定義のまま使っていたインスタンスは、更新後に手順4のスクリプトを再実行する。実行が終わるまで検索は `search-pgroonga-index.js install` の実行を促すエラーになるので、避けたい場合は実行中だけ `SEARCH_PROVIDER` を外す。

| 名前 | 版 | 内容 |
| --- | --- | --- |
| `documents_pgroonga_idx` | 別リポジトリ版 `outline-1.10.1` | 本文を `text` 列から取る |
| `documents_pgroonga_v2_idx` | 別リポジトリ版 `outline-1.10.1-r2` 以降、同梱の初版 | 本文を `content` から取る。過去のタイトルは全部 |
| `documents_pgroonga_v3_idx` | 現在 | 過去のタイトルは新しいものから20個だけ。それより前のは検索に重みが付かず無視されていたため、古い20個ではなく新しい20個を索引する |

### 元に戻す

1. `SEARCH_PROVIDER` を削除（または `postgres` に）してOutlineを再起動する。これだけで標準の検索に戻る。標準の検索用のインデックスには手を付けていない。
2. 完全に消す場合は、その後にスクリプトでインデックスと関数を削除する。`SEARCH_PROVIDER` が `pgroonga` のままだと拒否される。拡張 `pgroonga` 自体は残る（不要なら `DROP EXTENSION pgroonga;`）。

   ```bash
   docker compose exec outline node build/server/scripts/search-pgroonga-index.js uninstall
   ```

### 注意事項

- インデックスの分、DBのディスク使用量が増える。本文が変わる保存のたびにインデックスも更新される（1回あたり数ms）。
- PGroongaのインデックスは既定ではクラッシュセーフではない。DBが異常終了したあと検索がおかしい場合は、`REINDEX INDEX CONCURRENTLY documents_pgroonga_v3_idx;` で作り直す。
- バックアップを別のDBへリストアする場合、リストア先にもPGroongaが必要。
- リードレプリカ（`DATABASE_READ_ONLY_URL`）を使っている場合は、PGroongaのレプリケーション設定が別途必要。
- 日付のメンションは `2026-10-05` の形式で検索できる。ユーザーや文書のメンションは、メンションを入れた時点の名前で検索される。過去のタイトルは1文書につき新しいものから20個が検索対象。
- 全角/半角の違いだけで一致した場合、結果の抜粋に太字のハイライトが付かない（検索自体は当たる）。
- ひらがなとカタカナを同一視したい場合は、`pgroongaIndex.ts` のノーマライザーを `NormalizerNFKC150("unify_kana", true)` に変えてインデックスを作り直す。

### 開発・テスト

- `docker-compose.yml` の開発用DBとCIのDBは `groonga/pgroonga` イメージになっている。タグは「必要なもの」のテスト済みの組み合わせに固定してあり（`4.0.9-debian-18`）、上げるときは両方を同時に上げて、テスト済みの組み合わせの記述も更新する。
- 検索プロバイダーの `indexedByDatabase`（`server/utils/BaseSearchProvider.ts`、このフォークで追加）が true のプロバイダーでは、`SearchIndexProcessor` はイベントを処理しない。標準プロバイダーとそれを継承するPGroongaプロバイダーはDB側でインデックスが更新されるので true。上流が `SearchIndexProcessor` の `SEARCH_PROVIDER === "postgres"` の判定を変えたときは、このフラグに合わせる。
- プラグインのテストは vitest のプロジェクト `server-pgroonga`（`vitest.config.ts`）で実行する。このプロジェクトはテストDBのサーバーにPGroongaがあるときだけ作られ（無ければその旨の警告が出て、プラグインのテストは実行されない）、`plugins/search-pgroonga/server/globalSetup.ts` がインデックスを作ってからワーカーを起動する。`SEARCH_PROVIDER=pgroonga` で標準プロバイダーのテスト（`plugins/search-postgres/server/PostgresSearchProvider.test.ts`）も実行し、閲覧権限の絞り込み・フィルター・並び順・ページングが標準と同じ期待を満たすことを確かめる。このテストの抜粋の期待値1か所は、両プロバイダーの結果を許す形にしてある。
- 上流をマージするとき、`plugins/search-postgres/` と `server/utils/BaseSearchProvider.ts` に差分があれば、プラグイン側へ追随させる。`PostgresSearchProvider` の `buildWhere` と `buildTeamWhere`（共有リンクの絞り込みをまとめたもの）はこのフォークで protected にしてプラグインから呼んでおり、上流で名前や引数が変わると `yarn tsc` で止まる。`PGroongaSearchProvider.ts` の `buildRankedOrder` と `buildSnippet` は標準の `buildFindOptions`・`buildResultContext` に対応するので、そちらが変わったら合わせる。`shared/editor/` でノード名や属性（`text`、`mention` の `attrs.type`・`attrs.label`、`br`、`attachment` の `attrs.title`、`image` の `attrs.alt`、`href`）が変わったときは、`pgroongaIndex.ts` の本文抽出関数を直し、インデックス名の版を上げて（`PGROONGA_INDEX_NAME`、旧名は `LEGACY_PGROONGA_INDEX_NAMES` に足す）「インデックス定義の履歴」に書く。
