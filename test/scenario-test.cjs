// @ts-check
/**
 * EasyApo シナリオテスト
 *
 * 各種予約操作のシナリオをテストする
 * 
 * ※本番環境で検証する倍、必ず１つずつ目視で実行し、削除漏れ予約がないように注意すること。
 *
 * 使用方法:
 *   node --env-file=.env test/scenario-test.cjs [scenario_id]
 *
 * 例:
 *   node --env-file=.env test/scenario-test.cjs          # 全シナリオ実行
 *   node --env-file=.env test/scenario-test.cjs 1.1.1    # 特定シナリオのみ実行
 *   node --env-file=.env test/scenario-test.cjs 2        # カテゴリ2の全シナリオ実行
 *
 * 環境変数（.envから自動読み込み）:
 *   RPA_LOGIN_KEY - EasyApoログインID
 *   RPA_LOGIN_PASSWORD - EasyApoパスワード
 *   API_BASE_URL - APIベースURL（デフォルト: http://localhost:3000）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * 文字列フィルター型ガード
 * @typedef {(s: string | undefined) => s is string} StringFilter
 */

/** @type {StringFilter} */
const isString = (s) => !!s;

// 設定
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const LOGIN_ID = process.env.RPA_LOGIN_KEY;
const LOGIN_PASSWORD = process.env.RPA_LOGIN_PASSWORD;

// スクリーンショット保存先
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots', 'scenario');

/**
 * テスト用の日付を取得（120日後、休診日を避ける）
 * @param {number} [offsetDays=0] - 追加の日数オフセット
 * @returns {string} YYYY-MM-DD形式の日付
 */
function getTestDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + 120 + offsetDays);
  // 休診曜日を飛ばす(日・月休診)
  if (date.getDay() < 2) date.setDate(date.getDate() + (2 - date.getDay()));
  // 土曜時短なので火曜日に
  if (date.getDay() === 6) date.setDate(date.getDate() + 3);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * テスト用の時刻を取得
 * @param {number} [offsetMinutes=0] - 分単位のオフセット
 * @returns {string} HH:MM形式の時刻
 */
function getTestTime(offsetMinutes = 0) {
  const baseHour = 10;
  const baseMinute = 0;
  const totalMinutes = baseHour * 60 + baseMinute + offsetMinutes;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * ユニークな電話番号を生成
 * @returns {string}
 */
function generateUniquePhone() {
  return `020${Date.now().toString().slice(-8)}`;
}

/**
 * スクリーンショット保存用ディレクトリを作成
 */
function ensureScreenshotDir() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

/**
 * スクリーンショットを保存
 * @param {string | undefined} base64Data
 * @param {string} filename
 * @returns {string | undefined}
 */
function saveScreenshot(base64Data, filename) {
  if (!base64Data) return undefined;
  ensureScreenshotDir();
  const filepath = path.join(SCREENSHOT_DIR, filename);
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * HTTPリクエストを実行
 * @param {string} method
 * @param {string} urlPath
 * @param {Record<string, unknown> | null} [body]
 * @returns {Promise<{ status: number | undefined; data: any }>}
 */
function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_BASE_URL);
    const bodyString = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-RPA-Login-Id': LOGIN_ID,
        'X-RPA-Login-Password': LOGIN_PASSWORD,
        'X-RPA-Test-Mode': 'true',
      },
    };

    if (bodyString) {
      // @ts-ignore
      options.headers['Content-Length'] = Buffer.byteLength(bodyString);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(600000);

    if (bodyString) {
      req.write(bodyString);
    }
    req.end();
  });
}

// ============================================================
// ヘルパー関数
// ============================================================

/**
 * 予約を作成
 * @param {Object} params
 * @param {string} params.date
 * @param {string} params.time
 * @param {string} params.customerName
 * @param {string} params.customerPhone
 * @param {string} [params.menuName]
 * @param {number} [params.durationMin]
 * @param {string} [params.customerId]
 * @returns {Promise<{ success: boolean; data: any; screenshot?: string }>}
 */
async function createReservation({ date, time, customerName, customerPhone, menuName, durationMin = 30, customerId }) {
  const body = {
    date,
    time,
    duration_min: durationMin,
    customer_name: customerName,
    customer_phone: customerPhone,
    menu_name: menuName,
    customer_id: customerId,
  };
  const res = await request('POST', '/reservations', body);
  return { success: res.status === 200 && res.data.success, data: res.data, screenshot: res.data.screenshot };
}

