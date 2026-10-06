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
- GitHub・Linear連携は引き続きワークスペース共有のトークンで取得する。閲覧権限の分離が必要な場合は、これらの連携を有効にしないこと。
- Iframelyを使わない場合は `IFRAMELY_API_KEY` / `IFRAMELY_URL` を設定しないこと。
- 上流をマージするとき、上流が `shared/editor/version.ts` の `EDITOR_VERSION` を上げていたら、こちらのメジャー番号が上流より大きくなるよう調整すること。

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
