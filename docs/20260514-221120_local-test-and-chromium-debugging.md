# ローカルテスト手順とコンテナ内Chromiumの動作把握

作成日: 2026-05-14
対象: 開発者がローカルでDockerコンテナを起動し、EasyApoのAPI/RPA動作を検証する手順

---

## 1. 結論

- **ローカルでDocker起動してテスト可能。** 認証情報は `.env` ではなくAPIヘッダで毎リクエスト渡す。
- ブラウザ自動化は **Playwright（v1.58.0 固定）** で行っている。裸の Chromium ではない。
- コンテナ内 Chromium は **headless** で動作するため、コンテナ外から GUI を直接覗くことはできない。
- 観察手段は次の3系統 ＋ 1 オプション：
  1. スクリーンショット（ホストマウント＋ `X-RPA-Test-Mode` ヘッダで base64 取得）
  2. コンテナログ（`docker logs` / `./scripts/logs.sh`）
  3. **ホストで `HEADLESS=false npm run dev` 直起動**（headed Chromium が目視できる）
  4. （非推奨）Xvfb + VNC をイメージに足して Docker でも headed 観察

---

## 2. Playwright の使用箇所（根拠）

| 箇所 | 内容 |
|---|---|
| [Dockerfile](../Dockerfile) | `FROM mcr.microsoft.com/playwright:v1.58.0-noble` — Playwright公式イメージ（Chromium 同梱） |
| [package.json](../package.json) | `"playwright": "1.58.0"` を **固定**（コミット `dfd867a` でコンテナとの不一致防止） |
| [src/lib/BrowserSessionManager.ts:8](../src/lib/BrowserSessionManager.ts#L8) | `import type { Page } from 'playwright'` |
| [src/import-reservations.ts:12](../src/import-reservations.ts#L12) | `import { chromium } from 'playwright'` で `chromium.launch({ headless: ... })` |
| [src/pages/AppointPage.ts:13](../src/pages/AppointPage.ts#L13) | `import type { Page, JSHandle } from 'playwright'` |

共通基盤の `@smartcall/rpa-sdk` (`BaseBrowserSessionManager`) も Playwright のラッパー。`postinstall` で別リポジトリ `milestone-corp/smartcall-rpa-sdk#main` から取得・ビルドされる。

### 起動オプション（[BrowserSessionManager.ts:42-60](../src/lib/BrowserSessionManager.ts#L42-L60)）
```
headless:        true（デフォルト、HEADLESS=false で切替）
viewport:        1485 × 1440
browserArgs:     --no-sandbox --disable-setuid-sandbox
locale:          ja-JP
timezoneId:      Asia/Tokyo
keepAlive:       5分（環境変数 KEEP_ALIVE_INTERVAL_MS で上書き、Dockerデフォルトは10分）
```

---

## 3. ローカル Docker でのテスト手順

### 3-1. 初期セットアップ
```bash
# 認証情報は不要。PORT等の最小設定でOK
cp .env.example .env

# 起動（ラッパー使用）
./scripts/start.sh
```

`scripts/start.sh` は `docker compose build && up -d` を実行し、ホスト `3001` → コンテナ `3000` ([docker-compose.yml:11](../docker-compose.yml#L11)) で待ち受ける。コンテナ名は `smartcall-easyapo` 固定。

### 3-2. API 呼び出し
```bash
# ヘルスチェック（認証不要）
curl -s http://localhost:3001/health

# 認証必要なエンドポイント（毎リクエスト ヘッダで渡す）
curl -s http://localhost:3001/menu \
  -H "X-RPA-Login-Id: <EasyApoログインID>" \
  -H "X-RPA-Login-Password: <パスワード>" \
  -H "X-RPA-Test-Mode: true"   # ← レスポンスにbase64スクショ同梱
```

**注意**: 実 EasyApo サーバへ実際にログインしに行く。テストアカウント（staging相当）が必須。

### 3-3. 停止 / 再起動
```bash
./scripts/stop.sh        # docker compose down
./scripts/restart.sh     # down → build → up -d
./scripts/status.sh      # 状態 + /health + /session/status をまとめて表示
./scripts/logs.sh -f     # tail -f
```

これら運用スクリプトは **コンテナ名 `smartcall-easyapo` を直接 grep している** ため、本番系の per-shop コンテナ（watai/konishi/ikeda/beans-shika/yuki-dental）に対しては動かない。本番系では `docker compose -f docker-compose.<env>.yml ...` を直接叩く必要がある。

### 3-4. ローカル直起動（Docker を使わない開発モード）
```bash
npm install              # postinstall で rpa-sdk もビルド
npm run dev              # ts-node + watch
# headed Chromium を目視で確認するなら:
HEADLESS=false npm run dev
# Playwright Inspector も併用するなら:
PWDEBUG=1 HEADLESS=false npm run dev
```
[src/server.ts:178](../src/server.ts#L178) と [src/import-reservations.ts:68](../src/import-reservations.ts#L68) で `process.env.HEADLESS !== 'false'` を判定しているため、環境変数 1 つで headless / headed が切り替わる。

---

## 4. コンテナ内 Chromium の動作把握手段

### (a) スクリーンショット（最も実用的）
- ホストの `./screenshots/` がコンテナ `/app/screenshots` にマウント済み ([docker-compose.yml:13](../docker-compose.yml#L13))
- 各操作で逐次保存（`AppointPage` 内のステップごと）
- リクエストヘッダ `X-RPA-Test-Mode: true` を付与すると **APIレスポンスに base64 スクショ同梱**で即座にデバッグ可能 ([README.md:36](../README.md#L36))

### (b) コンテナログ
```bash
docker logs -f smartcall-easyapo   # 直接
./scripts/logs.sh -f               # ラッパー（--tail N も指定可）
```
- `console.log` 系のステップログ
- Playwright の操作進捗
- リクエスト受領・認証エラー・タイムアウトなどがすべて流れる

### (c) ホスト直起動で目視（推奨）
GUI でブラウザ操作を見たいなら **Docker をやめてホスト直起動**するのが最速：
```bash
HEADLESS=false npm run dev
```
- ts-node の watch モードでコード変更が即反映
- Chromium が実画面に立ち上がり、操作の一挙手一投足が見える
- Playwright Inspector (`PWDEBUG=1`) と組み合わせるとステップ実行可能

### (d) Docker で headed 観察したい場合（非推奨）
標準イメージには X/VNC が入っていない。`mcr.microsoft.com/playwright:v1.58.0-noble` に Xvfb + x11vnc + noVNC を追加してカスタムイメージ化する必要がある。普通は (a)(b)(c) で十分で、本リポジトリには用意されていない。

---

## 5. 認証情報フロー（再掲）

| タイミング | 受け渡し方法 | 場所 |
|---|---|---|
| デプロイ時 | **渡さない**（`.env` にも入れない） | — |
| サーバ起動時 | 認証情報なしで起動（セッション未確立） | [server.ts](../src/server.ts) |
| APIリクエスト時 | HTTPヘッダ `X-RPA-Login-Id` / `X-RPA-Login-Password` | [server.ts:97-98](../src/server.ts#L97-L98) |
| Playwrightログイン | `LoginPage.login(loginId, password)` で Vue フォームに直接代入 | [LoginPage.ts:42-48](../src/pages/LoginPage.ts#L42-L48) |
| セッション再利用 | `hasCredentialsChanged()` で前回と比較、同一なら再ログインしない | [server.ts](../src/server.ts) |
| バッチCLI (`npm run import`) | 環境変数 `RPA_LOGIN_KEY` / `RPA_LOGIN_PASSWORD` ※APIサーバとは別経路 | [import-reservations.ts:35-36](../src/import-reservations.ts#L35-L36) |

呼び出し元（SmartCall本体）がクリニック毎の認証情報を保持し毎リクエスト送信する。RPAサーバ側はクリニック情報を持たない。コンテナをクリニック単位で分けているのは **Playwright セッション隔離 + Mutex 競合回避** が目的。

---

## 6. トラブルシュート Tips

| 症状 | 原因 / 対処 |
|---|---|
| `Browser type 'chromium' is not installed` | Playwrightバージョンとイメージのバージョンが合っていない。`package.json` は `1.58.0` 固定（`dfd867a`）。`npm install` をやり直す |
| ヘッダなしでAPIを叩くと401相当 | `X-RPA-Login-Id` / `X-RPA-Login-Password` 必須（[server.ts:260, 348, 443, 567, 699, 825, 926](../src/server.ts#L260)） |
| `EasyApo` への接続でログイン失敗 | 実サーバへ実際にアクセスする。VPN / 資格情報 / クリニック側設定を確認 |
| スクショが出ない | `.env` の `ENABLE_SCREENSHOT=true` を確認 / `./screenshots/` のマウント権限を確認 |
| `./scripts/status.sh` が本番系で動かない | コンテナ名 `smartcall-easyapo` 固定。本番系は `docker ps` / `docker logs <name>` を直接使う |