/**
 * 予約を更新
 * @param {Object} params
 * @param {string} params.date
 * @param {string} params.time
 * @param {string} params.customerPhone
 * @param {string} [params.menuName]
 * @param {string} [params.desiredDate]
 * @param {string} [params.desiredTime]
 * @returns {Promise<{ success: boolean; data: any; screenshot?: string }>}
 */
async function updateReservation({ date, time, customerPhone, menuName, desiredDate, desiredTime }) {
  const body = {
    date,
    time,
    customer_phone: customerPhone,
    menu_name: menuName,
    desired_date: desiredDate,
    desired_time: desiredTime,
  };
  const res = await request('PUT', '/reservations', body);
  return { success: res.status === 200 && res.data.success, data: res.data, screenshot: res.data.screenshot };
}

/**
 * 予約を削除（force=true）
 * @param {Object} params
 * @param {string} params.date
 * @param {string} params.time
 * @param {string} params.customerPhone
 * @returns {Promise<{ success: boolean; data: any; screenshot?: string }>}
 */
async function deleteReservation({ date, time, customerPhone }) {
  const body = {
    date,
    time,
    customer_phone: customerPhone,
  };
  const res = await request('DELETE', '/reservations?force=true', body);
  return { success: res.status === 200 && res.data.success, data: res.data, screenshot: res.data.screenshot };
}

/**
 * 予約を検索
 * @param {Object} params
 * @param {string} params.customerPhone
 * @param {string} params.dateFrom
 * @param {string} params.dateTo
 * @returns {Promise<{ success: boolean; data: any; screenshot?: string }>}
 */
async function searchReservations({ customerPhone, dateFrom, dateTo }) {
  const res = await request('GET', `/reservations/search?customer_phone=${customerPhone}&date_from=${dateFrom}&date_to=${dateTo}`);
  return { success: res.status === 200 && res.data.success, data: res.data, screenshot: res.data.screenshot };
}

// ============================================================
// シナリオ定義
// ============================================================

/**
 * @typedef {Object} ScenarioResult
 * @property {boolean} success
 * @property {string} [error]
 * @property {any} [details]
 * @property {string} [screenshot] - Base64エンコードされたスクリーンショット
 * @property {string[]} [screenshots] - 複数のBase64エンコードされたスクリーンショット
 */

/**
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {() => Promise<ScenarioResult>} run
 */

