# EasyApo クリニック デプロイ手順書（ローカル / Staging / 本番）

作成日: 2026-06-18
更新日: 2026-06-19（統一デプロイフロー `scripts/deploy.sh` を追記）
対象: `smartcall-easyapo` リポジトリ
対象店舗: 本番 DB `shop_configs` の `integration_provider.code = 'easyapo'` の全店舗（6件）

---

## 0. 【推奨】統一デプロイフロー（`scripts/deploy.sh`）

> `refactor/unify-deploy` で導入。店舗ごとの個別 compose / 個別 deploy スクリプトを
> 1 つのテンプレート（[docker-compose.shop.yml](../docker-compose.shop.yml)）+
> 1 つのスクリプト（[scripts/deploy.sh](../scripts/deploy.sh)）に統合したもの。
> 以降の本番デプロイはこのフローを使う。旧フロー（第3〜5章）は参考用に残す。

### 0-1. 仕組み

```
envs/<SHOP_ID>-<NAME>.env   ← 店舗ごとの接続情報（.gitignore、ローカルのみ）
        │ deploy.sh が .env にコピー
        ▼
docker-compose.shop.yml     ← ${SHOP_NAME} ${SHOP_PORT} ${CONTAINER_NAME} を展開
        │
        ▼
踏み台 → RPAサーバ → docker compose build & up -d --remove-orphans
```

### 0-2. envs/ の準備（初回のみ）

`envs/<SHOP_ID>-<NAME>.env` は **機密情報（DEPLOY_HOST 等）を含むため .gitignore 対象**。
リポジトリには [envs/_template.env](../envs/_template.env) のみコミットされている。

```bash
# テンプレートから店舗envを作成（既に存在するなら不要）
cp envs/_template.env envs/57-konishi.env
# → SHOP_ID/SHOP_NAME/SHOP_PORT/DEPLOY_HOST/DEPLOY_USER 等を埋める
```

現在用意済みの env（接続情報は各自のローカルに保持）:

| env ファイル | 店舗 | DEPLOY_HOST | USER | PORT | CONTAINER_NAME |
|---|---|---|---|---|---|
| `envs/staging.env` | Staging | 192.168.20.72 | centos | 3011 | smartcall-easyapo-staging |
| `envs/51-watai.env` | 渡井 | 192.168.20.70 | alma | 3011 | smartcall-easyapo-watai |
| `envs/57-konishi.env` | 小西 | 192.168.20.70 | alma | 3012 | smartcall-easyapo-konishi |
| `envs/121-ikeda.env` | 池田 | 192.168.20.70 | alma | 3013 | smartcall-easyapo-ikeda |
| `envs/128-yuki-dental.env` | ゆきデンタル | 192.168.20.73 | centos | 3012 | yuki-dental |
| `envs/165-beans-shika.env` | ビーンズ | 192.168.20.73 | centos | 3011 | beans-shika |
| `envs/293-deguchi-shika.env` | でぐち歯科 | 192.168.20.73 | centos | 3013 | 293-deguchi-shika |

### 0-3. デプロイコマンド

本番店舗は `scripts/deploy.sh <店舗ID>`、Staging は `scripts/deploy-staging.sh` と
スクリプトが分かれている（複数院同居 vs 単一の挙動差を分離するため）。

```bash
# --- 本番店舗 ---
./scripts/deploy.sh 57 --dry-run   # 実行内容だけ確認（接続しない）
./scripts/deploy.sh 57             # 小西
./scripts/deploy.sh 165            # ビーンズ
./scripts/deploy.sh 128            # ゆきデンタル
./scripts/deploy.sh 293            # でぐち歯科
SKIP_GIT_SYNC=1 ./scripts/deploy.sh 57   # main 同期チェックをスキップ

# --- Staging ---
./scripts/deploy-staging.sh        # RPA03 へ
```

### 0-3-1. 複数院同居サーバでの隔離（重要）

RPA01 に watai/konishi/ikeda の3院、RPA04 に beans-shika/yuki-dental/deguchi-shika の3院が
**同一サーバ・同一ディレクトリ**に同居する。`docker-compose.shop.yml` は
service 名が `easyapo` 1つのため、何もしないと docker compose が
「同一サービスの既存コンテナ」とみなして他院を置換してしまう。

これを防ぐため `deploy.sh` は **`COMPOSE_PROJECT_NAME=smartcall-easyapo-<SHOP_NAME>`**
を店舗別に設定して各院を別 project として隔離する。
医院の分離の本質はあくまで **port**（3011/3012/3013…）であり、
`container_name` は `docker ps` / `docker logs` 用の運用ラベルにすぎない。

