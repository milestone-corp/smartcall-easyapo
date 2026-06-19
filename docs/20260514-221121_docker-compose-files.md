# docker-compose ファイル仕様

作成日: 2026-05-14
対象: リポジトリルートに置かれた全 `docker-compose.*.yml` の説明

---

## 共通仕様

すべての compose ファイルは次を共有する。

- `build: .` — リポジトリルートの [Dockerfile](../Dockerfile) でビルド（ベース: `mcr.microsoft.com/playwright:v1.58.0-noble`）
- `env_file: .env` — 認証情報は含めない。`PORT` / スクリーンショット設定 / Keep-alive 間隔のみ
- `KEEP_ALIVE_INTERVAL_MS=${KEEP_ALIVE_INTERVAL_MS:-600000}` — デフォルト10分
- `command: ["npm", "run", "start"]` — `ts-node` で `src/server.ts` を直接起動
- `restart: unless-stopped`
- コンテナ内ポート `3000` 固定（[Dockerfile:27](../Dockerfile#L27) で `EXPOSE 3000`）

ホスト側ポートと `container_name` だけが各ファイルの違い。クリニック追加時はコピペで複製してこれらを書き換える運用。

---

## 一覧（早見表）

| ファイル | コンテナ名 | ホストポート | 想定設置サーバ | ログ設定 | 用途 |
|---|---|---|---|---|---|
| [docker-compose.yml](../docker-compose.yml) | `smartcall-easyapo` | `3001` | ローカル開発 | なし | 開発・動作確認 |
| [docker-compose.prod.yml](../docker-compose.prod.yml) | `smartcall-easyapo-{watai,konishi,ikeda}` | `3011/3012/3013` | 旧 RPA01 (`192.168.20.70`) | 10MB×3 | 旧本番（watai/konishi/ikeda 同居） |
| [docker-compose.staging.yml](../docker-compose.staging.yml) | `smartcall-easyapo-staging` | `3011` | RPA03 (`192.168.20.72`) | 10MB×3 | ステージング |
| [docker-compose.beans-shika.yml](../docker-compose.beans-shika.yml) | `beans-shika` | `3011` | RPA04 (`192.168.20.73`) | 10MB×3 | 本番（beans-shika） |
| [docker-compose.yuki-dental.yml](../docker-compose.yuki-dental.yml) ※dev のみ | `yuki-dental` | `3012` | RPA04 (`192.168.20.73`) | 10MB×3 | 本番（yuki-dental） |

`docker-compose.yuki-dental.yml` は `main` には存在せず `dev` ブランチでのみ追加されている。

---

## 詳細

### `docker-compose.yml`（ローカル開発用）
- ホスト `3001` → コンテナ `3000` の単一サービス `easyapo`
- ボリューム: `./screenshots` / `./input` / `./output`
- ログドライバ指定なし（Docker のデフォルト）
- 運用スクリプト `start.sh` / `stop.sh` / `restart.sh` / `status.sh` / `logs.sh` は **このファイル前提**。コンテナ名 `smartcall-easyapo` を grep している
- ローカルでテストする場合はこれを使う

### `docker-compose.prod.yml`（旧本番 / RPA01）
1 ファイルに 3 サービスを同居：
| サービス | container_name | ホストポート | screenshots |
|---|---|---|---|
| `easyapo-watai` | `smartcall-easyapo-watai` | 3011 | `./screenshots/watai` |
| `easyapo-konishi` | `smartcall-easyapo-konishi` | 3012 | `./screenshots/konishi` |
| `easyapo-ikeda` | `smartcall-easyapo-ikeda` | 3013 | `./screenshots/ikeda` |
- 3クリニック分のブラウザセッションを完全分離（Playwright セッション+Mutex 競合回避）
- ログ: `json-file` / `max-size: 10m` / `max-file: 3`
- 元の本番デプロイ先 RPA01 (`alma@192.168.20.70`) は **デプロイスクリプト削除済み**（コミット `81e47f7`）。残置運用かどうかは要確認（残件）

### `docker-compose.staging.yml`（RPA03）
- 単一サービス `easyapo-staging` / コンテナ名 `smartcall-easyapo-staging` / ポート `3011`
- `screenshots/` を **クリニック別分けなし** でルートマウント（staging は単一テナント運用）
- `deploy-smartcall-easyapo-staging.sh` から使われる
- アクセス: `http://192.168.20.72:3011`

### `docker-compose.beans-shika.yml`（RPA04 / 本番）
- 単一サービス `easyapo-beans-shika` / コンテナ名 `beans-shika` / ポート `3011`
- screenshots: `./screenshots/beans-shika`
- `deploy-smartcall-easyapo-beans-shika.sh` から使われる
- アクセス: `http://192.168.20.73:3011`

### `docker-compose.yuki-dental.yml`（RPA04 / 本番 / dev のみ）
- 単一サービス `easyapo-yuki-dental` / コンテナ名 `yuki-dental` / ポート `3012`
- screenshots: `./screenshots/yuki-dental`
- beans-shika と **同じ RPA04 サーバ**で同居（ポート違いで分離）
- `deploy-smartcall-easyapo-yuki-dental.sh` から使われる（dev のみ）
- アクセス: `http://192.168.20.73:3012`
- **main にはまだ無い**。dev → main マージで本番投入可能になる

---

## 命名規約とクリニック追加手順

新規クリニックを増やすときは次のテンプレートをコピペする：

1. `docker-compose.<clinic>.yml` を作成
   - `service` 名: `easyapo-<clinic>`
   - `container_name`: `<clinic>`（または `smartcall-easyapo-<clinic>`）
   - `ports`: 既存と被らないホストポート（3013, 3014…）
   - `volumes`: `./screenshots/<clinic>:/app/screenshots`
2. `scripts/deploy-smartcall-easyapo-<clinic>.sh` を作成（beans-shika のコピペで可）
   - `RPA_SERVER` / `COMPOSE_FILE` / `CONTAINER_NAME` / `SERVICE_PORT` / `TARBALL_NAME` を書き換え
3. デプロイ実行

`docker-compose.prod.yml` のように 1 ファイルに複数サービスを束ねるパターンは旧 RPA01 のみ。新しい運用は **クリニック=ファイル=スクリプト1対1対1** の構成。

---

## 注意点

- `env_file: .env` は **コンテナ内パスではなくホスト側 .env** を読む。デプロイ先サーバの `.env` 内容が反映される
- `.env` に認証情報を入れない設計（[.env.example](../.env.example) 参照）。誤って入れるとデプロイ転送時に流出するリスクあり
- prod 系 deploy スクリプトの tarball **`.env` 除外設定は staging スクリプトにのみ存在** （コミット `30f07f3`）。beans-shika / yuki-dental / 旧 production は `.env` を除外していない
- リソース制限（CPU/メモリ）は未設定。同一サーバ上で複数コンテナ同居（RPA04: beans-shika + yuki-dental）するとメモリ干渉に注意