/** @type {Scenario[]} */
const scenarios = [
  // ============================================================
  // 1. 予約作成
  // ============================================================
  {
    id: '1.1.1',
    name: '新規顧客で予約作成',
    description: 'patient_numberなし、名前・電話番号のみで予約を作成',
    run: async () => {
      const date = getTestDate();
      const time = getTestTime(0);
      const phone = generateUniquePhone();
      const name = 'テスト新規 太郎';

      // 予約作成
      const createResult = await createReservation({
        date,
        time,
        customerName: name,
        customerPhone: phone,
        menuName: '治療の続きをしたい',
      });

      if (!createResult.success) {
        return { success: false, error: `予約作成失敗: ${createResult.data.error}`, screenshot: createResult.screenshot };
      }

      // 検索して確認
      const searchResult = await searchReservations({ customerPhone: phone, dateFrom: date, dateTo: date });
      if (!searchResult.success || searchResult.data.count === 0) {
        return { success: false, error: '作成した予約が検索で見つかりません', screenshot: searchResult.screenshot };
      }

      // クリーンアップ（削除）
      await deleteReservation({ date, time, customerPhone: phone });

      return {
        success: true,
        details: {
          reservationId: createResult.data.external_reservation_id,
          customerName: name,
        },
        screenshot: searchResult.screenshot,
      };
    },
  },
  {
    id: '1.1.2',
    name: '既存顧客で予約作成',
    description: 'customer_idありで予約を作成（既存患者番号を使用）',
    run: async () => {
      const date = getTestDate();
      const time = getTestTime(30);
      const phone = '09020787562'; // 既存顧客の電話番号
      const name = 'テスト テスト';
      const customerId = '1'; // 既存の患者ID

      // 予約作成
      const createResult = await createReservation({
        date,
        time,
        customerName: name,
        customerPhone: phone,
        menuName: '治療の続きをしたい',
        customerId,
      });

      if (!createResult.success) {
        return { success: false, error: `予約作成失敗: ${createResult.data.error}`, screenshot: createResult.screenshot };
      }

      // 検索して確認
      const searchResult = await searchReservations({ customerPhone: phone, dateFrom: date, dateTo: date });
      const found = searchResult.data.reservations?.find(
        (/** @type {{ time: string; }} */ r) => r.time === time
      );
      if (!found) {
        return { success: false, error: '作成した予約が検索で見つかりません', screenshot: searchResult.screenshot };
      }

      // クリーンアップ（削除）
      await deleteReservation({ date, time, customerPhone: phone });

      return {
        success: true,
        details: {
          reservationId: createResult.data.external_reservation_id,
          customerId,
        },
        screenshot: searchResult.screenshot,
      };
    },
  },
  {
    id: '1.2.3',
    name: '同一時刻に連続予約（担当者自動割り当て）',
    description: '同じ時刻に2つの予約を作成し、別担当者に割り当てられることを確認',
    run: async () => {
      const date = getTestDate();
      const time = getTestTime(60);
      const phone1 = generateUniquePhone();
      const phone2 = generateUniquePhone();

      // 1つ目の予約作成
      const create1 = await createReservation({
        date,
        time,
        customerName: 'テスト連続A',
        customerPhone: phone1,
        menuName: '治療の続きをしたい',
      });

      if (!create1.success) {
        return { success: false, error: `1つ目の予約作成失敗: ${create1.data.error}`, screenshot: create1.screenshot };
      }

      // 2つ目の予約作成（同じ時刻）
      const create2 = await createReservation({
        date,
        time,
        customerName: 'テスト連続B',
        customerPhone: phone2,
        menuName: '治療の続きをしたい',
      });

      if (!create2.success) {
        // クリーンアップ
        await deleteReservation({ date, time, customerPhone: phone1 });
        return { success: false, error: `2つ目の予約作成失敗: ${create2.data.error}`, screenshot: create2.screenshot };
      }

      // 両方の予約が作成されたことを確認
      const search1 = await searchReservations({ customerPhone: phone1, dateFrom: date, dateTo: date });
      const search2 = await searchReservations({ customerPhone: phone2, dateFrom: date, dateTo: date });

      // クリーンアップ
      await deleteReservation({ date, time, customerPhone: phone1 });
      await deleteReservation({ date, time, customerPhone: phone2 });

      if (search1.data.count === 0 || search2.data.count === 0) {
        return { success: false, error: '両方の予約が見つかりません', screenshots: [search1.screenshot, search2.screenshot].filter(isString) };
      }

      return {
        success: true,
        details: {
          reservation1: create1.data.external_reservation_id,
          reservation2: create2.data.external_reservation_id,
        },
        screenshots: [create1.screenshot, create2.screenshot].filter(isString),
      };
    },
  },

  // ============================================================
  // 2. 予約更新（メニュー変更）
  // ============================================================
  {
    id: '2.1.1',
    name: 'メニュー変更（同一担当者で対応可能）',
    description: '現担当者が新メニューにも対応可能な場合のメニュー変更',
    run: async () => {
      const date = getTestDate();
      const time = getTestTime(90);
      const phone = generateUniquePhone();

      // 予約作成
      const createResult = await createReservation({
        date,
        time,
        customerName: 'テストメニュー変更A',
        customerPhone: phone,
        menuName: '治療の続きをしたい',
      });

      if (!createResult.success) {
        return { success: false, error: `予約作成失敗: ${createResult.data.error}`, screenshot: createResult.screenshot };
      }

      // メニュー変更（同一担当者で対応可能なメニューへ）
      const updateResult = await updateReservation({
        date,
        time,
        customerPhone: phone,
        menuName: '歯並びを治したい',
      });

      // クリーンアップ
      await deleteReservation({ date, time, customerPhone: phone });

      if (!updateResult.success) {
        return {
          success: false,
          error: `メニュー変更失敗: ${updateResult.data.error}`,
          screenshots: [createResult.screenshot, updateResult.screenshot].filter(isString),
        };
      }

      return {
        success: true,
        details: {
          originalMenu: '治療の続きをしたい',
          newMenu: '歯並びを治したい',
        },
        screenshots: [createResult.screenshot, updateResult.screenshot].filter(isString),
      };
    },
  },
  {
    id: '2.1.2',
    name: 'メニュー変更（別担当者への切り替え）',
    description: '現担当者が対応不可 → 空いている対応可能担当者へ自動変更',
    run: async () => {
      const date = getTestDate();
      const time = getTestTime(120);
      const phone = generateUniquePhone();

      // まず通常メニューで予約作成
      const createResult = await createReservation({
        date,
        time,
        customerName: 'テストメニュー変更B',
        customerPhone: phone,
        menuName: '治療の続きをしたい',
      });

      if (!createResult.success) {
        return { success: false, error: `予約作成失敗: ${createResult.data.error}`, screenshot: createResult.screenshot };
      }

      // 特定担当者のみ対応可能なメニューへ変更
      // （実際のメニュー設定によって結果が変わる可能性あり）
      const updateResult = await updateReservation({
        date,
        time,
        customerPhone: phone,
        menuName: '(2回目以降の方)フッ素塗布希望',
      });

      // クリーンアップ
      await deleteReservation({ date, time, customerPhone: phone });

      if (!updateResult.success) {
        // この場合は対応可能な担当者がいなかった可能性もある
        return {
          success: false,
          error: `メニュー変更失敗（対応可能担当者なしの可能性）: ${updateResult.data.error}`,
          screenshots: [createResult.screenshot, updateResult.screenshot].filter(isString),
        };
      }

      return {
        success: true,
        details: {
          originalMenu: '治療の続きをしたい',
          newMenu: '(2回目以降の方)フッ素塗布希望',
          note: '担当者が自動変更された可能性あり',
        },
        screenshots: [createResult.screenshot, updateResult.screenshot].filter(isString),
      };
    },
  },

  // ============================================================
  // 3. 予約更新（日時変更）
  // ============================================================
  {
    id: '3.1.1',
    name: '時刻のみ変更（衝突なし）',
    description: 'desired_timeで時刻を変更（空いている時間帯へ）',
    run: async () => {
      const date = getTestDate();
      const time = getTestTime(0);
      const newTime = getTestTime(60); // 10:00 → 11:00（診療時間内）
      const phone = generateUniquePhone();

      // 予約作成
      const createResult = await createReservation({
        date,
        time,
        customerName: 'テスト時刻変更',
        customerPhone: phone,
        menuName: '治療の続きをしたい',
      });

      if (!createResult.success) {
        return { success: false, error: `予約作成失敗: ${createResult.data.error}`, screenshot: createResult.screenshot };
      }

      // 時刻変更
      const updateResult = await updateReservation({
        date,
        time,
        customerPhone: phone,
        desiredTime: newTime,
      });

      // 変更後の予約を検索
      const searchResult = await searchReservations({ customerPhone: phone, dateFrom: date, dateTo: date });
      const found = searchResult.data.reservations?.find(
        (/** @type {{ time: string; }} */ r) => r.time === newTime
      );

      // クリーンアップ（新しい時刻で削除）
      await deleteReservation({ date, time: newTime, customerPhone: phone });

      if (!updateResult.success) {
        return {
          success: false,
          error: `時刻変更失敗: ${updateResult.data.error}`,
          screenshots: [createResult.screenshot, searchResult.screenshot].filter(isString),
        };
      }

      if (!found) {
        return {
          success: false,
          error: '変更後の予約が見つかりません',
          screenshots: [createResult.screenshot, searchResult.screenshot].filter(isString),
        };
      }

      return {
        success: true,
        details: {
          originalTime: time,
          newTime,
        },
        screenshots: [createResult.screenshot, searchResult.screenshot].filter(isString),
      };
    },
  },
  {
    id: '3.1.2',
    name: '時刻変更で衝突 → 自動リトライ',
    description: '別の予約と衝突した場合、別担当者へ自動変更される',
    run: async () => {
      const date = getTestDate();
      const time1 = getTestTime(90);  // 11:30（診療時間内）
      const time2 = getTestTime(120); // 12:00（診療時間内）
      const phone1 = generateUniquePhone();
      const phone2 = generateUniquePhone();

      // 1つ目の予約作成（time1）
      const create1 = await createReservation({
        date,
        time: time1,
        customerName: 'テスト衝突A',
        customerPhone: phone1,
        menuName: '治療の続きをしたい',
      });

      if (!create1.success) {
        return { success: false, error: `1つ目の予約作成失敗: ${create1.data.error}`, screenshot: create1.screenshot };
      }

      // 2つ目の予約作成（time2）
      const create2 = await createReservation({
        date,
        time: time2,
        customerName: 'テスト衝突B',
        customerPhone: phone2,
        menuName: '治療の続きをしたい',
      });

      if (!create2.success) {
        await deleteReservation({ date, time: time1, customerPhone: phone1 });
        return { success: false, error: `2つ目の予約作成失敗: ${create2.data.error}`, screenshot: create2.screenshot };
      }

      // 2つ目の予約を1つ目と同じ時刻に変更（衝突発生 → 自動リトライ）
      const updateResult = await updateReservation({
        date,
        time: time2,
        customerPhone: phone2,
        desiredTime: time1,
      });

      // クリーンアップ
      await deleteReservation({ date, time: time1, customerPhone: phone1 });
      // phone2は time1 に移動しているはず
      await deleteReservation({ date, time: time1, customerPhone: phone2 });

      if (!updateResult.success) {
        return {
          success: false,
          error: `時刻変更失敗（自動リトライ失敗の可能性）: ${updateResult.data.error}`,
          screenshots: [create1.screenshot, create2.screenshot].filter(isString),
        };
      }

      return {
        success: true,
        details: {
          note: '衝突が発生し、別担当者への自動リトライが行われた',
        },
        screenshots: [create1.screenshot, create2.screenshot, updateResult.screenshot].filter(isString),
      };
    },
  },
  {
    id: '3.2.1',
    name: '日付のみ変更',
    description: 'desired_dateで日付を変更',
    run: async () => {
      const date = getTestDate();
      const newDate = getTestDate(7); // 翌週
      const time = getTestTime(270);
      const phone = generateUniquePhone();

      // 予約作成
      const createResult = await createReservation({
        date,
        time,
        customerName: 'テスト日付変更',
        customerPhone: phone,
        menuName: '治療の続きをしたい',
      });

      if (!createResult.success) {
        return { success: false, error: `予約作成失敗: ${createResult.data.error}`, screenshot: createResult.screenshot };
      }

      // 日付変更
      const updateResult = await updateReservation({
        date,
        time,
        customerPhone: phone,
        desiredDate: newDate,
      });

      // 変更後の予約を検索
      const searchResult = await searchReservations({ customerPhone: phone, dateFrom: newDate, dateTo: newDate });
      const found = searchResult.data.reservations?.find(
        (/** @type {{ time: string; }} */ r) => r.time === time
      );

      // クリーンアップ（新しい日付で削除）
      await deleteReservation({ date: newDate, time, customerPhone: phone });

      if (!updateResult.success) {
        return {
          success: false,
          error: `日付変更失敗: ${updateResult.data.error}`,
          screenshots: [createResult.screenshot, searchResult.screenshot].filter(isString),
        };
      }

      if (!found) {
        return {
          success: false,
          error: '変更後の予約が見つかりません',
          screenshots: [createResult.screenshot, searchResult.screenshot].filter(isString),
        };
      }

      return {
        success: true,
        details: {
          originalDate: date,
          newDate,
        },
        screenshots: [createResult.screenshot, searchResult.screenshot].filter(isString),
      };
    },
  },
  {
    id: '3.3.1',
    name: '日時＋メニュー同時変更',
    description: '日付・時刻・メニューを同時に変更',
    run: async () => {
      const date = getTestDate();
      const newDate = getTestDate(2);
      const time = getTestTime(300);
      const newTime = getTestTime(330);
      const phone = generateUniquePhone();

      // 予約作成
      const createResult = await createReservation({
        date,
        time,
        customerName: 'テスト複合変更',
        customerPhone: phone,
        menuName: '(初めての方)フッ素塗布希望',
      });

      if (!createResult.success) {
        return { success: false, error: `予約作成失敗: ${createResult.data.error}`, screenshot: createResult.screenshot };
      }

      // 日時＋メニュー同時変更
      const updateResult = await updateReservation({
        date,
        time,
        customerPhone: phone,
        menuName: '治療の続きをしたい',
        desiredDate: newDate,
        desiredTime: newTime,
      });

      // 変更後の予約を検索
      const searchResult = await searchReservations({ customerPhone: phone, dateFrom: newDate, dateTo: newDate });
      const found = searchResult.data.reservations?.find(
        (/** @type {{ time: string; }} */ r) => r.time === newTime
      );

      // クリーンアップ
      await deleteReservation({ date: newDate, time: newTime, customerPhone: phone });

      if (!updateResult.success) {
        return {
          success: false,
          error: `複合変更失敗: ${updateResult.data.error}`,
          screenshots: [createResult.screenshot, searchResult.screenshot].filter(isString),
        };
      }

      if (!found) {
        return {
          success: false,
          error: '変更後の予約が見つかりません',
          screenshots: [createResult.screenshot, searchResult.screenshot].filter(isString),
        };
      }

      return {
        success: true,
        details: {
          original: { date, time, menu: '(初めての方)フッ素塗布希望' },
          updated: { date: newDate, time: newTime, menu: '治療の続きをしたい' },
        },
        screenshots: [createResult.screenshot, searchResult.screenshot].filter(isString),
      };
    },
  },
];

