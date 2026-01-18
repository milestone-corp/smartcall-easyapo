# SmartCall EasyApo

EasyApoの予約システムをSmartCallを用いて、予約管理をRPAにて自動化するプロジェクトです。

## 機能

- 空き枠の取得
- 予約の検索（電話番号で検索）
- 予約の作成
- 予約の更新
- 予約のキャンセル

## セットアップ

```bash
# 依存関係をインストール
npm install

# 環境変数を設定
cp .env.example .env
# .env を編集してログインID/パスワードを設定

# 常駐サーバーを起動
npm run start:persistent
```

## APIエンドポイント

すべてのエンドポイントは以下の認証ヘッダーが必要です：

| ヘッダー | 説明 |
|----------|------|
| `X-RPA-Login-Id` | EasyApoログインID |
| `X-RPA-Login-Password` | EasyApoパスワード |
| `X-RPA-Test-Mode` | `true`に設定するとスクリーンショットを返す（オプション） |

### GET /health

ヘルスチェック

**レスポンス:**
```json
{
  "status": "ok",
  "session_state": "ready",
  "has_credentials": true
}
```

### GET /status

詳細ステータス

**レスポンス:**
```json
{
  "session": {
    "state": "ready",
    "last_activity": "2025-12-28T10:00:00.000Z"
  },
  "config": {
    "keep_alive_interval_ms": 300000,
    "request_timeout_ms": 600000
  }
}
```

### GET /menu

診療メニュー一覧を取得

**レスポンス:**
```json
{
  "success": true,
  "menu": [
    {
      "external_menu_id": "1",
      "menu_name": "初診",
      "duration_min": 30,
      "resources": ["Dr1", "Dr2"],
      "resource_ids": [1, 2]
    }
  ],
  "count": 1,
  "timing": { "total_ms": 1234 }
}
```

| フィールド | 説明 |
|------------|------|
| `external_menu_id` | 診療メニューID |
| `menu_name` | 診療メニュー名 |
| `duration_min` | 所要時間（分） |
| `resources` | 処置可能な担当者名一覧 |
| `resource_ids` | 対応カラムID一覧 |

### GET /slots

空き枠を取得

**パラメータ:**
| パラメータ | 必須 | 説明 |
|------------|------|------|
| `date_from` | No | 開始日（YYYY-MM-DD）デフォルト: 本日 |
| `date_to` | No | 終了日（YYYY-MM-DD）デフォルト: date_fromと同じ |
| `resources` | No | 対象リソース名（カンマ区切り、例: `Dr1,Dr2`） |
| `duration` | No | 所要時間（分）。連続して確保できる枠のみ返却 |
| `external_menu_id` | No | 診療メニューID（`/menu`で取得可能） |
| `menu_name` | No | 診療メニュー名 |

**注意:**
- 現在時刻（JST）より過去の時間枠は返却されません
- `external_menu_id`または`menu_name`を指定すると、そのメニューの`resources`と`duration_min`で自動的に絞り込みます
- `resources`とメニューの両方を指定した場合、両方に含まれるリソースのみが対象になります
- `duration`とメニューの両方を指定した場合、長い方の時間が適用されます

**レスポンス:**
```json
{
  "success": true,
  "available_slots": [
    {
      "date": "2025-12-28",
      "time": "09:00",
      "duration_min": 30,
      "stock": 1,
      "resource_name": "チェア1"
    }
  ],
  "count": 1,
  "timing": { "total_ms": 1234 }
}
```

### GET /reservations/search

電話番号で予約を検索

**パラメータ:**
| パラメータ | 必須 | 説明 |
|------------|------|------|
| `customer_phone` | Yes | 顧客電話番号 |
| `date_from` | No | 開始日（YYYY-MM-DD）デフォルト: 本日 |
| `date_to` | No | 終了日（YYYY-MM-DD）デフォルト: date_fromと同じ |

**レスポンス:**
```json
{
  "success": true,
  "reservations": [
    {
      "appointId": "12345",
      "date": "2025-12-28",
      "time": "09:00",
      "customerName": "山田太郎",
      "customerPhone": "09012345678",
      "staffId": "staff1"
    }
  ],
  "count": 1,
  "timing": { "total_ms": 1234 }
}
```

### POST /reservations

予約を作成

**リクエストボディ:**
```json
{
  "date": "2025-12-28",
  "time": "09:00",
  "duration_min": 30,
  "customer_id": "5168",
  "customer_name": "山田太郎",
  "customer_phone": "09012345678",
  "menu_name": "初診",
  "external_menu_id": "1"
}
```