| 店舗 | compose project | container_name | port |
|---|---|---|---|
| 渡井 | smartcall-easyapo-watai | smartcall-easyapo-watai | 3011 |
| 小西 | smartcall-easyapo-konishi | smartcall-easyapo-konishi | 3012 |
| 池田 | smartcall-easyapo-ikeda | smartcall-easyapo-ikeda | 3013 |
| ビーンズ | smartcall-easyapo-beans-shika | beans-shika | 3011 |
| ゆきデンタル | smartcall-easyapo-yuki-dental | yuki-dental | 3012 |
| でぐち歯科 | smartcall-easyapo-293-deguchi-shika | 293-deguchi-shika | 3013 |

**本番 deploy.sh は `--remove-orphans` を使わない**（他院コンテナを巻き込むため）。
Staging のみ `deploy-staging.sh` で `--remove-orphans` を使う（1院しか居ないため安全）。

### 0-4. 検証（デプロイ後）

```bash
# ヘルスチェック（踏み台経由）— 例: staging
ssh -i ~/.ssh/milestone centos@153.126.214.207 "curl -s http://192.168.20.72:3011/health"

# 機能確認（その店舗のEasyApo認証で）— 例: 小西の認証
ssh -i ~/.ssh/milestone centos@153.126.214.207 \
  "curl -s http://192.168.20.72:3011/menu \
   -H 'X-RPA-Login-Id: <ID>' -H 'X-RPA-Login-Password: <PW>'" | jq
```

### 0-5. 旧コンテナからの移行（初回のみ手動作業が必要）

旧 `docker-compose.{prod,beans-shika,yuki-dental}.yml` で起動済みのコンテナが居る本番サーバへ
初めて新フローでデプロイすると、**同名コンテナ + 同ポートの衝突**が起きる。

本番 `deploy.sh` は他院を巻き込まないよう `--remove-orphans` を**使わない**ため、
**初回移行時のみ、対象院の旧コンテナを手動で停止・削除**しておく必要がある。

```bash
# 例: 小西 (konishi, RPA01:3012) を新フローへ移行する初回
# 1. 既存コンテナを停止・削除（ポート3012を解放）
ssh -i ~/.ssh/milestone centos@153.126.214.207 \
  "ssh -i ~/.ssh/milestone alma@192.168.20.70 'sudo docker rm -f smartcall-easyapo-konishi'"

# 2. 新フローでデプロイ
./scripts/deploy.sh 57
```

> 旧 `docker-compose.prod.yml` は3院（watai/konishi/ikeda）を1 project で同居させているため、
> `docker compose -f docker-compose.prod.yml down` を打つと**3院全部が止まる**。
> 初回移行では `docker rm -f <該当コンテナ名>` で**1院ずつ**外すのが安全。
>
> 2回目以降は新フロー同士（同じ project 名）なので衝突せず、`deploy.sh <ID>` だけで再デプロイできる。

#### 本番サーバの現状（2026-06-19 時点）

| サーバ | コンテナ | port | 状態 |
|---|---|---|---|
| RPA01 (.70) | smartcall-easyapo-watai | 3011 | healthy（旧prod.yml） |
| RPA01 (.70) | smartcall-easyapo-konishi | 3012 | healthy（旧prod.yml） |
| RPA01 (.70) | smartcall-easyapo-ikeda | 3013 | healthy（旧prod.yml） |
| RPA04 (.73) | beans-shika | 3011 | healthy（旧beans-shika.yml） |
| RPA04 (.73) | yuki-dental | 3012 | **unhealthy**（旧yuki-dental.yml、Vue3移行で停止中の可能性） |
| RPA04 (.73) | 293-deguchi-shika | 3013 | 🆕 未デプロイ（新規連携・統一フローで初回投入予定） |

### 0-6. 検証済み（2026-06-19）

`./scripts/deploy.sh staging` で RPA03 にデプロイ → Vue3 対応コード（playwright 1.61.0）が
リモートコンテナで動作することを確認:
- `/health` → degraded（未ログイン、正常）
- `/menu` → ✅（LoginPage DOM版 + treatment_items fetch）
- `/slots` → ✅（getReserveDayData 4本API並列fetch、ローカル検証と同結果）

---

## 1. 環境マップ