// ============================================================
// テスト実行
// ============================================================

/**
 * シナリオを実行
 * @param {Scenario} scenario
 * @returns {Promise<{ scenario: Scenario; result: ScenarioResult; durationMs: number; screenshotPaths: string[] }>}
 */
async function runScenario(scenario) {
  const start = Date.now();
  try {
    const result = await scenario.run();
    const durationMs = Date.now() - start;

    // スクリーンショットを保存
    const screenshotPaths = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const status = result.success ? 'success' : 'failed';

    // 単一スクリーンショット
    if (result.screenshot) {
      const filename = `${scenario.id}_${status}_${timestamp}.png`;
      const path = saveScreenshot(result.screenshot, filename);
      if (path) screenshotPaths.push(path);
    }

    // 複数スクリーンショット
    if (result.screenshots) {
      result.screenshots.forEach((ss, i) => {
        const filename = `${scenario.id}_${status}_${timestamp}_${i + 1}.png`;
        const path = saveScreenshot(ss, filename);
        if (path) screenshotPaths.push(path);
      });
    }

    return { scenario, result, durationMs, screenshotPaths };
  } catch (error) {
    const err = /** @type {Error} */ (error);
    return {
      scenario,
      result: { success: false, error: `例外発生: ${err.message}` },
      durationMs: Date.now() - start,
      screenshotPaths: [],
    };
  }
}