| パラメータ | 必須 | 説明 |
|------------|------|------|
| `date` | Yes | 予約日（YYYY-MM-DD） |
| `time` | Yes | 予約時刻（HH:MM） |
| `duration_min` | No | 所要時間（分）。メニュー指定時はメニューの所要時間を使用 |
| `customer_id` | No | 患者番号（診察券番号）。未指定時は`customer_name`/`customer_phone`で自動検索 |
| `customer_name` | Yes | 顧客名 |
| `customer_phone` | No | 顧客電話番号 |
| `menu_name` | No | 診療メニュー名 |
| `external_menu_id` | No | 診療メニューID（`/menu`で取得可能） |

**注意:**
- `customer_id`を指定しない場合、`customer_name`と`customer_phone`で患者マスタを検索し、ヒットした場合は自動的に患者番号を設定します
- メニューを指定すると、対応可能な担当者から自動的に空いている担当者が選択されます

**レスポンス:**
```json
{
  "success": true,
  "reservation_id": "create_1735380000000",
  "external_reservation_id": "12345",
  "timing": { "total_ms": 5678 }
}
```

### PUT /reservations

予約を更新（メニュー変更、日時変更など）

**リクエストボディ:**
```json
{
  "date": "2025-12-28",
  "time": "09:00",
  "customer_phone": "09012345678",
  "menu_name": "虫歯治療",
  "external_menu_id": "100001",
  "desired_date": "2025-12-29",
  "desired_time": "10:00"
}
```

| パラメータ | 必須 | 説明 |
|------------|------|------|
| `date` | Yes | 予約日（YYYY-MM-DD）- 予約の特定に使用 |
| `time` | Yes | 予約時刻（HH:MM）- 予約の特定に使用 |
| `customer_phone` | Yes | 顧客電話番号（予約の特定に使用） |
| `menu_name` | No | 更新後のメニュー名 |
| `external_menu_id` | No | 更新後のメニューID |
| `desired_date` | No | 変更後の希望日（YYYY-MM-DD） |
| `desired_time` | No | 変更後の希望時刻（HH:MM） |

**注意事項:**
- `desired_time`を指定すると、終了時刻は自動的に所要時間を維持して計算されます
- メニュー変更時、現在の担当者が対応不可の場合は対応可能な担当者に自動変更されます
- 診療時間外などの制約に違反する場合はエラーが返されます

**レスポンス:**
```json
{
  "success": true,
  "reservation_id": "update_1735380000000",
  "external_reservation_id": "12345",
  "timing": { "total_ms": 4567 }
}
```

### DELETE /reservations

予約をキャンセル

**リクエストボディ:**
```json
{
  "date": "2025-12-28",
  "time": "09:00",
  "customer_phone": "09012345678"
}
```

| パラメータ | 必須 | 説明 |
|------------|------|------|
| `date` | Yes | 予約日（YYYY-MM-DD） |
| `time` | Yes | 予約時刻（HH:MM） |
| `customer_phone` | Yes | 顧客電話番号（予約の特定に使用） |

**レスポンス:**
```json
{
  "success": true,
  "reservation_id": "cancel_1735380000000",
  "timing": { "total_ms": 3456 }
}
```

### POST /session/restart

セッションを再起動（ログインし直す）

**レスポンス:**
```json
{
  "success": true,
  "message": "Session restarted",
  "screenshot": "base64..."
}
```

## ディレクトリ構成

```
smartcall-easyapo/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── docs/
│   └── RPA_SPEC.md          # RPA仕様書
├── scripts/
│   ├── start.sh             # 起動スクリプト
│   ├── stop.sh              # 停止スクリプト
│   ├── restart.sh           # 再起動スクリプト
│   ├── status.sh            # ステータス確認
│   └── logs.sh              # ログ表示
├── src/
│   ├── server.ts            # 常駐サーバー
│   ├── lib/
│   │   └── BrowserSessionManager.ts  # セッション管理
│   └── pages/
│       ├── BasePage.ts      # 基底ページ
│       ├── LoginPage.ts     # ログインページ
│       └── AppointPage.ts   # アポイント管理台帳ページ
└── screenshots/             # スクリーンショット保存先
```

## Dockerでの起動

```bash
# 起動
./scripts/start.sh

# 停止
./scripts/stop.sh

# 再起動
./scripts/restart.sh

# ステータス確認
./scripts/status.sh

# ログ表示
./scripts/logs.sh -f
```

## 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|------------|
| `PORT` | サーバーポート | 3000 |
| `KEEP_ALIVE_INTERVAL_MS` | キープアライブ間隔（ms） | 600000 (10分) |
| `REQUEST_TIMEOUT_MS` | リクエストタイムアウト（ms） | 600000 (10分) |