| 環境 | 用途 | サーバ | 想定 compose | 想定 deploy script |
|---|---|---|---|---|
| **ローカル** | 個人開発・動作確認 | 開発者PC | [docker-compose.yml](../docker-compose.yml) | [scripts/start.sh](../scripts/start.sh) ほか |
| **Staging** | 本番投入前の検証 | RPA03 (`192.168.20.72`) | [docker-compose.staging.yml](../docker-compose.staging.yml) | [scripts/deploy-smartcall-easyapo-staging.sh](../scripts/deploy-smartcall-easyapo-staging.sh) |
| **本番** | 各クリニックの運用 | RPA01 (`192.168.20.70`) / RPA04 (`192.168.20.73`) | 店舗別 compose | 店舗別 deploy script |

---

## 2. 店舗マップ（本番DBより取得）

shop_configs から取得した EasyApo 連携店舗（2026-06-18 時点）。

| 店舗ID | 店舗名 | 本番サーバ | ホストポート | container_name | 使用 compose | 使用 deploy script | 状態 |
|---|---|---|---|---|---|---|---|
| **51** | 渡井デンタルクリニック | `192.168.20.70` | 3011 | `smartcall-easyapo-watai` | [docker-compose.prod.yml](../docker-compose.prod.yml) | [deploy-smartcall-easyapo-production.sh](../scripts/deploy-smartcall-easyapo-production.sh) | ⚠️ `sync_enabled=0`（同期休止中） |
| **57** | 小西歯科クリニック | `192.168.20.70` | 3012 | `smartcall-easyapo-konishi` | [docker-compose.prod.yml](../docker-compose.prod.yml) | [deploy-smartcall-easyapo-production.sh](../scripts/deploy-smartcall-easyapo-production.sh) | ✅ 稼働中 |
| **121** | 池田歯科医院 | `192.168.20.70` | 3013 | `smartcall-easyapo-ikeda` | [docker-compose.prod.yml](../docker-compose.prod.yml) | [deploy-smartcall-easyapo-production.sh](../scripts/deploy-smartcall-easyapo-production.sh) | ✅ 稼働中 |
| **128** | ゆきデンタルクリニック | `192.168.20.73` | 3012 | `yuki-dental` | docker-compose.yuki-dental.yml | deploy-smartcall-easyapo-yuki-dental.sh | ⚠️ **dev ブランチのみ**（main に未マージ） |
| **165** | ビーンズ歯科 | `192.168.20.73` | 3011 | `beans-shika` | [docker-compose.beans-shika.yml](../docker-compose.beans-shika.yml) | [deploy-smartcall-easyapo-beans-shika.sh](../scripts/deploy-smartcall-easyapo-beans-shika.sh) | ✅ 稼働中 |
| **293** | でぐち歯科 | `192.168.20.73` | 3013 | `293-deguchi-shika` | [docker-compose.shop.yml](../docker-compose.shop.yml)（統一フロー） | `scripts/deploy.sh 293` | 🆕 新規連携（初回デプロイ前） |

### サーバ別の SSH 接続情報

| サーバ | グローバル経路 | SSH ユーザ | リモートパス |
|---|---|---|---|
| 踏み台 | `153.126.214.207` | `centos` | — |
| RPA01 (`192.168.20.70`) | 踏み台経由 | **`alma`** | `/home/alma/smartcall-easyapo` |
| RPA03 (`192.168.20.72`) | 踏み台経由 | `centos` | `/home/centos/smartcall-easyapo` |
| RPA04 (`192.168.20.73`) | 踏み台経由 | `centos` | `/home/centos/smartcall-easyapo` |

**共通**: SSH 鍵 `~/.ssh/milestone` を踏み台・RPAサーバの双方で使用。

---

## 3. ローカル環境デプロイ

### 3-1. 用途
- 開発・動作確認
- Browser-to-API 検証（実 EasyApo に接続）
- 受け付けるポートは `localhost:3001`（Docker）または `localhost:3000`（ホスト直起動）

### 3-2. 起動手順（推奨：ホスト直起動）

ブラウザの動きを目視できる headed モードが最も検証しやすい。

```bash
# 1. 依存インストール
npm install
# postinstall で @smartcall/rpa-sdk のビルドも走る

# 2. Playwright Chrome for Testing インストール（headed用）
./node_modules/.bin/playwright install chromium

# 3. .env 作成（認証情報は不要、PORT 等の最小設定）
cp .env.example .env

# 4. 起動（HEADLESS=false で Chromium 目視）
HEADLESS=false npm run dev
# → ts-node watch モード（コード変更で自動再起動）
# → 起動ログに「Running on port 3000」（または PORT 環境変数）
```

