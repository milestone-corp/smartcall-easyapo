# smartcall-easyapo ブランチ／デプロイ／認証情報フロー調査

調査日: 2026-05-14
対象リポジトリ: `milestone-corp/smartcall-easyapo`

---

## 1. ブランチ取得とローカル状態

`git fetch --all` で取得済み。GitHub UI に未表示の `issue/2` も remote に存在。

| ブランチ | Ahead | Behind (vs main) | 最終コミット | 状態 |
|---|---|---|---|---|
| `main` | — | — | 2026-03-17 (346bba3) | 本番系の本流 |
| `dev` | 13 | 0 | 2026-04-05 (ad40ba8) | **未マージ。最新** |
| `feature/ikeda` | 12 | 0 | 2026-04-04 (dd25021) | dev に PR #6 で取り込み済み（≒ dev − マージcommit） |
| `feature/kana-filter` | 0 | 6 | 2026-03-02 | main に PR #5 でマージ済み（残骸） |
| `fix/3363` | 0 | 8 | 2026-03-02 | main に PR #4 でマージ済み（残骸） |
| `issue/2` | 0 | 29 | 2026-01-27 | 初期実装。main に取り込み済み（残骸） |

最新ブランチは **`dev`**。`dev` と `feature/ikeda` の差は PR #6 のマージコミットのみ。

---

## 2. 各ブランチの作業内容

### main（最新 = `346bba3`, 2026-03-17）
直近マージ済みの主な変更：
- beans-shika 用 docker-compose / デプロイスクリプト追加（RPA04, ポート 3011）
- Playwright を 1.58.0 に固定 / デプロイ時 `.env` 除外（**staging スクリプトのみ**）
- watai / konishi / ikeda の per-shop コンテナ分割（3011/3012/3013）
- 患者検索のカナ名対応、メモ未設定予約での電話番号照合、午後休診判定の修正

### dev（**未マージの最先端**, `ad40ba8`, 2026-04-05）
main にまだ入っていない 13 コミット。主な追加機能：
- `resource_ids` / `notes` パラメータ（空き枠取得・予約作成）
- websetting API による予約可能期間・受付時間制限
  - `web_accept_time` / `display_from_day` / `reservation_deadline`
- `[patient]` タグでの患者番号+生年月日特定を優先化（`/patients/number/`）
- 電話番号検索を下4桁検索 + 末尾一致比較に変更（tel2 も考慮）
- 予約変更時に pic（担当者）の空き状況を考慮した空き枠フィルタ（picコンテキスト TTL 1分）
- 受付時間 `00:00～00:00` を制限なし扱い
- 再ログイン時 `treatmentItems` キャッシュクリア
- **yuki-dental 用 docker-compose / デプロイスクリプト追加**（RPA04, ポート **3012**）

### feature/ikeda
dev とほぼ同一。dev へのマージ前ブランチで、最終コミットは yuki-dental 構成の追加。

### feature/kana-filter / fix/3363 / issue/2
すべて main マージ済みで、現在は historical。削除候補。

---

## 3. RPA サーバ／コンテナ構成

### サーバ一覧（デプロイスクリプトのヘッダコメントから判明）

| 役割 | ホスト | SSH ユーザ | リモートパス | 経由 |
|---|---|---|---|---|
| 旧本番 RPA01 | `192.168.20.70` | `alma` | `/home/alma/smartcall-easyapo` | 踏み台経由（**削除済み** `81e47f7`） |
| ステージング RPA03 | `192.168.20.72` | `centos` | `/home/centos/smartcall-easyapo` | 踏み台経由 |
| **本番 RPA04** | `192.168.20.73` | `centos` | `/home/centos/smartcall-easyapo` | 踏み台経由 |
| 踏み台 | `153.126.214.207` | `centos` | — | グローバル接続点（さくらクラウド推定） |

`192.168.20.73:xxxx` の `xxxx` は **クリニック単位のコンテナ公開ポート**。コンテナ内は常に 3000、ホスト側で 3011/3012/… にマップ。

### コンテナ／ポート対応

| 環境 | クリニック | compose ファイル | コンテナ名 | ホストポート | 設置サーバ |
|---|---|---|---|---|---|
| prod | watai | `docker-compose.prod.yml` | `smartcall-easyapo-watai` | 3011 | 旧 RPA01 |
| prod | konishi | 〃 | `smartcall-easyapo-konishi` | 3012 | 旧 RPA01 |
| prod | ikeda | 〃 | `smartcall-easyapo-ikeda` | 3013 | 旧 RPA01 |
| staging | — | `docker-compose.staging.yml` | `smartcall-easyapo-staging` | 3011 | RPA03 |
| prod | beans-shika | `docker-compose.beans-shika.yml` | `beans-shika` | 3011 | RPA04 |
| prod (dev only) | yuki-dental | `docker-compose.yuki-dental.yml` | `yuki-dental` | 3012 | RPA04 |

クリニック追加時は **compose ファイル + deploy スクリプトをコピペで複製しポート/コンテナ名/tarball名を書き換える** 運用。

### 実行環境
- ベースイメージ: `mcr.microsoft.com/playwright:v1.58.0-noble`（Ubuntu Noble + Chromium 同梱）
- ホスト OS: CentOS / AlmaLinux
- **Windows Server / Chrome 拡張は不要**。Playwright(Chromium) 1 コンテナで自己完結
- 他リポジトリの Chrome 拡張・Playwright 実装とは独立した別系統

---

## 4. デプロイ手順

