/**
 * 常駐ブラウザサーバー
 *
 * ログイン済みブラウザを常駐させ、リクエストを高速に処理する
 * 認証情報はリクエストヘッダーから動的に取得
 *
 * エンドポイント:
 *   GET  /health - ヘルスチェック
 *   GET  /status - 詳細ステータス
 *   GET  /slots - 空き枠取得
 *   GET  /reservations/search - 予約検索
 *   POST /reservations - 予約作成
 *   DELETE /reservations - 予約キャンセル
 *   POST /session/restart - セッション再起動
 *
 * 使用方法:
 *   npm run start:persistent
 */

import express, { type Request, type Response } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { Mutex } from 'async-mutex';
import { ScreenshotManager } from '@smartcall/rpa-sdk';
import {
  BrowserSessionManager,
  type Credentials,
  type SessionState,
} from './lib/BrowserSessionManager.js';
import { type ReservationRequest, AppointPage } from './pages/AppointPage.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// 設定
const PORT = process.env.PORT || 3000;
const KEEP_ALIVE_INTERVAL_MS = parseInt(
  process.env.KEEP_ALIVE_INTERVAL_MS || '300000',
  10
); // 5分
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.REQUEST_TIMEOUT_MS || '60000',
  10
); // 60秒（電話中のリアルタイム処理のため短縮）
const BASE_URL = 'https://cieasyapo2.ci-medical.com';

// セッションマネージャー（後から認証情報を設定するため、nullableに）
let sessionManager: BrowserSessionManager | null = null;
let currentCredentials: Credentials | null = null;

// セッション初期化用Mutex（複数リクエストの競合防止）
const sessionInitMutex = new Mutex();

// CORS許可オリジン（環境変数で制限可能）
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];

// Express アプリ
const app = express();
app.use(express.json());

// CORS対応（管理画面からのリクエストを許可）
app.use((req: Request, res: Response, next) => {
  const origin = req.headers.origin as string | undefined;

  // 許可するオリジンを判定
  if (ALLOWED_ORIGINS.includes('*')) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, X-RPA-Login-Id, X-RPA-Login-Password, X-RPA-Test-Mode'
  );
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  // Preflightリクエストへの対応
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }

  next();
});

/**
 * リクエストヘッダーから認証情報を取得
 */
function getCredentialsFromRequest(
  req: Request,
): {
  credentials: Credentials;
} | null {
  const loginKey = req.headers['x-rpa-login-id'] as string;
  const loginPassword = req.headers['x-rpa-login-password'] as string;

  if (!loginKey || !loginPassword) {
    return null;
  }

  return {
    credentials: { loginKey, loginPassword }
  };
}

/**
 * 認証情報が変更されたかチェック
 */
function hasCredentialsChanged(
  credentials: Credentials
): boolean {
  if (!currentCredentials) {
    return true;
  }

  return (
    currentCredentials.loginKey !== credentials.loginKey ||
    currentCredentials.loginPassword !== credentials.loginPassword
  );
}

/**
 * セッションマネージャーを初期化または再初期化
 * Mutexで保護し、複数リクエストの競合を防止
 */
async function ensureSessionManager(
  credentials: Credentials
): Promise<void> {
  // 初期化処理全体をMutexで保護（複数リクエストの競合防止）
  const release = await sessionInitMutex.acquire();
  try {
    // 認証情報が変更された場合は再初期化
    if (hasCredentialsChanged(credentials)) {
      console.log(
        `[Server] Credentials changed, reinitializing session...`
      );

      // 既存セッションをクローズ（ゾンビプロセス防止）
      if (sessionManager) {
        const oldSession = sessionManager;
        sessionManager = null; // 先に参照をクリア
        // EventEmitterリスナーを削除（メモリリーク防止）
        oldSession.removeAllListeners();
        try {
          await oldSession.close();
        } catch (error) {
          console.error('[Server] Error closing old session, forcing cleanup...', error);
          // close()が失敗した場合、forceClose()でリソースをクリーンアップ
          await oldSession.forceClose();
        }
      }

      // 新しいセッションマネージャーを作成
      sessionManager = new BrowserSessionManager({
        credentials,
        baseUrl: BASE_URL,
        headless: process.env.HEADLESS !== 'false',
        viewport: { width: 1800, height: 1300 },
        keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
      });

      // イベントハンドラー設定
      setupSessionEvents(sessionManager);

      // セッション開始
      await sessionManager.start();

      // 現在の認証情報を保存
      currentCredentials = credentials;

      console.log(`[Server] Session initialized`);
    }
  } finally {
    release();
  }
}