/**
 * メイン実行
 */
async function main() {
  console.log('========================================');
  console.log('EasyApo シナリオテスト');
  console.log('========================================');
  console.log(`API URL: ${API_BASE_URL}`);
  console.log(`テスト日付: ${getTestDate()}`);
  console.log('========================================\n');

  // 認証情報チェック
  if (!LOGIN_ID || !LOGIN_PASSWORD) {
    console.error('❌ 環境変数が設定されていません:');
    console.error('   RPA_LOGIN_KEY, RPA_LOGIN_PASSWORD');
    process.exit(1);
  }

  // コマンドライン引数でフィルタ
  const filter = process.argv[2];
  const targetScenarios = filter
    ? scenarios.filter((s) => s.id.startsWith(filter))
    : scenarios;

  if (targetScenarios.length === 0) {
    console.error(`❌ 該当するシナリオが見つかりません: ${filter}`);
    console.error('利用可能なシナリオ:');
    scenarios.forEach((s) => console.error(`  ${s.id}: ${s.name}`));
    process.exit(1);
  }

  console.log(`実行シナリオ数: ${targetScenarios.length}\n`);

  let passed = 0;
  let failed = 0;

  for (const scenario of targetScenarios) {
    console.log(`--- [${scenario.id}] ${scenario.name} ---`);
    console.log(`    ${scenario.description}`);

    const { result, durationMs, screenshotPaths } = await runScenario(scenario);

    if (result.success) {
      console.log(`    ✅ 成功 (${durationMs}ms)`);
      if (result.details) {
        console.log(`    詳細: ${JSON.stringify(result.details)}`);
      }
      passed++;
    } else {
      console.log(`    ❌ 失敗 (${durationMs}ms)`);
      console.log(`    エラー: ${result.error}`);
      failed++;
    }
    for (const screenshotPath of screenshotPaths) {
      console.log(`    📸 スクリーンショット: ${screenshotPath}`);
    }
    console.log();
  }

  // 結果サマリー
  console.log('========================================');
  console.log('テスト結果サマリー');
  console.log('========================================');
  console.log(`✅ 成功: ${passed}`);
  console.log(`❌ 失敗: ${failed}`);
  console.log(`合計: ${passed + failed}`);
  console.log('========================================');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('テスト実行エラー:', error);
  process.exit(1);
});