### 共通フロー（[scripts/deploy-smartcall-easyapo-beans-shika.sh](../scripts/deploy-smartcall-easyapo-beans-shika.sh) など全スクリプト共通）

1. ローカルで該当スクリプトを実行
2. git status / `origin/main` との同期確認（`SKIP_GIT_SYNC=1` でスキップ可）
3. tarball 化（`node_modules` / `.git` / `dist` / `screenshots` / `input` / `output` を除外）
   - **staging スクリプトのみ `.env` も除外**（[scripts/deploy-smartcall-easyapo-staging.sh:108](../scripts/deploy-smartcall-easyapo-staging.sh#L108)）
   - **prod 系（beans-shika / yuki-dental / 旧 production）は `.env` 除外なし** → ローカル `.env` を持っているとそのまま転送される（要注意）
4. `~/.ssh/milestone` 鍵で踏み台（`153.126.214.207`）に scp
5. 踏み台 → RPA サーバへ scp、リモートで tar 展開
6. `sudo docker compose -f <compose> build && up -d`
7. `curl localhost:<port>/health` でヘルスチェック

### スクリプト実行例

```bash
# 本番（beans-shika, RPA04）
./scripts/deploy-smartcall-easyapo-beans-shika.sh

# ステージング（RPA03）
./scripts/deploy-smartcall-easyapo-staging.sh

# 本番（dev でのみ存在: yuki-dental, RPA04）
./scripts/deploy-smartcall-easyapo-yuki-dental.sh
```

### ログ確認
```bash
ssh -i ~/.ssh/milestone centos@153.126.214.207 \
  "ssh -i ~/.ssh/milestone centos@192.168.20.73 \
   'sudo docker logs --tail 50 beans-shika'"
```

---

## 5. ログイン情報の受け渡し（重要）

**デプロイ時に認証情報は渡しません。** ランタイムに HTTP ヘッダで受領する設計。

### サーバ起動時
- `.env` には認証情報を含めない（[\.env.example](../.env.example) に明記）
- `.env` で渡すのは `PORT` / スクリーンショット設定 / Keep-alive 間隔のみ

### API リクエスト時の受け渡し
| ヘッダ | 内容 |
|---|---|
| `X-RPA-Login-Id` | EasyApo ログイン ID |
| `X-RPA-Login-Password` | EasyApo パスワード |
| `X-RPA-Test-Mode` | （任意）`true` でスクリーンショット返却 |

### 内部フロー
1. [src/server.ts](../src/server.ts) の `getCredentialsFromRequest()` がヘッダから取り出して `Credentials { loginKey, loginPassword }` を生成
2. `BrowserSessionManager` がセッション内に保持し、`hasCredentialsChanged()` で前回リクエストと比較
3. 認証情報が変わっていれば再ログイン、変わっていなければ既存 Playwright セッションを再利用
4. ログインは [src/pages/LoginPage.ts](../src/pages/LoginPage.ts) の `login(loginId, password)` で Vue フォームに直接代入してフォーム submit

### 呼び出し元の責務
**SmartCall 本体（呼び出し元）がクリニック毎の EasyApo 認証情報を保持** し、毎リクエスト送信する。RPA サーバ側はクリニック情報を持たない（コンテナをクリニック単位で分けているのは Playwright セッション隔離と Mutex 競合回避が目的）。

### バッチ実行用の例外
[src/import-reservations.ts](../src/import-reservations.ts) のみ CLI 用に環境変数を使う：
- `RPA_LOGIN_KEY`
- `RPA_LOGIN_PASSWORD`

これは `npm run import` 時専用で、API サーバとは別経路。

---

## 6. 既存ドキュメント一覧

| ファイル | 内容 |
|---|---|
| [README.md](../README.md) | セットアップ / API 仕様（公式） |
| [AGENTS.md](../AGENTS.md) | リポジトリガイドライン（コード規約・ビルド・コミット） |
| [docs/RPA_SPEC.md](RPA_SPEC.md) | RPA 仕様書（API/ロジック中心、**サーバ IP 情報なし**） |

**引き継ぎドキュメント・`EasyApo.md` のような統合資料は存在しない** （全ブランチで確認済み）。サーバ構成・運用情報は事実上デプロイスクリプトのヘッダコメントが一次情報になっている。

---

## 7. 残件と次のアクション

### コードの残件
- **dev → main の PR が未作成**。dev に 12 コミット先行。マージブロッカは無さそう
  - websetting API 制限、resource_ids、patient タグ、pic フィルタなど機能追加が複数まとまっている
  - 本番投入前に staging（RPA03）で `dev` を動作確認するのが安全
- yuki-dental 構成は dev にしかない → main マージで本番 RPA04 にデプロイ可能になる
- 削除候補ブランチ: `feature/kana-filter` / `fix/3363` / `issue/2`（すべて main 取り込み済み）

### ドキュメントの残件
- 本ファイルが最初の運用ドキュメント。今後の追記候補：
  - サーバ別の SSH 接続手順（踏み台経由の二段 SSH）
  - クリニック追加手順（compose / deploy / port の命名規約）
  - prod 系デプロイスクリプトに `.env` 除外を入れるかの判断
  - 旧 RPA01（192.168.20.70）に残っているコンテナの扱い／停止計画

### 運用上の注意
- prod 系デプロイで **ローカル `.env` が tarball に混入する**ことに注意（staging スクリプトのみ除外設定済み）
- `~/.ssh/milestone` 鍵が必須（踏み台・RPA サーバ共通）
- main は 2026-03-17 以降止まっており、デプロイされている本番（beans-shika）も同コミット時点