/**
 * セッションイベントハンドラーを設定
 */
function setupSessionEvents(manager: BrowserSessionManager): void {
  manager.on(
    'stateChange',
    (state: SessionState, previousState: SessionState) => {
      console.log(
        `[Server] Session state: ${previousState} -> ${state}`
      );
    }
  );

  manager.on('error', (error: Error) => {
    console.error('[Server] Session error:', error);
  });

  manager.on('sessionExpired', () => {
    console.warn('[Server] Session expired, recovering...');
  });

  manager.on('recovered', () => {
    console.log('[Server] Session recovered');
  });
}

/**
 * ヘルスチェックエンドポイント
 */
app.get('/health', (_req: Request, res: Response) => {
  const state = sessionManager?.getState() || 'not_initialized';

  res.json({
    status: state === 'ready' || state === 'busy' ? 'ok' : 'degraded',
    session_state: state,
    has_credentials: currentCredentials !== null,
  });
});

/**
 * 詳細ステータスエンドポイント
 */
app.get('/status', (_req: Request, res: Response) => {
  res.json({
    session: {
      state: sessionManager?.getState() || 'not_initialized',
      last_activity: sessionManager?.getLastActivityTime()?.toISOString() || null,
    },
    config: {
      keep_alive_interval_ms: KEEP_ALIVE_INTERVAL_MS,
      request_timeout_ms: REQUEST_TIMEOUT_MS,
    },
  });
});

/**
 * 空き枠取得エンドポイント
 * GET /slots?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&resources=Dr1,Dr2&duration=30
 */
type SlotsQuery = Record<string, string | undefined> & {
  /** 開始日（YYYY-MM-DD形式、省略時は今日） */
  date_from?: string;
  /** 終了日（YYYY-MM-DD形式、省略時はdate_fromと同じ） */
  date_to?: string;
  /** 対象リソース名（カンマ区切り、省略時は全リソース） */
  resources?: string;
  /** 所要時間（分）。指定した場合、同一担当者で連続して確保できる枠のみを返す */
  duration?: string;
  /** 外部メニューID - オプション */
  external_menu_id?: string;
  /** メニュー名 - オプション */
  menu_name?: string;
}