### 3-3. 動作検証（curl）

別ターミナルで：

```bash
# ヘルスチェック（認証不要）
curl -s http://localhost:3000/health | jq

# メニュー取得（認証必須）
curl -s http://localhost:3000/menu \
  -H "X-RPA-Login-Id: <EasyApo ID>" \
  -H "X-RPA-Login-Password: <PW>" | jq

# 空き枠取得
curl -s "http://localhost:3000/slots?date_from=2026-09-29&date_to=2026-09-29" \
  -H "X-RPA-Login-Id: <ID>" -H "X-RPA-Login-Password: <PW>" | jq

# 詳細手順は [docs/20260514-221120_local-test-and-chromium-debugging.md] を参照
```

### 3-4. Docker で起動する場合

ブラウザを目視できないが、本番に近い環境で起動：

```bash
./scripts/start.sh        # docker compose build && up -d
./scripts/status.sh       # 状態確認 + /health
./scripts/logs.sh -f      # ログ追従
./scripts/stop.sh         # 停止
```

ホスト側ポート `3001` で待受（[docker-compose.yml:11](../docker-compose.yml#L11)）。

---

## 4. Staging 環境デプロイ（RPA03）

### 4-1. 用途
- 本番投入前の最終検証
- 本来は本番と同条件で動作確認するための環境
- ホスト `192.168.20.72`、ポート `3011`、コンテナ名 `smartcall-easyapo-staging`

### 4-2. 前提条件
- SSH 鍵 `~/.ssh/milestone` を保有
- 踏み台 `centos@153.126.214.207` へ ssh できること
- 現在のブランチがデプロイしたい状態であること
- `npm install` は staging 側で自動実行されるため、ローカルで実行不要

### 4-3. デプロイ実行

```bash
# 現在のブランチで staging デプロイ
./scripts/deploy-smartcall-easyapo-staging.sh
```

スクリプトの流れ（[deploy-smartcall-easyapo-staging.sh:42-176](../scripts/deploy-smartcall-easyapo-staging.sh#L42-L176)）：

1. ローカルリポジトリ状態確認（未コミット変更があれば警告）
2. `origin/main` との同期確認（`SKIP_GIT_SYNC=1` でスキップ可）
3. tarball 作成（`node_modules`/`.git`/`dist`/`screenshots`/`.env` を除外）
4. 踏み台へ scp
5. 踏み台から RPA03 へ scp、展開
6. `docker compose -f docker-compose.staging.yml build && up -d`
7. ヘルスチェック（`curl localhost:3011/health`）
8. tarball クリーンアップ

**`.env` 除外設定あり**（[deploy-smartcall-easyapo-staging.sh:108](../scripts/deploy-smartcall-easyapo-staging.sh#L108)） — ローカル `.env` を持っていても流出しない。

### 4-4. 動作確認

```bash
# 踏み台経由でログ確認
ssh -i ~/.ssh/milestone centos@153.126.214.207 \
  "ssh -i ~/.ssh/milestone centos@192.168.20.72 \
   'sudo docker logs --tail 50 smartcall-easyapo-staging'"

# ヘルスチェック
ssh -i ~/.ssh/milestone centos@153.126.214.207 \
  "curl -s http://192.168.20.72:3011/health"
```

### 4-5. 検証完了後

Staging で問題なければ、`main` ブランチへマージ → 各クリニックへ展開。

---

## 5. 本番環境デプロイ

### 5-1. 共通事項

すべての本番デプロイは：
- 現在のローカル作業ツリーを tarball 化して転送
- 踏み台 `centos@153.126.214.207` を経由
- RPA サーバ上で `docker compose build && up -d`
- ヘルスチェックで完了確認
- `SKIP_GIT_SYNC=1` で main 同期チェックをスキップ可能（必要に応じて）

### 5-2. 渡井 / 小西 / 池田（RPA01 / 同居 3 コンテナ）

`docker-compose.prod.yml` で **1ファイル 3 サービス同居**。デプロイは**店舗ごとではなく一括** で 3 コンテナ全部を更新する設計。

```bash
# 全 3 店舗まとめて再デプロイ（watai / konishi / ikeda）
./scripts/deploy-smartcall-easyapo-production.sh
```

#### 個別店舗だけ対象にしたい場合（現状サポートなし）

`docker-compose.prod.yml` の services を1つだけ再起動するには、サーバ上で手動：

```bash
# RPA01 にアクセス
ssh -i ~/.ssh/milestone centos@153.126.214.207
ssh -i ~/.ssh/milestone alma@192.168.20.70

cd ~/smartcall-easyapo
sudo docker compose -f docker-compose.prod.yml build easyapo-konishi
sudo docker compose -f docker-compose.prod.yml up -d easyapo-konishi
```

#### ヘルスチェック（3コンテナ）

deploy スクリプトが自動的に 3つすべてに対して `curl /health` を打つ（[deploy-smartcall-easyapo-production.sh:148-159](../scripts/deploy-smartcall-easyapo-production.sh#L148-L159)）：

```
watai:    http://192.168.20.70:3011/health
konishi:  http://192.168.20.70:3012/health
ikeda:    http://192.168.20.70:3013/health
```

### 5-3. ビーンズ歯科（RPA04）

```bash
./scripts/deploy-smartcall-easyapo-beans-shika.sh
```

スクリプトの流れ（[deploy-smartcall-easyapo-beans-shika.sh:42-174](../scripts/deploy-smartcall-easyapo-beans-shika.sh#L42-L174)）：

1. ローカル / GitHub 同期確認
2. tarball 作成
3. 踏み台 → RPA04 (`centos@192.168.20.73`) へ転送
4. `docker compose -f docker-compose.beans-shika.yml build && up -d`
5. `curl localhost:3011/health` で確認

#### 動作確認

```bash
ssh -i ~/.ssh/milestone centos@153.126.214.207 \
  "ssh -i ~/.ssh/milestone centos@192.168.20.73 \
   'sudo docker logs --tail 50 beans-shika'"
```

### 5-4. ゆきデンタルクリニック（RPA04, dev ブランチ）

**⚠️ `docker-compose.yuki-dental.yml` と `deploy-smartcall-easyapo-yuki-dental.sh` は dev ブランチにしか存在しない**。main には未マージ。

`feature/yuki-dental-clinic-improve-flow` などのブランチを経由して、`main` へマージしてから本番デプロイすることが想定されている。マージ後：

```bash
# main または dev で実行
./scripts/deploy-smartcall-easyapo-yuki-dental.sh
```

スクリプトの流れは beans-shika と同等。違いは `SERVICE_PORT=3012`、`CONTAINER_NAME=yuki-dental`。

ヘルスチェック：

```bash
ssh -i ~/.ssh/milestone centos@153.126.214.207 \
  "curl -s http://192.168.20.73:3012/health"
```

---

## 6. Vue 3 対応（`feature/vue3-dom-migration`）デプロイの追加考慮

Ci EasyApo 2 が Vue 2 → Vue 3 (3.5.32) に移行されたことに伴う今回の対応。**5 店舗すべて** が影響対象。

### 6-1. 推奨ロールアウト順序

1. **ローカル**で実機検証（Playwright で Browser-to-API 動作確認、✅ 検証済み）
2. **Staging (RPA03)** に先行デプロイ → curl で `/menu` / `/slots` / `/reservations CRUD` 検証
3. 問題なければ `feature/vue3-dom-migration` → `main` へ PR & マージ
4. **小西歯科 (57)** を最初の本番投入対象に（DBで把握できているクリニックの中で最もテスト実施済み）
5. 池田 (121) → ビーンズ歯科 (165) → ゆきデンタル (128, dev側マージ後) の順で展開
6. 渡井 (51) は `sync_enabled=0` のため最後（または運用上不要なら除外）

### 6-2. 各デプロイで追加必要な作業

ローカル直起動の場合のみ：
```bash
# Playwright Chrome for Testing を更新
./node_modules/.bin/playwright install chromium
```

Docker（staging/本番）の場合：
- `Dockerfile` の base image が `mcr.microsoft.com/playwright:v1.61.0-noble` に更新されているので、初回 build は時間がかかる
- 既存イメージのキャッシュを消したい場合は `docker compose build --no-cache`

### 6-3. デプロイ後検証

各環境で `curl /health` → `/menu` → `/slots` の順で確認。404 や PROCESSING_ERROR が出ないこと。

具体的 curl コマンドは「3-3 動作検証」を参照。

---

## 7. ロールバック手順

### 7-1. 直前バージョンに戻したい場合

各 deploy スクリプトは tarball を毎回置き換える形なので、サーバ側に旧版は残らない。**事前にバックアップを取る運用**を推奨：

```bash
# RPA04 上で（デプロイ前に）現在の状態を退避
ssh -i ~/.ssh/milestone centos@153.126.214.207 \
  "ssh -i ~/.ssh/milestone centos@192.168.20.73 \
   'cd ~ && cp -r smartcall-easyapo smartcall-easyapo-backup-$(date +%Y%m%d-%H%M%S)'"
```

### 7-2. 緊急ロールバック

直近の git タグ（例：`v2026.03.28-beta.2`）に戻して再デプロイ：

```bash
git checkout v2026.03.28-beta.2
./scripts/deploy-smartcall-easyapo-beans-shika.sh   # 例
```

### 7-3. コンテナの再起動だけしたい

```bash
ssh -i ~/.ssh/milestone centos@153.126.214.207 \
  "ssh -i ~/.ssh/milestone centos@192.168.20.73 \
   'sudo docker restart beans-shika'"
```

---

## 8. 既知の問題・注意点

### 8-1. prod 系 deploy が `.env` を tarball から除外していない
**[deploy-smartcall-easyapo-production.sh](../scripts/deploy-smartcall-easyapo-production.sh)**, **beans-shika**, **yuki-dental** の各スクリプトは `.env` を除外していない（staging のみ除外設定あり）。**ローカルに認証情報が混ざった `.env` があるとサーバ側に転送される**ので、デプロイ前に確認すべき。

恒久対応は別途（`refactor/unify-deploy` ブランチで全 deploy スクリプトを共通化する際に修正予定）。

### 8-2. `docker-compose.prod.yml` は 3 コンテナ同居
`watai`/`konishi`/`ikeda` を分割せずに同居させているため、**個別店舗のみのデプロイができない**。スクリプト1回で 3コンテナ全部が再ビルド・再起動される。1店舗だけ更新したい場合は、上記「5-2. 個別店舗だけ対象にしたい場合」の手動オペレーション。

### 8-3. yuki-dental が main にない
`docker-compose.yuki-dental.yml` と対応 deploy スクリプトは `dev` ブランチでのみ存在。Vue 3 対応の main マージ時に同時に取り込むか、別 PR で先行マージするか調整必要。

### 8-4. 渡井 (`shop_id=51`) の同期休止
DB上 `is_active=1, sync_enabled=0`。**設定上は有効だが同期は無効**。実運用していない可能性があり、デプロイ対象に含めるか要確認。

### 8-5. 旧 RPA01 (`.70`) のサーバユーザは `alma`、新 RPA04 (`.73`) は `centos`
共通化（refactor/unify-deploy）の際は、店舗ごとに `DEPLOY_USER` を変数化する必要がある。

---

## 9. 関連ドキュメント

- [docs/20260514-221120_local-test-and-chromium-debugging.md](20260514-221120_local-test-and-chromium-debugging.md) — ローカルテスト/Chromium 動作把握
- [docs/20260514-221121_docker-compose-files.md](20260514-221121_docker-compose-files.md) — 全 compose ファイルの仕様
- [docs/20260514-221122_scripts.md](20260514-221122_scripts.md) — scripts 配下の全スクリプト仕様
- [docs/20260617_easyapo2-api-spec/20260617-103212_api-spec.md](20260617_easyapo2-api-spec/20260617-103212_api-spec.md) — EasyApo 2 API 仕様
- [README.md](../README.md) — API エンドポイント仕様

---

## 10. クイックリファレンス（デプロイ一覧）

```bash
# ======== ローカル ========
HEADLESS=false npm run dev                                    # headed Chromium
./scripts/start.sh                                            # Docker
./scripts/status.sh                                           # 状態確認
./scripts/logs.sh -f                                          # ログ
./scripts/stop.sh                                             # 停止

# ======== Staging (RPA03) ========
./scripts/deploy-smartcall-easyapo-staging.sh                 # デプロイ
# curl http://192.168.20.72:3011/health 経由（踏み台）

# ======== 本番 ========
# 渡井 / 小西 / 池田 (RPA01, 3コンテナ同居)
./scripts/deploy-smartcall-easyapo-production.sh

# ビーンズ歯科 (RPA04 / 3011)
./scripts/deploy-smartcall-easyapo-beans-shika.sh

# ゆきデンタル (RPA04 / 3012) ※ dev ブランチのみ
./scripts/deploy-smartcall-easyapo-yuki-dental.sh

# ======== 本番（統一フロー: scripts/deploy.sh）========
./scripts/deploy.sh 293 --dry-run                            # でぐち歯科 内容確認
./scripts/deploy.sh 293                                      # でぐち歯科 (RPA04 / 3013)
```