app.get('/slots', async (req: Request<ParamsDictionary, unknown, unknown, SlotsQuery>, res: Response) => {
  const authInfo = getCredentialsFromRequest(req);
  if (!authInfo) {
    res.status(401).json({
      success: false,
      error: 'Missing authentication headers. Required: X-RPA-Login-Id, X-RPA-Login-Password',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  const dateFrom = req.query.date_from || dayjs().tz('Asia/Tokyo').format('YYYY-MM-DD');
  const dateTo = req.query.date_to || dateFrom;
  const resourcesParam = req.query.resources;
  const resources = resourcesParam ? resourcesParam.split(',').map(r => r.trim()) : undefined;
  const durationParam = req.query.duration;
  const duration = durationParam ? parseInt(durationParam, 10) : undefined;
  const menu = (req.query.external_menu_id || req.query.menu_name) ? {
    external_menu_id: req.query.external_menu_id,
    menu_name: req.query.menu_name || '',
  } : undefined;
  const isTestMode = req.headers['x-rpa-test-mode'] === 'true';

  try {
    await ensureSessionManager(authInfo.credentials);

    if (!sessionManager) {
      res.status(503).json({
        success: false,
        error: 'Session not initialized',
        code: 'SESSION_NOT_READY',
      });
      return;
    }

    const startTime = Date.now();

    // Mutex付きでページを使用（同時リクエストを排他制御）
    const result = await sessionManager.withPage(async (page) => {
      const screenshot = new ScreenshotManager('./screenshots');
      const appointPage = new AppointPage(page, screenshot);
      await appointPage.navigate(BASE_URL);

      // 空き枠を取得
      const slots = await appointPage.getAvailableSlots({ dateFrom, dateTo, resources, duration, menu });

      // テストモードの場合はスクリーンショットを取得
      let screenshotBase64: string | undefined;
      if (isTestMode) {
        try {
          await page.waitForTimeout(500);
          const screenshotBuffer = await page.screenshot({ fullPage: false });
          screenshotBase64 = screenshotBuffer.toString('base64');
        } catch (screenshotError) {
          console.error('[Server] Screenshot failed:', screenshotError);
        }
      }

      return { slots, screenshotBase64 };
    }, REQUEST_TIMEOUT_MS);

    const response: Record<string, unknown> = {
      success: true,
      available_slots: result.slots,
      count: result.slots.length,
      timing: { total_ms: Date.now() - startTime },
    };

    if (result.screenshotBase64) {
      response.screenshot = result.screenshotBase64;
    }

    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Server] /slots error:', error);
    res.status(500).json({
      success: false,
      error: message,
      code: 'PROCESSING_ERROR',
    });
  }
});

/**
 * 診療メニュー取得エンドポイント
 * GET /menu
 */
app.get('/menu', async (req: Request, res: Response) => {
  const authInfo = getCredentialsFromRequest(req);
  if (!authInfo) {
    res.status(401).json({
      success: false,
      error: 'Missing authentication headers. Required: X-RPA-Login-Id, X-RPA-Login-Password',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  const isTestMode = req.headers['x-rpa-test-mode'] === 'true';

  try {
    await ensureSessionManager(authInfo.credentials);

    if (!sessionManager) {
      res.status(503).json({
        success: false,
        error: 'Session not initialized',
        code: 'SESSION_NOT_READY',
      });
      return;
    }

    const startTime = Date.now();

    const result = await sessionManager.withPage(async (page) => {
      const screenshot = new ScreenshotManager('./screenshots');
      const appointPage = new AppointPage(page, screenshot);
      await appointPage.navigate(BASE_URL);

      const treatmentItems = await appointPage.getTreatmentItems();

      let screenshotBase64: string | undefined;
      if (isTestMode) {
        try {
          await page.waitForTimeout(500);
          const screenshotBuffer = await page.screenshot({ fullPage: false });
          screenshotBase64 = screenshotBuffer.toString('base64');
        } catch (screenshotError) {
          console.error('[Server] Screenshot failed:', screenshotError);
        }
      }

      return { treatmentItems, screenshotBase64 };
    }, REQUEST_TIMEOUT_MS);

    // MenuInfoに近い形式に変換
    const menu = result.treatmentItems.map((item) => ({
      external_menu_id: item.id ? String(item.id) : undefined,
      menu_name: item.title,
      duration_min: item.treatment_time,
      resources: item.resources,
      resource_ids: item.use_column,
    }));

    const response: Record<string, unknown> = {
      success: true,
      menu,
      count: menu.length,
      timing: { total_ms: Date.now() - startTime },
    };

    if (result.screenshotBase64) {
      response.screenshot = result.screenshotBase64;
    }

    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Server] /menu error:', error);
    res.status(500).json({
      success: false,
      error: message,
      code: 'PROCESSING_ERROR',
    });
  }
});

/**
 * 予約検索エンドポイント
 * GET /reservations/search?customer_phone=XXX&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 */
type ReservationsSearchQuery = Record<string, string | undefined> & {
  /** 検索する電話番号（必須） */
  customer_phone?: string;
  /** 開始日（YYYY-MM-DD形式、省略時は今日） */
  date_from?: string;
  /** 終了日（YYYY-MM-DD形式、省略時はdate_fromと同じ） */
  date_to?: string;
}

app.get('/reservations/search', async (req: Request<ParamsDictionary, unknown, unknown, ReservationsSearchQuery>, res: Response) => {
  // 認証情報をヘッダーから取得
  const authInfo = getCredentialsFromRequest(req);
  if (!authInfo) {
    res.status(401).json({
      success: false,
      error:
        'Missing authentication headers. Required: X-RPA-Login-Id, X-RPA-Login-Password',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  const customerPhone = req.query.customer_phone;
  if (!customerPhone) {
    res.status(400).json({
      success: false,
      error: 'Missing required parameter: customer_phone',
      code: 'INVALID_REQUEST',
    });
    return;
  }

  const dateFrom = req.query.date_from || dayjs().tz('Asia/Tokyo').format('YYYY-MM-DD');
  const dateTo = req.query.date_to || dateFrom;
  const isTestMode = req.headers['x-rpa-test-mode'] === 'true';

  try {
    // セッションを確保
    await ensureSessionManager(authInfo.credentials);

    if (!sessionManager) {
      res.status(503).json({
        success: false,
        error: 'Session not initialized',
        code: 'SESSION_NOT_READY',
      });
      return;
    }

    const startTime = Date.now();

    // Mutex付きでページを使用（同時リクエストを排他制御）
    const result = await sessionManager.withPage(async (page) => {
      const screenshot = new ScreenshotManager('./screenshots');
      const appointPage = new AppointPage(page, screenshot);

      // アポイント管理画面に遷移
      await appointPage.navigate(BASE_URL);

      // 電話番号で予約を検索
      const reservations = await appointPage.searchReservationsByPhone(
        dateFrom,
        dateTo,
        customerPhone
      );

      // テストモードの場合はスクリーンショットを取得
      let screenshotBase64: string | undefined;
      if (isTestMode) {
        try {
          await page.waitForTimeout(500);
          const screenshotBuffer = await page.screenshot({ fullPage: false });
          screenshotBase64 = screenshotBuffer.toString('base64');
          console.log(
            `[Server] Test screenshot captured: ${(screenshotBuffer.length / 1024).toFixed(1)}KB`
          );
        } catch (screenshotError) {
          console.error(
            '[Server] Failed to capture test screenshot:',
            screenshotError
          );
        }
      }

      return { reservations, screenshotBase64 };
    }, REQUEST_TIMEOUT_MS);

    const response: Record<string, unknown> = {
      success: true,
      reservations: result.reservations,
      count: result.reservations.length,
      timing: {
        total_ms: Date.now() - startTime,
      },
    };

    if (result.screenshotBase64) {
      response.screenshot = result.screenshotBase64;
    }

    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Server] /reservations/search error:', error);
    res.status(500).json({
      success: false,
      error: message,
      code: 'PROCESSING_ERROR',
    });
  }
});

/**
 * 予約作成エンドポイント
 * POST /reservations
 */
type ReservationCreateBody = {
  /** 予約日（YYYY-MM-DD形式） */
  date: string;
  /** 予約時刻（HH:MM形式） */
  time: string;
  /** 所要時間（分）- オプション */
  duration_min?: number;
  /** 顧客ID（患者ID）- オプション */
  customer_id?: string;
  /** 顧客名 */
  customer_name: string;
  /** 顧客電話番号 */
  customer_phone: string;
  /** メニュー名 - オプション */
  menu_name?: string;
  /** 外部メニューID - オプション */
  external_menu_id?: string;
}

app.post('/reservations', async (req: Request<ParamsDictionary, unknown, ReservationCreateBody>, res: Response) => {
  const authInfo = getCredentialsFromRequest(req);
  if (!authInfo) {
    res.status(401).json({
      success: false,
      error: 'Missing authentication headers. Required: X-RPA-Login-Id, X-RPA-Login-Password',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  const { date, time, duration_min, customer_id, customer_name, customer_phone, menu_name, external_menu_id } = req.body;
  console.log(`[DEBUG] POST /reservations: req.body=${JSON.stringify(req.body)}`);
  console.log(`[DEBUG] POST /reservations: external_menu_id=${external_menu_id}, menu_name=${menu_name}`);
  const isTestMode = req.headers['x-rpa-test-mode'] === 'true';

  if (!date || !time || !customer_name || !customer_phone) {
    res.status(400).json({
      success: false,
      error: 'Missing required parameters: date, time, customer_name, customer_phone',
      code: 'INVALID_REQUEST',
    });
    return;
  }

  try {
    await ensureSessionManager(authInfo.credentials);

    if (!sessionManager) {
      res.status(503).json({
        success: false,
        error: 'Session not initialized',
        code: 'SESSION_NOT_READY',
      });
      return;
    }

    const startTime = Date.now();

    // Mutex付きでページを使用（同時リクエストを排他制御）
    const result = await sessionManager.withPage(async (page) => {
      const screenshot = new ScreenshotManager('./screenshots');
      const appointPage = new AppointPage(page, screenshot);
      await appointPage.navigate(BASE_URL);

      // 予約を作成
      const durationMinutes = duration_min;
      const startTime = dayjs(`${date} ${time}`, 'YYYY-MM-DD HH:mm');
      const endTime = durationMinutes ? startTime.add(durationMinutes, 'minute') : undefined;
      const reservations = [{
        reservation_id: `create_${Date.now()}`,
        operation: 'create' as const,
        slot: {
          date,
          start_at: time,
          end_at: endTime?.format('HH:mm'),
          duration_min: durationMinutes,
        },
        customer: { customer_id: String(customer_id  || ''), name: customer_name, phone: customer_phone },
        menu: { menu_id: '', external_menu_id: external_menu_id || '', menu_name: menu_name || '' },
        staff: { staff_id: '', external_staff_id: '', resource_name: '', preference: 'any' as const },
      }] satisfies ReservationRequest[];

      const results = await appointPage.processReservations(reservations);
      const processResult = results[0];

      // テストモードの場合はスクリーンショットを取得
      let screenshotBase64: string | undefined;
      if (isTestMode) {
        try {
          await page.waitForTimeout(500);
          const screenshotBuffer = await page.screenshot({ fullPage: false });
          screenshotBase64 = screenshotBuffer.toString('base64');
        } catch (screenshotError) {
          console.error('[Server] Screenshot failed:', screenshotError);
        }
      }

      return { processResult, screenshotBase64 };
    }, REQUEST_TIMEOUT_MS);

    const response: Record<string, unknown> = {
      success: result.processResult.result.status === 'success',
      reservation_id: result.processResult.reservation_id,
      external_reservation_id: result.processResult.result.external_reservation_id,
      duration_min: result.processResult.result.duration_min,
      error: result.processResult.result.status !== 'success' ? result.processResult.result.error_message : undefined,
      error_code: result.processResult.result.error_code,
      timing: { total_ms: Date.now() - startTime },
    };

    if (result.screenshotBase64) {
      response.screenshot = result.screenshotBase64;
    }

    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Server] POST /reservations error:', error);
    res.status(500).json({
      success: false,
      error: message,
      code: 'PROCESSING_ERROR',
    });
  }
});

/**
 * 予約更新エンドポイント
 * PUT /reservations
 *
 * 既存の予約を検索し、メニュー名（患者メモ）を更新する
 */
type ReservationUpdateBody = {
  /** 予約日（YYYY-MM-DD形式） */
  date: string;
  /** 予約時刻（HH:MM形式） */
  time: string;
  /** 顧客名 - オプション（音声認識の精度問題で不要に） */
  customer_name?: string;
  /** 顧客電話番号 */
  customer_phone: string;
  /** メニュー名 - オプション */
  menu_name?: string;
  /** 外部メニューID - オプション */
  external_menu_id?: string;
  /** 変更後の希望日（YYYY-MM-DD形式） - オプション */
  desired_date?: string;
  /** 変更後の希望時刻（HH:MM形式） - オプション */
  desired_time?: string;
}

app.put('/reservations', async (req: Request<ParamsDictionary, unknown, ReservationUpdateBody>, res: Response) => {
  const authInfo = getCredentialsFromRequest(req);
  if (!authInfo) {
    res.status(401).json({
      success: false,
      error: 'Missing authentication headers. Required: X-RPA-Login-Id, X-RPA-Login-Password',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  const { date, time, customer_name, customer_phone, menu_name, external_menu_id, desired_date, desired_time } = req.body;
  const isTestMode = req.headers['x-rpa-test-mode'] === 'true';

  // customer_nameはオプション（音声認識の精度問題で不要に）
  if (!date || !time || !customer_phone) {
    res.status(400).json({
      success: false,
      error: 'Missing required parameters: date, time, customer_phone',
      code: 'INVALID_REQUEST',
    });
    return;
  }

  try {
    await ensureSessionManager(authInfo.credentials);

    if (!sessionManager) {
      res.status(503).json({
        success: false,
        error: 'Session not initialized',
        code: 'SESSION_NOT_READY',
      });
      return;
    }

    const startTime = Date.now();

    // Mutex付きでページを使用（同時リクエストを排他制御）
    const result = await sessionManager.withPage(async (page) => {
      const screenshot = new ScreenshotManager('./screenshots');
      const appointPage = new AppointPage(page, screenshot);
      await appointPage.navigate(BASE_URL);

      // 予約を更新
      const reservations = [{
        reservation_id: `update_${Date.now()}`,
        operation: 'update' as const,
        slot: {
          date,
          start_at: time,
          end_at: '',
          duration_min: 0,
          desired: {
            date: desired_date,
            time: desired_time,
          },
        },
        customer: { name: customer_name || '', phone: customer_phone },
        menu: { menu_id: '', external_menu_id: external_menu_id || '', menu_name: menu_name || '' },
        staff: { staff_id: '', external_staff_id: '', resource_name: '', preference: 'any' as const },
      }] satisfies ReservationRequest[];

      const results = await appointPage.processReservations(reservations);
      const processResult = results[0];

      // テストモードの場合はスクリーンショットを取得
      let screenshotBase64: string | undefined;
      if (isTestMode) {
        try {
          await page.waitForTimeout(500);
          const screenshotBuffer = await page.screenshot({ fullPage: false });
          screenshotBase64 = screenshotBuffer.toString('base64');
        } catch (screenshotError) {
          console.error('[Server] Screenshot failed:', screenshotError);
        }
      }

      return { processResult, screenshotBase64 };
    }, REQUEST_TIMEOUT_MS);

    const response: Record<string, unknown> = {
      success: result.processResult.result.status === 'success',
      reservation_id: result.processResult.reservation_id,
      external_reservation_id: result.processResult.result.external_reservation_id,
      error: result.processResult.result.status !== 'success' ? result.processResult.result.error_message : undefined,
      error_code: result.processResult.result.error_code,
      timing: { total_ms: Date.now() - startTime },
    };

    if (result.screenshotBase64) {
      response.screenshot = result.screenshotBase64;
    }

    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Server] PUT /reservations error:', error);
    res.status(500).json({
      success: false,
      error: message,
      code: 'PROCESSING_ERROR',
    });
  }
});

/**
 * 予約キャンセルエンドポイント
 * DELETE /reservations
 */
type ReservationCancelBody = {
  /** 予約日（YYYY-MM-DD形式） */
  date: string;
  /** 予約時刻（HH:MM形式） */
  time: string;
  /** 顧客名 - オプション（音声認識の精度問題で不要に） */
  customer_name?: string;
  /** 顧客電話番号 */
  customer_phone: string;
}

type ReservationCancelQuery = {
  /** 強制削除フラグ（tureが指定された場合は削除扱い、それ以外・未指定の場合はキャンセル） */
  force?: string;
}

app.delete('/reservations', async (req: Request<ParamsDictionary, unknown, ReservationCancelBody, ReservationCancelQuery>, res: Response) => {
  const authInfo = getCredentialsFromRequest(req);
  if (!authInfo) {
    res.status(401).json({
      success: false,
      error: 'Missing authentication headers. Required: X-RPA-Login-Id, X-RPA-Login-Password',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  const { date, time, customer_name, customer_phone } = req.body;
  const isTestMode = req.headers['x-rpa-test-mode'] === 'true';

  // customer_nameはオプション（音声認識の精度問題で不要に）
  if (!date || !time || !customer_phone) {
    res.status(400).json({
      success: false,
      error: 'Missing required parameters: date, time, customer_phone',
      code: 'INVALID_REQUEST',
    });
    return;
  }

  try {
    await ensureSessionManager(authInfo.credentials);

    if (!sessionManager) {
      res.status(503).json({
        success: false,
        error: 'Session not initialized',
        code: 'SESSION_NOT_READY',
      });
      return;
    }

    const startTime = Date.now();

    // Mutex付きでページを使用（同時リクエストを排他制御）
    const result = await sessionManager.withPage(async (page) => {
      const screenshot = new ScreenshotManager('./screenshots');
      const appointPage = new AppointPage(page, screenshot);
      await appointPage.navigate(BASE_URL);

      // 予約をキャンセル
      const reservations = [{
        reservation_id: `cancel_${Date.now()}`,
        operation: (req.query.force === 'true' ? 'delete' as const : 'cancel' as const),
        slot: { date, start_at: time, end_at: '', duration_min: 0 },
        customer: { name: customer_name || '', phone: customer_phone },
        menu: { menu_id: '', external_menu_id: '', menu_name: '' },
        staff: { staff_id: '', external_staff_id: '', resource_name: '', preference: 'any' as const },
      }];

      const results = await appointPage.processReservations(reservations);
      const processResult = results[0];

      // テストモードの場合はスクリーンショットを取得
      let screenshotBase64: string | undefined;
      if (isTestMode) {
        try {
          await page.waitForTimeout(500);
          const screenshotBuffer = await page.screenshot({ fullPage: false });
          screenshotBase64 = screenshotBuffer.toString('base64');
        } catch (screenshotError) {
          console.error('[Server] Screenshot failed:', screenshotError);
        }
      }

      return { processResult, screenshotBase64 };
    }, REQUEST_TIMEOUT_MS);

    const response: Record<string, unknown> = {
      success: result.processResult.result.status === 'success',
      reservation_id: result.processResult.reservation_id,
      error: result.processResult.result.status !== 'success' ? result.processResult.result.error_message : undefined,
      error_code: result.processResult.result.error_code,
      timing: { total_ms: Date.now() - startTime },
    };

    if (result.screenshotBase64) {
      response.screenshot = result.screenshotBase64;
    }

    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Server] DELETE /reservations error:', error);
    res.status(500).json({
      success: false,
      error: message,
      code: 'PROCESSING_ERROR',
    });
  }
});

/**
 * セッション再起動エンドポイント
 */
app.post('/session/restart', async (req: Request, res: Response) => {
  // 認証情報をヘッダーから取得
  const authInfo = getCredentialsFromRequest(req);
  if (!authInfo) {
    res.status(401).json({
      success: false,
      error:
        'Missing authentication headers. Required: X-RPA-Login-Id, X-RPA-Login-Password',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  const isTestMode = req.headers['x-rpa-test-mode'] === 'true';

  try {
    console.log(
      '[Server] Session restart requested'
    );

    // 強制的に再初期化するために現在の認証情報をクリア
    currentCredentials = null;

    await ensureSessionManager(authInfo.credentials);

    // ログイン後のスクリーンショットを撮影（Mutex付き）
    let screenshotBase64: string | null = null;
    if (sessionManager && isTestMode) {
      try {
        screenshotBase64 = await sessionManager.withPage(async (page) => {
          await page.waitForTimeout(500);
          const buffer = await page.screenshot({ type: 'png' });
          return buffer.toString('base64');
        }, REQUEST_TIMEOUT_MS);
      } catch (screenshotError) {
        console.error('[Server] Screenshot failed:', screenshotError);
      }
    }

    res.json({
      success: true,
      message: 'Session restarted',
      screenshot: screenshotBase64,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Server] /session/restart error:', error);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * デバッグ用エンドポイント - DOM取得とスクリーンショット
 * GET /debug/browser?selector=XXX&screenshot=true&html=true
 */
type DebugBrowserQuery = Record<string, string | undefined> & {
  /** 特定要素の情報を取得（例: #txtAppointMemo） */
  selector?: string;
  /** trueの場合スクリーンショットを含める */
  screenshot?: string;
  /** trueの場合HTMLを含める */
  html?: string;
}

app.get('/debug/browser', async (req: Request<ParamsDictionary, unknown, unknown, DebugBrowserQuery>, res: Response) => {
  try {
    if (!sessionManager) {
      res.status(503).json({ error: 'No active session' });
      return;
    }

    const selector = req.query.selector;
    const includeScreenshot = req.query.screenshot === 'true';
    const includeHtml = req.query.html === 'true';

    // Accept: image/png の場合は画像のみを返す
    if (req.headers.accept === 'image/png') {
      const buffer = await sessionManager.withPage(async (page) => {
        return await page.screenshot({ fullPage: true });
      }, REQUEST_TIMEOUT_MS);
      res.setHeader('Content-Type', 'image/png');
      res.send(buffer);
      return;
    }

    const result = await sessionManager.withPage(async (page) => {
      const data: Record<string, unknown> = {
        url: page.url(),
        title: await page.title(),
      };

      // 特定セレクタの情報を取得
      if (selector) {
        const elementInfo = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { found: false, selector: sel };

          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const htmlEl = el as HTMLElement;

          // 親要素のチェーンを確認（どこで非表示になっているか）
          const parentChain: Array<{ tag: string; id: string; class: string; display: string; visibility: string }> = [];
          let parent = el.parentElement;
          let depth = 0;
          while (parent && depth < 10) {
            const parentStyle = window.getComputedStyle(parent);
            parentChain.push({
              tag: parent.tagName,
              id: parent.id,
              class: parent.className.toString().slice(0, 50),
              display: parentStyle.display,
              visibility: parentStyle.visibility,
            });
            parent = parent.parentElement;
            depth++;
          }

          return {
            found: true,
            selector: sel,
            tagName: el.tagName,
            id: el.id,
            className: el.className.toString(),
            value: (el as HTMLInputElement | HTMLTextAreaElement).value ?? null,
            innerText: htmlEl.innerText?.slice(0, 200),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
            isVisible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
            offsetParent: htmlEl.offsetParent ? (htmlEl.offsetParent as HTMLElement).tagName : null,
            parentChain,
          };
        }, selector);
        data.element = elementInfo;
      }

      // HTML取得
      if (includeHtml) {
        data.html = await page.content();
      }

      // スクリーンショット（Base64で含める）
      if (includeScreenshot) {
        const buffer = await page.screenshot({ fullPage: true });
        data.screenshot = buffer.toString('base64');
      }

      return data;
    }, REQUEST_TIMEOUT_MS);

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Server] /debug/browser error:', error);
    res.status(500).json({ error: message });
  }
});

/**
 * デバッグ用エンドポイント - ブラウザでJavaScriptを実行
 */
app.post('/debug/evaluate', async (req: Request, res: Response) => {
  try {
    if (!sessionManager) {
      res.status(503).json({ error: 'No active session' });
      return;
    }

    const { script } = req.body as { script: string };
    if (!script) {
      res.status(400).json({ error: 'script is required' });
      return;
    }

    const result = await sessionManager.withPage(async (page) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const evalResult = await page.evaluate((code) => {
        try {
          // eslint-disable-next-line no-eval
          return { success: true, result: eval(code) };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }, script);
      return evalResult;
    }, REQUEST_TIMEOUT_MS);

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Server] /debug/evaluate error:', error);
    res.status(500).json({ error: message });
  }
});

/**
 * サーバー起動
 */
async function main() {
  console.log('[Server] Starting...');
  console.log(`[Server] Keep-alive interval: ${KEEP_ALIVE_INTERVAL_MS}ms`);
  console.log('[Server] Mode: Dynamic credentials (auth from request headers)');

  // HTTPサーバー起動（セッションは最初のリクエスト時に初期化）
  app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    console.log('[Server] Endpoints:');
    console.log('  - GET  /health');
    console.log('  - GET  /status');
    console.log('  - GET  /menu');
    console.log('  - GET  /slots?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&resources=Dr1,Dr2&duration=30');
    console.log('  - GET  /reservations/search?customer_phone=XXX&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD');
    console.log('  - POST /reservations (create)');
    console.log('  - PUT  /reservations (update)');
    console.log('  - DELETE /reservations (cancel)');
    console.log('  - POST /session/restart');
    console.log('[Server] Required headers:');
    console.log('  - X-RPA-Login-Id: EasyApo login ID');
    console.log('  - X-RPA-Login-Password: EasyApo password');
  });

  // グレースフルシャットダウン
  const shutdown = async () => {
    console.log('[Server] Shutting down...');
    if (sessionManager) {
      await sessionManager.close();
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[Server] Fatal error:', error);
  process.exit(1);
});
