/**
 * アポイント管理台帳ページ Page Object
 *
 * 空き枠の取得、予約の作成・キャンセルを行う
 */

import {
  BasePage,
  type ReservationRequest as ReservationRequestBase,
  type ScreenshotManager,
  type MenuInfo,
} from '@smartcall/rpa-sdk';
import type { Page } from 'playwright';
import type {
  ColumnRow,
  TimeRow,
  ReserveRow,
  TreatmentItem,
  PatientsSearchResponse,
  PatientsOrSearchResponse,
  PatientSearchItem,
  PatientDetailResponse,
  ReservationDetailResponse,
  ReservationsListResponse,
  ClosedDayCalendar,
  WebSettingResponse,
  WebAcceptTime,
} from '../types/easyapo.d.ts';
import { EasyApoApiClient } from '../lib/EasyApoApiClient.js';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);

/** WebSetting APIのデータ部分（キャッシュ用） */
type WebSettingData = NonNullable<WebSettingResponse['data']>;

/** 電話番号から数字のみを抽出する */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** 電話番号の下4桁を取得する */
function phoneLast4(phone: string): string {
  const digits = normalizePhone(phone);
  return digits.slice(-4);
}

/** 電話番号の末尾一致で比較する（市外局番の有無やハイフンの表記揺れを吸収、最低6桁必要） */
function phoneEndsWith(registered: string, input: string): boolean {
  const regDigits = normalizePhone(registered);
  const inputDigits = normalizePhone(input);
  const shorter = regDigits.length < inputDigits.length ? regDigits : inputDigits;
  const longer = regDigits.length < inputDigits.length ? inputDigits : regDigits;
  if (shorter.length < 6) return false;
  return longer.endsWith(shorter);
}

/**
 * 予約リクエスト（SDKの型を拡張してdeleteオペレーションを追加）
 */
export type ReservationRequest = Omit<ReservationRequestBase, 'operation'> & {
  operation: ReservationRequestBase['operation'] | 'delete' | 'update';
  slot: ReservationRequestBase['slot'] & {
    /** 変更後希望日時 */
    desired?: {
        /** 希望日（YYYY-MM-DD形式） */
        date?: string,
        /** 希望時刻（HH:MM形式 */
        time?: string,
    },
  }
  /** リソースID候補（複数指定時、この中から空きスタッフを自動選択） */
  resource_ids?: string[];
  /** 備考 */
  notes?: string;
};

/**
 * 予約結果詳細
 */
export interface ReservationResultDetail {
  status: 'success' | 'failed' | 'conflict';
  external_reservation_id?: string;
  /** 実際の所要時間（分）- メニューのtreatment_timeから決定 */
  duration_min?: number;
  error_code?: string;
  error_message?: string;
  /** pic（担当者）情報 - 担当者が空いていない場合に設定 */
  pic?: { id: number; name: string }[];
}

/**
 * 予約結果（API仕様準拠 - resultオブジェクト形式）
 */
export interface ReservationResult {
  reservation_id: string;
  operation: 'create' | 'update' | 'cancel' | 'delete';
  result: ReservationResultDetail;
}

/**
 * 空き枠情報
 */
export interface SlotInfo {
  /** 日付（YYYY-MM-DD形式） */
  date: string;
  /** 時刻（HH:MM形式） */
  time: string;
  /** 所要時間（分） */
  duration_min: number;
  /** 空き枠数 */
  stock: number;
  /** リソース名（担当者名など） */
  resource_name?: string;
}

/**
 * 予約検索結果
 */
export interface ReservationSearchResult {
  /** 予約ID */
  appointId: string;
  /** 日付（YYYY-MM-DD形式） */
  date: string;
  /** 時刻（HH:MM形式） */
  time: string;
  /** 顧客名 */
  customerName: string;
  /** 電話番号 */
  customerPhone: string;
  /** スタッフID */
  staffId: string;
}

export class AppointPage extends BasePage {
  private readonly screenshot: ScreenshotManager;
  private readonly apiClient: EasyApoApiClient;

  /** 現在選択中の日付 (YYYY-MM-DD) - selectDate()で更新 */
  private currentDate: string | null = null;

  /** メニュー一覧のオンメモリキャッシュ（店舗専用コンテナのためstaticで共有） */
  private static treatmentItemsCache: TreatmentItem[] | null = null;
  private static treatmentItemsCacheTime = 0;
  private static readonly TREATMENT_ITEMS_CACHE_TTL_MS = 5 * 60 * 1000; // 5分

  private static webSettingCache: WebSettingData | null = null;
  private static webSettingCacheTime = 0;
  private static readonly WEB_SETTING_CACHE_TTL_MS = 5 * 60 * 1000; // 5分

  /** カラム情報（column_rows）のキャッシュ - 接続ごとに1回取得すれば変わらない */
  private static columnsCache: ColumnRow[] | null = null;

  /** キャッシュをクリア（再ログイン時に呼び出す） */
  static clearCache(): void {
    AppointPage.treatmentItemsCache = null;
    AppointPage.treatmentItemsCacheTime = 0;
    AppointPage.webSettingCache = null;
    AppointPage.webSettingCacheTime = 0;
    AppointPage.columnsCache = null;
  }

  /**
   * アポイント管理台帳ページ
   *
   * 空き枠の取得、予約の作成・キャンセルを行う
   *
   * @param page Playwrightのページオブジェクト
   * @param screenshot スクリーンショットマネージャー
   */
  constructor(page: Page, screenshot: ScreenshotManager) {
    super(page);
    this.screenshot = screenshot;
    this.apiClient = new EasyApoApiClient(page);
  }

  private static readonly TIMER_LABEL = '[AppointPage]';
  private static readonly DEBUG_ENABLED = process.env.NODE_DEBUG?.includes('AppointPage') ?? false;
  private static debugStarted = false;

  /**
   * 処理ステップのログを出力（時間計測付き）
   * NODE_DEBUG=AppointPage を設定した場合のみ出力
   */
  private step(message: string): void {
    if (AppointPage.DEBUG_ENABLED) {
      console.timeLog(AppointPage.TIMER_LABEL, message);
    }
  }

  /**
   * ローディング表示が消えるまで待機
   */
  private async waitForLoading(): Promise<void> {
    await this.page.waitForSelector('#loading', { state: 'hidden' });
    await this.wait(200);
    // 一瞬ローダーが消えて、即座に再開することがあるのでもう一度
    await this.page.waitForSelector('#loading', { state: 'hidden' });
  }

  /**
   * アポイント管理台帳ページに遷移
   */
  async navigate(baseUrl: string): Promise<void> {
    if (AppointPage.DEBUG_ENABLED) {
      if (AppointPage.debugStarted) {
        console.timeEnd(AppointPage.TIMER_LABEL);
      }
      console.time(AppointPage.TIMER_LABEL);
      AppointPage.debugStarted = true;
    }
    this.step('navigate: start');
    await this.goto(`${baseUrl}/`);
    this.step('navigate: goto complete');
    // メインコンポーネントが表示されるまで待機（ログイン後の初期化完了確認）
    await this.page.waitForSelector('#col-main > div');
    await this.page.waitForSelector('#col-side > div');
    await this.waitForLoading();
    this.step('navigate: complete');
  }

  /**
   * 対象日付を設定する（旧: カレンダーUIで日付選択）
   *
   * Vue 3 移行後はUI操作不要。日付を状態として保持するだけ。
   * 以降の getReserveDayData() は currentDate を使って API を直接叩く。
   */
  private async selectDate(dateStr: string): Promise<void> {
    if (this.currentDate === dateStr) {
      this.step(`selectDate: skipped (already selected: ${dateStr})`);
      return;
    }
    this.currentDate = dateStr;
    this.step(`selectDate: set (${dateStr})`);
  }

  /**
   * clinic_hours APIのレスポンス1日分
   */
  private static readonly TIME_UNIT_MIN = 15;

  /**
   * 「HH:MM」を分に変換
   */
  private hhmmToMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(':').map((s) => parseInt(s, 10));
    return h * 60 + m;
  }

  /**
   * clinic_hours から 15分刻みの time_rows を生成
   * （旧 ReserveDay コンポーネントがフロント側で行っていた処理）
   */
  private buildTimeRows(ch: {
    clinic_hour_from: string;
    clinic_hour_to: string;
    break_time_from?: string;
    break_time_to?: string;
    night_break_time_from?: string;
    night_break_time_to?: string;
  }): TimeRow[] {
    const unit = AppointPage.TIME_UNIT_MIN;
    const fromMin = this.hhmmToMinutes(ch.clinic_hour_from);
    const toMin = this.hhmmToMinutes(ch.clinic_hour_to);

    const hasBreak = !!ch.break_time_from && !!ch.break_time_to
      && ch.break_time_from !== ch.break_time_to;
    const breakFrom = hasBreak ? this.hhmmToMinutes(ch.break_time_from!) : null;
    const breakTo = hasBreak ? this.hhmmToMinutes(ch.break_time_to!) : null;

    const hasNight = !!ch.night_break_time_from && !!ch.night_break_time_to
      && ch.night_break_time_from !== ch.night_break_time_to;
    const nightFrom = hasNight ? this.hhmmToMinutes(ch.night_break_time_from!) : null;
    const nightTo = hasNight ? this.hhmmToMinutes(ch.night_break_time_to!) : null;

    const rows: TimeRow[] = [];
    for (let mins = fromMin; mins < toMin; mins += unit) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const is_break_time = breakFrom != null && breakTo != null
        && mins >= breakFrom && mins < breakTo;
      const is_night_break_time = nightFrom != null && nightTo != null
        && mins >= nightFrom && mins < nightTo;
      rows.push({
        hour: hh,
        minute: mm,
        time_num: `${hh}${mm}`,
        time_text: `${hh}:${mm}`,
        is_break_time,
        is_night_break_time,
      } as unknown as TimeRow);
    }
    return rows;
  }

  /**
   * 予約一覧APIのレスポンスを ReserveRow 形式に正規化
   * （time_from / time_to を HHMM 数値文字列に派生）
   */
  private normalizeReserveRows(reservations: Array<Record<string, unknown>>): ReserveRow[] {
    return reservations.map((r) => ({
      ...r,
      time_from_num: typeof r.time_from === 'string' ? r.time_from.replace(':', '') : '',
      time_to_num: typeof r.time_to === 'string' ? r.time_to.replace(':', '') : '',
    })) as unknown as ReserveRow[];
  }

  /**
   * カラム情報を取得（旧 ReserveDay.column_rows 相当）
   * use_column flag が立っている列のみを返す（画面に表示される担当者列）
   */
  private async getColumnRows(): Promise<ColumnRow[]> {
    if (AppointPage.columnsCache) return AppointPage.columnsCache;
    const resp = await this.apiClient.get<{
      column_names: ColumnRow[];
      use_column: number[];
    }>('/columns');
    if (!resp.result || !resp.data) return [];
    const useColumn = resp.data.use_column ?? [];
    const rows = resp.data.column_names.filter((_, idx) => useColumn[idx] === 1);
    AppointPage.columnsCache = rows;
    return rows;
  }

  /**
   * 指定日（currentDate）の予約データを取得
   * 旧 ReserveDay コンポーネントが保持していたリアクティブデータを4本のAPIから合成する。
   */
  private async getReserveDayData(): Promise<{
    reserve_rows: ReserveRow[];
    column_rows: ColumnRow[];
    time_rows: TimeRow[];
    closed_days: ClosedDayCalendar[];
    closed_td_list: string[];
    start_hour: number;
    start_minute: number;
    end_hour: number;
    end_minute: number;
  } | null> {
    const date = this.currentDate;
    if (!date) return null;

    const [columnRows, hoursResp, closedResp, resvResp] = await Promise.all([
      this.getColumnRows(),
      this.apiClient.get<{
        clinic_hours: Record<string, {
          clinic_hour_from: string;
          clinic_hour_to: string;
          break_time_from?: string;
          break_time_to?: string;
          night_break_time_from?: string;
          night_break_time_to?: string;
        }>;
      }>(`/clinic_hours/from/${date}`, { date, days: 1 }),
      this.apiClient.get<{ closed_days: ClosedDayCalendar[] }>(
        `/closed_days/from/${date}`,
        { date, days: 1 },
      ),
      this.apiClient.get<{
        reservations: Array<Record<string, unknown>>;
        clinic_icons?: unknown;
        use_dental_notation?: unknown;
      }>('/reservations', { from: date, days: 1 }),
    ]);

    const clinicHour = hoursResp.data?.clinic_hours?.[date];
    if (!clinicHour) return null;

    const time_rows = this.buildTimeRows(clinicHour);
    const [start_hour, start_minute] = clinicHour.clinic_hour_from.split(':').map((s) => parseInt(s, 10));
    const [end_hour, end_minute] = clinicHour.clinic_hour_to.split(':').map((s) => parseInt(s, 10));

    const closed_days = closedResp.data?.closed_days ?? [];
    const reserve_rows = this.normalizeReserveRows(resvResp.data?.reservations ?? []);
    // 休憩時間枠は予約受付不可
    const closed_td_list = time_rows
      .filter((tr) => tr.is_break_time || tr.is_night_break_time)
      .map((tr) => tr.time_num);

    return {
      reserve_rows,
      column_rows: columnRows,
      time_rows,
      closed_days,
      closed_td_list,
      start_hour,
      start_minute,
      end_hour,
      end_minute,
    };
  }

  /**
   * 指定日が休診日かどうかを判定
   *
   * EasyApoのclosed_daysカレンダーの値:
   * - 1 = 定休日（休診）
   * - 2 = 臨時休診（休診）
   * - 3 = 営業日（予約可能）
   * - null/undefined = データなし（営業日扱い）
   */
  private isClosedDay(dateStr: string, closedDays: ClosedDayCalendar[]): boolean {
    return closedDays.some((cal) => {
      const value = cal.calendar[dateStr];
      // 値が1または2の場合は休診日
      return value === 1 || value === 2;
    });
  }

  /**
   * 時間枠が休憩時間かどうかを判定
   */
  private isBreakTime(timeRow: TimeRow): boolean {
    return timeRow.is_break_time || timeRow.is_night_break_time;
  }

  /**
   * 時間枠を分に変換
   */
  private timeRowToMinutes(timeRow: TimeRow): number {
    return parseInt(timeRow.hour) * 60 + parseInt(timeRow.minute);
  }

  /**
   * 指定位置から連続した時間枠が確保できるかチェック
   *
   * @param timeRows 全時間枠
   * @param startIndex 開始位置
   * @param requiredSlots 必要な枠数
   * @returns 連続して確保できる場合はtrue
   */
  private areSlotsConsecutive(
    timeRows: TimeRow[],
    startIndex: number,
    requiredSlots: number
  ): boolean {
    for (let k = 0; k < requiredSlots; k++) {
      const idx = startIndex + k;
      if (idx >= timeRows.length) return false;

      // 休憩時間は不可
      if (this.isBreakTime(timeRows[idx])) return false;

      // 次の枠との連続性チェック（最後の枠以外）
      if (k < requiredSlots - 1) {
        const nextIdx = idx + 1;
        if (nextIdx >= timeRows.length) return false;

        const currentMinutes = this.timeRowToMinutes(timeRows[idx]);
        const nextMinutes = this.timeRowToMinutes(timeRows[nextIdx]);
        if (nextMinutes - currentMinutes !== 15) return false;
      }
    }
    return true;
  }

  /**
   * 担当者が指定時間枠で予約可能かチェック
   *
   * @param column 担当者情報
   * @param timeRows 全時間枠
   * @param startIndex 開始位置
   * @param requiredSlots 必要な枠数
   * @param reserveRows 予約一覧
   * @returns 予約可能な場合はtrue
   */
  private isStaffAvailable(
    column: ColumnRow,
    timeRows: TimeRow[],
    startIndex: number,
    requiredSlots: number,
    reserveRows: ReserveRow[]
  ): boolean {
    // 連続枠が確保できるかチェック
    if (!this.areSlotsConsecutive(timeRows, startIndex, requiredSlots)) {
      return false;
    }

    // 各枠に予約がないかチェック
    for (let j = 0; j < requiredSlots; j++) {
      const checkTimeRow = timeRows[startIndex + j];
      const hasConflict = reserveRows.some((reservation) => {
        if (reservation.column_no !== column.id) return false;
        if (reservation.cancel === 1) return false;

        const slotTime = checkTimeRow.time_num;
        return slotTime >= reservation.time_from_num && slotTime < reservation.time_to_num;
      });

      if (hasConflict) return false;
    }

    return true;
  }

  /**
   * 指定したpic（担当者）が指定時間帯に空いているかチェック
   * columnとは独立に、全カラムの予約を横断してpicの重複を確認する
   */
  private isPicAvailable(
    picIds: number[],
    timeRows: TimeRow[],
    startIndex: number,
    requiredSlots: number,
    reserveRows: ReserveRow[],
    excludeReservationId?: number
  ): boolean {
    // 連続枠が確保できるかチェック
    if (!this.areSlotsConsecutive(timeRows, startIndex, requiredSlots)) {
      return false;
    }

    const picIdSet = new Set(picIds);

    // 各枠でpicが他の予約に割り当てられていないかチェック
    for (let j = 0; j < requiredSlots; j++) {
      const checkTimeRow = timeRows[startIndex + j];
      const hasConflict = reserveRows.some((reservation) => {
        if (reservation.cancel === 1) return false;
        if (excludeReservationId != null && reservation.id === excludeReservationId) return false;
        // この予約のpicにチェック対象のpicが含まれているか
        if (!reservation.pic?.some(p => picIdSet.has(p.id))) return false;

        const slotTime = checkTimeRow.time_num;
        return slotTime >= reservation.time_from_num && slotTime < reservation.time_to_num;
      });

      if (hasConflict) return false;
    }

    return true;
  }

  /**
   * 1日分の空き枠を取得
   */
  private getAvailableSlotsForDate(
    dateStr: string,
    dayData: NonNullable<Awaited<ReturnType<typeof this.getReserveDayData>>>,
    options: {
      resources?: string[];
      duration?: number;
      acceptTime?: WebAcceptTime;
      reservationDeadlineHours?: number | null;
      picIds?: number[];
    }
  ): SlotInfo[] {
    const { resources, duration, acceptTime, reservationDeadlineHours, picIds } = options;
    const slots: SlotInfo[] = [];

    // 急患枠を除外した担当者リスト
    let availableColumns = dayData.column_rows.filter(
      (col) => col.name !== '急患'
    );

    // resourcesが指定されている場合、さらに絞り込む
    if (resources && resources.length > 0) {
      availableColumns = availableColumns.filter(
        (col) => resources.includes(col.name)
      );
    }

    // 診療時間を数値形式に変換（HHMM形式）
    const startTimeNum = String(dayData.start_hour).padStart(2, '0') + String(dayData.start_minute).padStart(2, '0');
    const endTimeNum = String(dayData.end_hour).padStart(2, '0') + String(dayData.end_minute).padStart(2, '0');

    // Web予約受付時間による制限（HHMM形式に変換）
    const acceptFromNum = acceptTime ? acceptTime.web_accept_time_from.replace(':', '') : null;
    const acceptToNum = acceptTime ? acceptTime.web_accept_time_to.replace(':', '') : null;

    // 必要な連続枠数を計算（15分刻み）
    const requiredSlots = duration ? Math.ceil(duration / 15) : 1;

    // 診療時間内の時間枠をフィルタ
    const timeRows = dayData.time_rows.filter(
      (timeRow) => timeRow.time_num >= startTimeNum && timeRow.time_num < endTimeNum
    );

    // 現在日時（JST）より過去の枠を除外するための閾値
    const nowJst = dayjs().tz('Asia/Tokyo');
    const nowDateTimeNum = nowJst.format('YYYY-MM-DD HHmm');

    // 各時間枠をチェック
    for (let i = 0; i < timeRows.length; i++) {
      const timeRow = timeRows[i];

      // 30分刻みのみ（:00と:30）を対象とする
      const minute = parseInt(timeRow.minute, 10);
      if (minute % 30 !== 0) continue;

      // 現在時刻より過去の枠はスキップ
      if (`${dateStr} ${timeRow.time_num}` < nowDateTimeNum) continue;

      // reservation_deadline: 予約時刻のn時間前を過ぎていたらスキップ
      if (reservationDeadlineHours != null) {
        const slotDateTime = dayjs(`${dateStr} ${timeRow.hour}:${timeRow.minute}`, 'YYYY-MM-DD H:m').tz('Asia/Tokyo', true);
        if (nowJst.isAfter(slotDateTime.subtract(reservationDeadlineHours, 'hour'))) continue;
      }

      // Web予約受付時間の範囲外はスキップ（00:00～00:00は制限なし）
      if (acceptFromNum && acceptToNum && !(acceptFromNum === '0000' && acceptToNum === '0000')) {
        if (timeRow.time_num < acceptFromNum || timeRow.time_num >= acceptToNum) continue;
      }

      // 休憩時間はスキップ
      if (this.isBreakTime(timeRow)) continue;

      // 予約受付不可の時間帯はスキップ
      if (dayData.closed_td_list.includes(timeRow.time_num)) continue;

      // picが指定されている場合、この時間枠でpicが空いているかチェック
      if (picIds?.length && !this.isPicAvailable(picIds, timeRows, i, requiredSlots, dayData.reserve_rows)) {
        continue;
      }

      // この時間枠で空いている担当者を探す
      const availableStaff = availableColumns
        .filter((column) =>
          this.isStaffAvailable(column, timeRows, i, requiredSlots, dayData.reserve_rows)
        )
        .map((column) => column.name);

      // 空いている担当者がいれば空き枠として追加
      if (availableStaff.length > 0) {
        slots.push({
          date: dateStr,
          time: timeRow.time_text,
          duration_min: duration || 15,
          stock: availableStaff.length,
          resource_name: availableStaff.join(','),
        });
      }
    }

    return slots;
  }

  /**
   * リソースIDの配列からリソース名の配列に変換する
   * column_rows（担当者カラム）のidとnameを照合して解決する
   */
  async resolveResourceIds(resourceIds: string[]): Promise<string[]> {
    const dayData = await this.getReserveDayData();
    if (!dayData) return [];
    const idSet = new Set(resourceIds.map(id => Number(id)));
    return dayData.column_rows
      .filter(col => idSet.has(col.id))
      .map(col => col.name);
  }

  /**
   * 指定日付の空き枠を取得
   */
  async getAvailableSlots({ dateFrom, dateTo, resources, duration, menu, picIds }: {
    /** 開始日 (YYYY-MM-DD) */
    dateFrom: string;
    /** 終了日 (YYYY-MM-DD) */
    dateTo: string;
    /** 対象リソース名の配列（指定した場合、このリソースのみを対象とする） */
    resources?: string[];
    /** 所要時間（分）。指定した場合、同一担当者で連続して確保できる枠のみを返す */
    duration?: number;
    /** メニュー情報（指定時はメニューのresources/treatment_timeで絞り込み・調整） */
    menu?: MenuInfo;
    /** pic（担当者）IDの配列。指定時はこれらのpicが全員空いている枠のみを返す */
    picIds?: number[];
  }): Promise<SlotInfo[]> {
    const perfStart = Date.now();
    this.step(`getAvailableSlots: start (${dateFrom} - ${dateTo})`);
    // Web予約設定を取得
    const webSetting = await this.getWebSetting();
    console.log(`[PERF] getWebSetting: ${Date.now() - perfStart}ms`);
    const webAcceptTimes = webSetting?.web_accept_time ?? null;

    // メニューから診療メニュー情報を取得
    const matchedItem = await this.findTreatmentItem(menu);
    console.log(`[PERF] findTreatmentItem: ${Date.now() - perfStart}ms`);

    // resourcesの決定: 両方指定されていれば積集合、片方のみなら指定された方
    let effectiveResources = resources;
    if (matchedItem?.resources?.length) {
      if (resources?.length) {
        // 積集合（AND条件）
        const menuResourceSet = new Set(matchedItem.resources);
        effectiveResources = resources.filter((r) => menuResourceSet.has(r));
      } else {
        // resourcesが未指定ならメニューのresourcesを使用
        effectiveResources = matchedItem.resources;
      }
    }

    // durationの決定: 両方指定されていれば長い方、片方のみなら指定された方
    let effectiveDuration = duration;
    if (matchedItem?.treatment_time) {
      effectiveDuration = duration
        ? Math.max(duration, matchedItem.treatment_time)
        : matchedItem.treatment_time;
    }
    // 不明の場合 45分を規定とする
    effectiveDuration ??= 45

    const slots: SlotInfo[] = [];
    const nowJst = dayjs().tz('Asia/Tokyo');
    const startDate = dayjs(dateFrom);
    const endDate = dayjs(dateTo);

    // display_from_dayによる開始日制限（n日後から予約可能）
    const displayFromDay = webSetting?.display_from_day;
    const earliestDate = displayFromDay != null
      ? nowJst.startOf('day').add(displayFromDay, 'day')
      : null;

    // reservation_deadlineによる時間制限（n時間前まで受付可能）
    const reservationDeadlineHours = webSetting?.reservation_deadline != null
      ? parseInt(webSetting.reservation_deadline, 10)
      : null;

    // 休診日データをキャッシュ（最初の日付取得時に保存）
    let cachedClosedDays: ClosedDayCalendar[] | null = null;

    let currentDate = startDate;
    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, 'day')) {
      const dateStr = currentDate.format('YYYY-MM-DD');
      const loopStart = Date.now();

      // display_from_dayによる日付制限チェック
      if (earliestDate && currentDate.isBefore(earliestDate, 'day')) {
        console.log(`[PERF] date=${dateStr}: SKIPPED (within display_from_day=${displayFromDay})`);
        currentDate = currentDate.add(1, 'day');
        continue;
      }

      // キャッシュされた休診日データがあれば、事前に休診日をスキップ（APIコール不要）
      if (cachedClosedDays && this.isClosedDay(dateStr, cachedClosedDays)) {
        console.log(`[PERF] date=${dateStr}: SKIPPED (closed day, no API call)`);
        currentDate = currentDate.add(1, 'day');
        continue;
      }

      await this.selectDate(dateStr);
      const selectDateTime = Date.now() - loopStart;

      const dayData = await this.getReserveDayData();
      const getDataTime = Date.now() - loopStart - selectDateTime;

      console.log(`[PERF] date=${dateStr}: selectDate=${selectDateTime}ms, getReserveDayData=${getDataTime}ms`);

      if (dayData) {
        // 最初の取得時にclosed_daysをキャッシュ
        if (!cachedClosedDays) {
          cachedClosedDays = dayData.closed_days;
          console.log(`[PERF] closed_days cached for subsequent date checks`);
        }

        // 休診日はスキップ（キャッシュに保存されていない最初の日付の場合のみ到達）
        const isClosed = this.isClosedDay(dateStr, dayData.closed_days);
        if (isClosed) {
          console.log(`[PERF] date=${dateStr}: closed day (first date check)`);
          currentDate = currentDate.add(1, 'day');
          continue;
        }

        // 曜日に対応するWeb予約受付時間を取得（0=日, 1=月, ..., 6=土）
        const dayOfWeek = currentDate.day();
        const acceptTime = webAcceptTimes?.[dayOfWeek];

        const daySlots = this.getAvailableSlotsForDate(dateStr, dayData, { resources: effectiveResources, duration: effectiveDuration, acceptTime, reservationDeadlineHours, picIds });
        console.log(`[PERF] date=${dateStr}: ${daySlots.length} slots found`);
        slots.push(...daySlots);
      }

      currentDate = currentDate.add(1, 'day');
    }

    this.step(`getAvailableSlots: complete (${slots.length} slots found)`);
    console.log(`[PERF] getAvailableSlots total: ${Date.now() - perfStart}ms, dates processed: ${endDate.diff(startDate, 'day') + 1}, slots found: ${slots.length}`);
    return slots;
  }

  /**
   * 診療メニュー一覧を取得
   *
   * @returns 診療メニュー一覧（所要時間、処置可能担当者を含む）
   */
  async getTreatmentItems(): Promise<TreatmentItem[]> {
    // キャッシュが有効な場合はAPIコールをスキップ
    if (AppointPage.treatmentItemsCache && (Date.now() - AppointPage.treatmentItemsCacheTime) < AppointPage.TREATMENT_ITEMS_CACHE_TTL_MS) {
      return AppointPage.treatmentItemsCache;
    }

    type TreatmentItemRaw = Omit<TreatmentItem, 'resources'>;
    const [resp, columnRows] = await Promise.all([
      this.apiClient.get<{ treatment_items: TreatmentItemRaw[] }>('/treatment_items'),
      this.getColumnRows(),
    ]);
    if (!resp.result || !resp.data) return [];

    // use_columnのIDを担当者名に変換
    const columnMap = new Map(columnRows.map((col) => [col.id, col.name]));
    const items: TreatmentItem[] = resp.data.treatment_items.map((item) => ({
      ...item,
      resources: item.use_column
        .map((id) => columnMap.get(id))
        .filter((name): name is string => name !== undefined),
    }));

    AppointPage.treatmentItemsCache = items;
    AppointPage.treatmentItemsCacheTime = Date.now();
    return items;
  }

  /**
   * 患者詳細を取得（予約履歴を含む）
   *
   * 注意: 旧コードと同じく、APIレスポンスの「ApiResponse包み」をそのまま返す。
   * 呼び出し側は `result?.result` / `result?.data?.xxx` でアクセスする。
   */
  private async getPatientDetail(patientId: number): Promise<PatientDetailResponse | null> {
    const resp = await this.apiClient.get<PatientDetailResponse['data']>(
      `/patients/${patientId}`,
      { id: patientId, original: true },
    );
    return { result: resp.result, data: resp.data, message: resp.message } as PatientDetailResponse;
  }

  /**
   * 患者検索結果から電話番号が一致する患者を探す
   * tel1の末尾一致で見つからない場合、患者詳細を取得してtel2も確認する
   */
  private async findPatientByPhone(
    candidates: PatientSearchItem[],
    customerPhone: string
  ): Promise<PatientSearchItem | undefined> {
    // tel1の末尾一致で探す
    const tel1Match = candidates.find(
      (p) => p.tel1 && phoneEndsWith(p.tel1, customerPhone)
    );
    if (tel1Match) return tel1Match;

    // tel1で見つからない場合、各候補の詳細を取得してtel2を確認
    for (const candidate of candidates) {
      const detail = await this.getPatientDetail(candidate.id);
      if (detail?.data?.tel2 && phoneEndsWith(detail.data.tel2, customerPhone)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Web予約設定を取得（キャッシュ付き）
   * web_accept_time は日〜土（index 0=日, 1=月, ..., 6=土）の7要素
   */
  private async getWebSetting(): Promise<WebSettingData | null> {
    const now = Date.now();
    if (AppointPage.webSettingCache && (now - AppointPage.webSettingCacheTime) < AppointPage.WEB_SETTING_CACHE_TTL_MS) {
      return AppointPage.webSettingCache;
    }

    const resp = await this.apiClient.get<WebSettingData>('/websetting');
    const data = resp.result ? resp.data : null;
    if (data) {
      AppointPage.webSettingCache = data;
      AppointPage.webSettingCacheTime = now;
    }
    return data;
  }

  /**
   * 予約詳細を取得
   * 旧コードとの互換のため ApiResponse 形式でラップして返す。
   */
  private async getReservationDetail(reservationId: number): Promise<ReservationDetailResponse | null> {
    const resp = await this.apiClient.get<ReservationDetailResponse['data']>(
      `/reservations/${reservationId}`,
      { id: reservationId, original: true },
    );
    return { result: resp.result, data: resp.data, message: resp.message } as ReservationDetailResponse;
  }

  /**
   * 電話番号で予約を検索する
   *
   * 指定された日付範囲内で、電話番号に一致する予約を検索する
   *
   * @param dateFrom 開始日 (YYYY-MM-DD)
   * @param dateTo 終了日 (YYYY-MM-DD)
   * @param customerPhone 電話番号
   * @returns 予約リスト
   */
  async searchReservationsByPhone(
    dateFrom: string,
    dateTo: string,
    customerPhone: string,
  ): Promise<ReservationSearchResult[]> {
    this.step(`searchReservationsByPhone: start (${customerPhone}, ${dateFrom} - ${dateTo})`);

    // 患者検索（電話番号下4桁）
    const telLast4 = phoneLast4(customerPhone);
    const patientsResp = await this.apiClient.get<PatientsSearchResponse['data']>('/patients', {
      or_search: 0,
      patient_name: '',
      patient_name_kana: '',
      tel: telLast4,
      sort_order: 'patient_number',
    });

    // 患者が見つからない場合、メモ内の電話番号で検索（フォールバック）
    if (!patientsResp.result || !patientsResp.data?.patients?.length) {
      return await this.searchReservationsByMemo(dateFrom, dateTo, customerPhone);
    }

    // 電話番号の末尾一致で絞り込み（tel1 → tel2 の順で確認、家族など複数人の可能性）
    const matchedPatients: PatientSearchItem[] = [];
    for (const patient of patientsResp.data.patients) {
      if (patient.tel1 && phoneEndsWith(patient.tel1, customerPhone)) {
        matchedPatients.push(patient);
      } else {
        const detail = await this.getPatientDetail(patient.id);
        if (detail?.data?.tel2 && phoneEndsWith(detail.data.tel2, customerPhone)) {
          matchedPatients.push(patient);
        }
      }
    }

    if (matchedPatients.length === 0) {
      return await this.searchReservationsByMemo(dateFrom, dateTo, customerPhone);
    }

    const results: ReservationSearchResult[] = [];

    // 各患者の予約履歴を取得
    for (const patient of matchedPatients) {
      const patientDetail = await this.getPatientDetail(patient.id);
      if (!patientDetail?.result || !patientDetail.data?.reservation_histories?.length) {
        continue;
      }

      const filteredHistories = patientDetail.data.reservation_histories.filter(
        (history) => history.reservation_date >= dateFrom && history.reservation_date <= dateTo,
      );

      for (const history of filteredHistories) {
        const detail = await this.getReservationDetail(history.id);
        if (!detail?.result || !detail.data) continue;
        if (detail.data.cancel) continue;

        results.push({
          appointId: String(detail.data.id),
          date: detail.data.reservation_date,
          time: detail.data.time_from,
          customerName: patientDetail.data.name_kana || detail.data.patient_name,
          customerPhone: detail.data.patient.tel1,
          staffId: String(detail.data.column_no),
        });
      }
    }

    this.step(`searchReservationsByPhone: complete (${results.length} results found)`);
    return results;
  }

  /**
   * メモ内の電話番号で予約を検索する（日付範囲内）
   *
   * 患者検索で見つからない場合のフォールバック検索として使用。
   * /reservations APIを直接呼び出して、メモ内のtel:[電話番号]形式で予約を検索する。
   *
   * @param dateFrom 検索開始日（YYYY-MM-DD形式）
   * @param dateTo 検索終了日（YYYY-MM-DD形式）
   * @param customerPhone 顧客電話番号
   * @returns 予約検索結果の配列
   */
  private async searchReservationsByMemo(
    dateFrom: string,
    dateTo: string,
    customerPhone: string
  ): Promise<ReservationSearchResult[]> {
    const results: ReservationSearchResult[] = [];

    // 日付範囲を生成
    const startDate = dayjs(dateFrom, 'YYYY-MM-DD');
    const endDate = dayjs(dateTo, 'YYYY-MM-DD');
    const diffDays = endDate.diff(startDate, 'day') + 1;

    // 30日単位でバッチ処理（API呼び出し回数を削減: 120回→4〜5回）
    const BATCH_DAYS = 30;
    this.step(`searchReservationsByMemo: searching ${diffDays} days in ${Math.ceil(diffDays / BATCH_DAYS)} batches`);

    for (let i = 0; i < diffDays; i += BATCH_DAYS) {
      const batchStartDate = startDate.add(i, 'day');
      const remainingDays = Math.min(BATCH_DAYS, diffDays - i);
      const currentDate = batchStartDate.format('YYYY-MM-DD');

      // /reservations API で複数日分の予約を一括取得
      const apiResult = await this.apiClient.get<ReservationsListResponse['data']>(
        '/reservations',
        { from: currentDate, days: remainingDays },
      );

      if (!apiResult.result || !apiResult.data?.reservations) {
        continue;
      }

      // メモ内の電話番号が一致する予約をすべて取得
      const matchedReservations = apiResult.data.reservations.filter((reservation) => {
        if (reservation.cancel === 1) return false;
        if (reservation.memo && reservation.memo.length > 0) {
          const memoText = reservation.memo.map((m) => m.memo || '').join(' ');
          if (memoText.includes(`tel:[${customerPhone}]`)) return true;
        }
        return false;
      });

      for (const reservation of matchedReservations) {
        results.push({
          appointId: String(reservation.id),
          date: reservation.reservation_date,
          time: reservation.time_from,
          customerName: reservation.patient_name,
          customerPhone: customerPhone,
          staffId: String(reservation.column_no),
        });
      }
    }

    return results;
  }

  /**
   * メニュー情報から診療メニューを検索する
   *
   * @param menu メニュー情報
   * @returns マッチした診療メニュー、または見つからない場合はundefined
   */
  private async findTreatmentItem(menu?: MenuInfo): Promise<TreatmentItem | undefined> {
    console.log(`[DEBUG] findTreatmentItem: menu=${JSON.stringify(menu)}`);
    if (!menu?.menu_name && !menu?.external_menu_id) {
      console.log(`[DEBUG] findTreatmentItem: no menu_name or external_menu_id, returning undefined`);
      return undefined;
    }
    const treatmentItems = await this.getTreatmentItems();
    console.log(`[DEBUG] findTreatmentItem: treatmentItems count=${treatmentItems.length}, first 3 items=${JSON.stringify(treatmentItems.slice(0, 3).map(i => ({ id: i.id, title: i.title, treatment_time: i.treatment_time })))}`);

    // external_menu_idで検索
    if (menu.external_menu_id) {
      const foundById = treatmentItems.find((item) => String(item.id) === String(menu.external_menu_id));
      console.log(`[DEBUG] findTreatmentItem: searching by external_menu_id=${menu.external_menu_id}, found=${foundById ? JSON.stringify({ id: foundById.id, title: foundById.title, treatment_time: foundById.treatment_time }) : 'undefined'}`);
      if (foundById) return foundById;
    }

    // menu_nameで検索
    const foundByName = treatmentItems.find((item) => item.title.includes(menu.menu_name));
    console.log(`[DEBUG] findTreatmentItem: searching by menu_name=${menu.menu_name}, found=${foundByName ? JSON.stringify({ id: foundByName.id, title: foundByName.title, treatment_time: foundByName.treatment_time }) : 'undefined'}`);
    return foundByName;
  }

  /**
   * 予約を作成する
   */
  async createReservation({
    date,
    timeFrom,
    timeTo,
    durationMin,
    columnNo,
    customerName,
    patientId,
    menu,
    customerPhone,
  }: {
    /** 予約日（YYYY-MM-DD形式） */
    date: string;
    /** 開始時刻（HH:MM形式） */
    timeFrom: string;
    /** 終了時刻（HH:MM形式）。未指定の場合はduration_minから計算 */
    timeTo?: string;
    /** 所要時間（分）。既定値は45分、2ヶ月以内の再診は30分 */
    durationMin?: number;
    /** カラム番号（担当者ID） */
    columnNo: number;
    /** 顧客名（予約名として使用） */
    customerName: string;
    /** 患者ID（既存患者の場合） */
    patientId?: string;
    /** 診療メニュー情報（予約内容として選択） */
    menu?: MenuInfo;
    /** 顧客電話番号 */
    customerPhone?: string;
  }): Promise<{ reservationId: string } | { error: string }> {
    this.step(`createReservation: start (${date} ${timeFrom}, ${customerName})`);

    // 1. 日付設定
    await this.selectDate(date);

    // 2. メニュー特定（treatment_time / color）
    const matchedItem = await this.findTreatmentItem(menu);
    const menuTreatmentTime = matchedItem?.treatment_time;
    const menuColor = matchedItem?.color;

    // 3. 患者検索（patientId未指定の場合、電話番号下4桁で /patients を検索）
    if (!patientId && customerPhone) {
      const telLast4 = phoneLast4(customerPhone);
      const searchResp = await this.apiClient.get<PatientsOrSearchResponse['data']>('/patients', {
        or_search: 0,
        patient_name: '',
        patient_name_kana: customerName || '',
        tel: telLast4,
        sort_order: 'patient_number',
      });
      if (searchResp.result && searchResp.data?.patients?.length) {
        const matchedPatient = await this.findPatientByPhone(searchResp.data.patients, customerPhone);
        if (matchedPatient) {
          patientId = matchedPatient.patient_number;
          if (matchedPatient.name_kana) {
            customerName = matchedPatient.name_kana;
          }
        }
      }
    }

    // 4. duration / timeTo 計算
    const treatmentItems = await this.getTreatmentItems();
    const fallbackDuration = treatmentItems[0]?.treatment_time ?? 45;
    const duration = menuTreatmentTime ?? durationMin ?? fallbackDuration;
    const calculatedTimeTo = menuTreatmentTime
      ? dayjs(`${date} ${timeFrom}`, 'YYYY-MM-DD HH:mm').add(menuTreatmentTime, 'minute').format('HH:mm')
      : (timeTo || dayjs(`${date} ${timeFrom}`, 'YYYY-MM-DD HH:mm').add(duration, 'minute').format('HH:mm'));

    // 5. patientId 指定時は存在確認
    if (patientId) {
      const patientResp = await this.apiClient.get<PatientDetailResponse['data']>(
        `/patients/number/${patientId}`,
      );
      if (!patientResp.result) {
        return { error: `患者ID「${patientId}」が見つかりません` };
      }
    }

    // 6. memo組み立て（メニュー名・電話番号）
    const menuName = matchedItem?.title || menu?.menu_name;
    const memo = menuName
      ? [{ id: 1, memo: `【SmartCall予約】 症状:[${menuName}]、tel:[${customerPhone || ''}]` }]
      : [];

    // 7. POST /reservations
    // treatment_id（診療内容）は EasyApo の /treatments マスタ（EXT/RCT/義歯imp 等の施術手技）
    // に属し、来院後にスタッフが施術内容を記録するための値。Web/電話予約の時点では確定しない。
    // 旧Vue2コードも treatment_id をセットせず null で送信し、メニュー（症状）は memo に残していた。
    // 症状名→施術手技の機械推定は不正確なため、ここでは旧来どおり null を送る。
    const postResp = await this.apiClient.post<{ confirmation?: string }>('/reservations', {
      patient_number: patientId ?? '',
      reservation_date: date,
      column_no: columnNo,
      time_from: timeFrom,
      time_to: calculatedTimeTo,
      patient_name: customerName,
      treatment_id: null,
      color: menuColor ?? '#FFFFFF',
      pic: [null, null, null],
      memo,
    });

    // 8. confirmation がある場合は失敗（診療時間外など）
    if (postResp.data?.confirmation) {
      const confirmationMessages = JSON.parse(postResp.data.confirmation) as string[];
      return { error: confirmationMessages.join(' ') };
    }

    // 9. result false なら失敗
    if (!postResp.result) {
      let errorMessage = '予約作成に失敗しました';
      if (postResp.message) {
        const messages = typeof postResp.message === 'string'
          ? [postResp.message]
          : Object.values(postResp.message).flat();
        errorMessage = messages.join(' ') || errorMessage;
      }
      return { error: errorMessage };
    }

    // 10. GET /reservations で作成された予約を特定（POSTレスポンスにIDが返らないため）
    const getResp = await this.apiClient.get<ReservationsListResponse['data']>('/reservations', {
      from: date,
      days: 1,
    });
    if (!getResp.result || !getResp.data?.reservations) {
      return { error: '予約一覧の取得に失敗しました' };
    }

    const createdReservation = getResp.data.reservations.find((reservation) => {
      if (reservation.time_from !== timeFrom || reservation.time_to !== calculatedTimeTo) return false;
      if (patientId) return reservation.patient_number === patientId;
      return reservation.patient_name === customerName;
    });

    if (!createdReservation) {
      console.error(`[AppointPage] 作成した予約が見つかりませんでした: ${customerName} ${timeFrom}-${calculatedTimeTo}`);
      return { error: '作成した予約が見つかりませんでした' };
    }

    this.step(`createReservation: complete (reservationId: ${createdReservation.id})`);
    return { reservationId: String(createdReservation.id) };
  }

  /**
   * 指定時間枠で空いている担当者を見つける
   *
   * 注意: このメソッドを呼び出す前に、selectDate()で対象日を読み込んでおく必要があります
   *
   * @param timeFrom 開始時刻（HH:MM形式）
   * @param durationMin 所要時間（分）
   * @param menu メニュー情報（指定時はuse_columnで担当者を絞り込み）
   * @returns 空いている担当者のcolumn_no、または見つからない場合はnull
   */
  private async findAvailableStaff(
    timeFrom: string,
    durationMin: number,
    menu?: MenuInfo,
    resourceIds?: string[]
  ): Promise<number | null> {
    // 予約日のデータを取得
    const dayData = await this.getReserveDayData();
    if (!dayData) return null;

    // 急患枠を除外した担当者リスト
    let availableColumns = dayData.column_rows.filter(
      (col) => col.name !== '急患'
    );

    // リソースIDが指定されている場合、その候補に絞り込む
    if (resourceIds?.length) {
      const idSet = new Set(resourceIds.map(id => Number(id)));
      availableColumns = availableColumns.filter(
        (col) => idSet.has(col.id)
      );
    }

    // メニューが指定されている場合、対応可能な担当者で絞り込む
    const matchedItem = await this.findTreatmentItem(menu);
    if (matchedItem && matchedItem.use_column.length > 0) {
      const allowedColumnIds = new Set(matchedItem.use_column);
      availableColumns = availableColumns.filter(
        (col) => allowedColumnIds.has(col.id)
      );
    }

    // 必要な連続枠数を計算（15分刻み）
    const requiredSlots = Math.ceil(durationMin / 15);

    // 診療時間を数値形式に変換（HHMM形式）
    const startTimeNum = String(dayData.start_hour).padStart(2, '0') + String(dayData.start_minute).padStart(2, '0');
    const endTimeNum = String(dayData.end_hour).padStart(2, '0') + String(dayData.end_minute).padStart(2, '0');

    // 診療時間内の時間枠をフィルタ
    const timeRows = dayData.time_rows.filter(
      (timeRow) => timeRow.time_num >= startTimeNum && timeRow.time_num < endTimeNum
    );

    // 指定時刻の時間枠インデックスを見つける
    const timeFromNum = timeFrom.replace(':', '');
    const startIndex = timeRows.findIndex((tr) => tr.time_num === timeFromNum);
    if (startIndex === -1) return null;

    // 空いている担当者を探す
    for (const column of availableColumns) {
      if (this.isStaffAvailable(column, timeRows, startIndex, requiredSlots, dayData.reserve_rows)) {
        return column.id;
      }
    }

    return null;
  }

  /**
   * 予約操作を一括処理する
   *
   * @param reservations 予約リクエストの配列
   * @returns 予約操作結果の配列
   */
  async processReservations(
    reservations: ReservationRequest[],
  ): Promise<ReservationResult[]>  {
    this.step(`processReservations: start (${reservations.length} reservations)`);
    const results: ReservationResult[] = [];

    for (const reservation of reservations) {
      this.step(`processReservations: processing ${reservation.operation} (${reservation.reservation_id})`);
      if (reservation.operation === 'create') {
        // Web予約設定による予約可能期間チェック
        const webSetting = await this.getWebSetting();
        if (webSetting) {
          const nowJst = dayjs().tz('Asia/Tokyo');
          const slotDateTime = dayjs(`${reservation.slot.date} ${reservation.slot.start_at}`, 'YYYY-MM-DD HH:mm').tz('Asia/Tokyo', true);

          // display_from_day: n日後からのみ予約可能
          if (webSetting.display_from_day != null) {
            const earliestDate = nowJst.startOf('day').add(webSetting.display_from_day, 'day');
            if (slotDateTime.isBefore(earliestDate)) {
              results.push({
                reservation_id: reservation.reservation_id,
                operation: 'create',
                result: {
                  status: 'failed',
                  error_code: 'INVALID_REQUEST',
                  error_message: `予約可能期間外です（${webSetting.display_from_day}日後以降のみ予約可能）`,
                },
              });
              continue;
            }
          }

          // reservation_deadline: 予約時刻のn時間前まで受付可能
          if (webSetting.reservation_deadline != null) {
            const deadlineHours = parseInt(webSetting.reservation_deadline, 10);
            if (!isNaN(deadlineHours) && nowJst.isAfter(slotDateTime.subtract(deadlineHours, 'hour'))) {
              results.push({
                reservation_id: reservation.reservation_id,
                operation: 'create',
                result: {
                  status: 'failed',
                  error_code: 'INVALID_REQUEST',
                  error_message: `予約締切を過ぎています（予約時刻の${deadlineHours}時間前まで受付可能）`,
                },
              });
              continue;
            }
          }
        }

        // notesの[patient]タグによる患者特定（patient_number + birthdayで検索）
        if (reservation.notes) {
          const patientTagMatch = reservation.notes.match(/\[patient\](.*?)\[\/patient\]/);
          if (patientTagMatch) {
            const tagContent = patientTagMatch[1];
            const birthdayMatch = tagContent.match(/birthday:\s*(\S+)/);
            const idMatch = tagContent.match(/id:\s*(\S+)/);
            const tagBirthday = birthdayMatch?.[1]?.replace(/,\s*$/, '');
            const tagPatientNumber = idMatch?.[1]?.replace(/,\s*$/, '');

            if (tagPatientNumber) {
              // 患者番号で直接検索（/patients/number/{patient_number}）
              const patientResult = await this.apiClient.get<PatientDetailResponse['data']>(
                `/patients/number/${tagPatientNumber}`,
              );

              if (patientResult.result && patientResult.data) {
                // 生年月日の一致チェック
                if (tagBirthday && patientResult.data.birthday !== tagBirthday) {
                  console.log(`[DEBUG] [patient]タグ: 生年月日不一致 (期待:${tagBirthday}, 実際:${patientResult.data.birthday})`);
                  results.push({
                    reservation_id: reservation.reservation_id,
                    operation: 'create',
                    result: {
                      status: 'failed',
                      error_code: 'INVALID_REQUEST',
                      error_message: `患者情報が一致しません（患者番号: ${tagPatientNumber}, 生年月日不一致）`,
                    },
                  });
                  continue;
                }
                // 患者番号で特定できた → customer_idを上書き、名前をフリガナに置き換え
                console.log(`[DEBUG] [patient]タグで患者特定: patient_number=${tagPatientNumber}, id=${patientResult.data.id}, name_kana=${patientResult.data.name_kana}`);
                reservation.customer.customer_id = tagPatientNumber;
                if (patientResult.data.name_kana) {
                  reservation.customer.name = patientResult.data.name_kana;
                }
              } else {
                // 患者番号が見つからない → エラー
                console.log(`[DEBUG] [patient]タグで患者特定失敗: patient_number=${tagPatientNumber}`);
                results.push({
                  reservation_id: reservation.reservation_id,
                  operation: 'create',
                  result: {
                    status: 'failed',
                    error_code: 'INVALID_REQUEST',
                    error_message: `患者が見つかりません（患者番号: ${tagPatientNumber}）`,
                  },
                });
                continue;
              }
            }
          }
        }

        // 予約日を読み込む（担当者検索のため）
        await this.selectDate(reservation.slot.date);

        // メニューの時間を取得（external_menu_id指定時はメニュー時間を優先）
        const matchedMenuItem = await this.findTreatmentItem(reservation.menu);
        const menuDuration = matchedMenuItem?.treatment_time;
        const effectiveDuration = menuDuration ?? reservation.slot.duration_min ?? 45;
        console.log(`[DEBUG] processReservations: menuDuration=${menuDuration}, slot.duration_min=${reservation.slot.duration_min}, effectiveDuration=${effectiveDuration}`);

        // 担当者IDを決定
        let columnNo: number;
        const staffInfo = reservation.staff;
        const preference = staffInfo?.preference || 'any';

        if (preference === 'specific' && staffInfo?.staff_id) {
          // specific指定で staff_id がある場合はそれを使用
          columnNo = parseInt(staffInfo.staff_id, 10);
        } else {
          // preference が 'any' または staff_id がない場合は自動選択
          const availableStaffId = await this.findAvailableStaff(
            reservation.slot.start_at,
            effectiveDuration,
            reservation.menu,
            reservation.resource_ids
          );

          if (!availableStaffId) {
            results.push({
              reservation_id: reservation.reservation_id,
              operation: 'create',
              result: {
                status: 'conflict',
                error_code: 'NO_AVAILABLE_STAFF',
                error_message: `指定時間枠（${reservation.slot.date} ${reservation.slot.start_at} ～ ${effectiveDuration}分 ）に空いている担当者がいません`,
              },
            });
            continue;
          }
          columnNo = availableStaffId;
        }

        const result = await this.createReservation({
          date: reservation.slot.date,
          timeFrom: reservation.slot.start_at,
          timeTo: reservation.slot.end_at || undefined,
          durationMin: reservation.slot.duration_min || undefined,
          columnNo,
          customerName: reservation.customer.name,
          patientId: reservation.customer.customer_id || undefined,
          menu: reservation.menu,
          customerPhone: reservation.customer.phone || undefined,
        });

        if ('error' in result) {
          results.push({
            reservation_id: reservation.reservation_id,
            operation: 'create',
            result: {
              status: 'failed',
              error_message: result.error,
            },
          });
        } else {
          results.push({
            reservation_id: reservation.reservation_id,
            operation: 'create',
            result: {
              status: 'success',
              external_reservation_id: result.reservationId,
              duration_min: effectiveDuration,
            },
          });
        }
      } else if (reservation.operation === 'update') {
        // 予約更新
        const result = await this.updateReservation({
          date: reservation.slot.date,
          time: reservation.slot.start_at,
          desired: reservation.slot.desired,
          customerPhone: reservation.customer.phone,
          menu: reservation.menu,
        });

        if ('error' in result) {
          results.push({
            reservation_id: reservation.reservation_id,
            operation: 'update',
            result: {
              status: 'failed',
              error_message: result.error,
              pic: result.pic,
            },
          });
        } else {
          results.push({
            reservation_id: reservation.reservation_id,
            operation: 'update',
            result: {
              status: 'success',
              external_reservation_id: result.reservationId,
            },
          });
        }
      } else if (reservation.operation === 'cancel') {
        // 予約キャンセル
        const result = await this.cancelReservation({
          date: reservation.slot.date,
          time: reservation.slot.start_at,
          customerPhone: reservation.customer.phone,
        });

        if ('error' in result) {
          results.push({
            reservation_id: reservation.reservation_id,
            operation: 'cancel',
            result: {
              status: 'failed',
              error_message: result.error,
            },
          });
        } else {
          results.push({
            reservation_id: reservation.reservation_id,
            operation: 'cancel',
            result: {
              status: 'success',
              external_reservation_id: result.reservationId,
            },
          });
        }
      } else if (reservation.operation === 'delete') {
        // 予約削除
        const result = await this.deleteReservation({
          date: reservation.slot.date,
          time: reservation.slot.start_at,
          customerPhone: reservation.customer.phone,
        });

        if ('error' in result) {
          results.push({
            reservation_id: reservation.reservation_id,
            operation: 'delete',
            result: {
              status: 'failed',
              error_message: result.error,
            },
          });
        } else {
          results.push({
            reservation_id: reservation.reservation_id,
            operation: 'delete',
            result: {
              status: 'success',
              external_reservation_id: result.reservationId,
            },
          });
        }
      }
    }
    this.step(`processReservations: complete (${results.length} results)`);
    return results;
  }

  /**
   * 電話番号と日時から予約を見つける
   *
   * /reservations APIを直接呼び出して、メモ内の電話番号と時刻で予約を特定する
   *
   * @param date 予約日（YYYY-MM-DD形式）
   * @param time 開始時刻（HH:MM形式）
   * @param customerPhone 顧客電話番号
   * @returns 予約ID、または見つからない場合はnull
   */
  async findReservationByPhoneAndTime(
    date: string,
    time: string,
    customerPhone: string,
  ): Promise<{ reservationId: string; columnNo: number; pic: { id: number; name: string }[] | null } | null> {
    // /reservations APIで指定日の予約を取得
    const resp = await this.apiClient.get<ReservationsListResponse['data']>(
      '/reservations',
      { from: date, days: 1 },
    );
    if (!resp.result || !resp.data?.reservations) {
      return null;
    }

    const reservations = resp.data.reservations;

    // 時刻と電話番号（メモ内）が一致する予約を探す
    let matched = reservations.find((reservation) => {
      if (reservation.cancel === 1) return false;
      if (time && reservation.time_from !== time) return false;
      if (reservation.memo && reservation.memo.length > 0) {
        const memoText = reservation.memo.map((m) => m.memo || '').join(' ');
        if (memoText.includes(`tel:[${customerPhone}]`)) return true;
      }
      return false;
    });

    // フォールバック: patient_number から電話番号の正引きでマッチング
    // （メモに電話番号が記録されていない予約 = EasyApo直接登録等 に対応）
    if (!matched) {
      const timeCandidates = reservations.filter((reservation) => {
        if (reservation.cancel === 1) return false;
        if (time && reservation.time_from !== time) return false;
        return !!reservation.patient_number;
      });

      if (timeCandidates.length > 0) {
        const telLast4 = phoneLast4(customerPhone);
        const searchResp = await this.apiClient.get<PatientsOrSearchResponse['data']>('/patients', {
          or_search: 0,
          patient_name: '',
          patient_name_kana: '',
          tel: telLast4,
          sort_order: 'patient_number',
        });

        if (searchResp.result && searchResp.data?.patients?.length) {
          const phoneMatchedPatients: PatientSearchItem[] = [];
          for (const p of searchResp.data.patients) {
            if (p.tel1 && phoneEndsWith(p.tel1, customerPhone)) {
              phoneMatchedPatients.push(p);
            } else {
              const detail = await this.getPatientDetail(p.id);
              if (detail?.data?.tel2 && phoneEndsWith(detail.data.tel2, customerPhone)) {
                phoneMatchedPatients.push(p);
              }
            }
          }
          const matchedPatientNumbers = new Set(
            phoneMatchedPatients.map((p) => p.patient_number),
          );
          matched = timeCandidates.find(
            (reservation) => matchedPatientNumbers.has(reservation.patient_number),
          );
        }
      }
    }

    if (!matched) return null;

    return {
      reservationId: String(matched.id),
      columnNo: matched.column_no,
      pic: matched.pic ?? null,
    };
  }

  /**
   * 予約を更新する
   */
  async updateReservation({
    date,
    time,
    desired,
    customerPhone,
    menu,
  }: {
    /** 予約日（YYYY-MM-DD形式） */
    date: string;
    /** 開始時刻（HH:MM形式） */
    time: string;
    /** 変更後の希望日時 */
    desired?: {
      date?: string;
      time?: string;
    };
    /** 顧客電話番号（予約特定用） */
    customerPhone: string;
    /** 新しいメニュー情報（メモに設定） */
    menu?: MenuInfo;
  }): Promise<{ reservationId: string } | { error: string; pic?: { id: number; name: string }[] }> {
    this.step(`updateReservation: start (${date} ${time}, ${customerPhone})`);

    // 1. 日付設定
    await this.selectDate(date);

    // 2. 予約特定
    const found = await this.findReservationByPhoneAndTime(date, time, customerPhone);
    if (!found) {
      return { error: `予約が見つかりません: ${date} ${time} ${customerPhone}` };
    }
    this.step(`updateReservation: reservation found (id: ${found.reservationId})`);

    // 3. 既存予約の完全データを取得（更新body組み立てのベース）
    const detail = await this.getReservationDetail(parseInt(found.reservationId, 10));
    const existing = detail?.data;
    if (!existing) {
      return { error: '予約詳細の取得に失敗しました' };
    }

    // 4. menu未指定なら既存memoから「【SmartCall予約】 症状:[xxx]」を解析して復元
    if (!menu?.menu_name && !menu?.external_menu_id) {
      const smartcallMemo = existing.memo?.find((m) => m.memo?.includes('【SmartCall予約】'));
      if (smartcallMemo?.memo) {
        const match = smartcallMemo.memo.match(/症状:\[([^\]]*)\]/);
        if (match?.[1]) {
          if (!menu) menu = { menu_name: '' };
          menu.menu_name = match[1];
          this.step(`updateReservation: extracted menu name from memo: ${menu.menu_name}`);
        }
      }
    }

    // 5. メニュー特定
    const matchedItem = await this.findTreatmentItem(menu);
    const menuColor = matchedItem?.color;
    const menuTreatmentTime = matchedItem?.treatment_time;

    // 6. 日時変更ありかつpicが設定されている場合、変更先でpicが空いているかチェック
    if ((desired?.date || desired?.time) && found.pic?.length) {
      const targetDate = desired.date || date;
      const targetTime = desired.time || time;
      const picIds = found.pic.map((p) => p.id);
      const durationMin = menuTreatmentTime ?? 45;

      await this.selectDate(targetDate);
      const targetDayData = await this.getReserveDayData();

      if (targetDayData) {
        const startTimeNum = String(targetDayData.start_hour).padStart(2, '0') + String(targetDayData.start_minute).padStart(2, '0');
        const endTimeNum = String(targetDayData.end_hour).padStart(2, '0') + String(targetDayData.end_minute).padStart(2, '0');
        const timeRows = targetDayData.time_rows.filter(
          (tr) => tr.time_num >= startTimeNum && tr.time_num < endTimeNum,
        );
        const targetTimeNum = targetTime.replace(':', '');
        const startIndex = timeRows.findIndex((tr) => tr.time_num === targetTimeNum);
        const requiredSlots = Math.ceil(durationMin / 15);

        if (startIndex !== -1) {
          const picAvailable = this.isPicAvailable(
            picIds, timeRows, startIndex, requiredSlots,
            targetDayData.reserve_rows, Number(found.reservationId),
          );
          if (!picAvailable) {
            const picNames = found.pic.map((p) => p.name).join('、');
            await this.selectDate(date);
            return {
              error: `担当者（${picNames}）が指定の時間帯（${targetDate} ${targetTime}）に空いていません`,
              pic: found.pic,
            };
          }
        }
      }
      await this.selectDate(date);
    }

    // 7. 更新body組み立て（既存データをベースに変更を適用）
    // treatment_id（診療内容＝施術手技）は来院後にスタッフが付ける値。
    // 予約変更でメニュー（症状）から推定して上書きすると、確定済みの施術記録を壊すため、
    // 既存値をそのまま維持する（無ければ null）。
    const newTreatmentId = existing.treatment_id ?? null;
    const parseHm = (t: string): [number, number] => {
      const [h, m] = t.split(':').map((s) => parseInt(s, 10));
      return [Number.isNaN(h) ? 0 : h, Number.isNaN(m) ? 0 : m];
    };
    const buildBody = (columnNo?: number) => {
      let newReservationDate = existing.reservation_date;
      let newTimeFrom = existing.time_from;
      let newTimeTo = existing.time_to;

      if (desired?.date) newReservationDate = desired.date;
      if (desired?.time) {
        // 所要時間を維持して終了時刻を計算
        const [fromH, fromM] = parseHm(existing.time_from);
        const [toH, toM] = parseHm(existing.time_to);
        const durationMinutes = (toH * 60 + toM) - (fromH * 60 + fromM);
        newTimeFrom = desired.time;
        const [newFromH, newFromM] = parseHm(desired.time);
        const newToMins = newFromH * 60 + newFromM + (durationMinutes > 0 ? durationMinutes : 45);
        newTimeTo = `${String(Math.floor(newToMins / 60)).padStart(2, '0')}:${String(newToMins % 60).padStart(2, '0')}`;
      } else if (menuTreatmentTime) {
        // メニュー変更による所要時間変更
        newTimeTo = dayjs(`${date} ${time}`, 'YYYY-MM-DD HH:mm')
          .add(menuTreatmentTime, 'minute')
          .format('HH:mm');
      }

      // memo更新（既存の【SmartCall予約】メモを上書き、なければ追加）
      const memo: Array<{ id: number; memo: string }> = existing.memo
        ? existing.memo.map((m) => ({ id: m.id, memo: m.memo ?? '' }))
        : [];
      const menuName = matchedItem?.title || menu?.menu_name;
      if (menuName) {
        const newMemoText = `【SmartCall予約】 症状:[${menuName}]、tel:[${customerPhone}]`;
        const idx = memo.findIndex((m) => m.memo.includes('【SmartCall予約】'));
        if (idx >= 0) {
          memo[idx] = { ...memo[idx], memo: newMemoText };
        } else {
          memo.push({ id: 1, memo: newMemoText });
        }
      }

      return {
        id: existing.id,
        column_no: columnNo ?? existing.column_no,
        status: existing.status,
        reservation_date: newReservationDate,
        time_from: newTimeFrom,
        time_to: newTimeTo,
        // 診療内容は既存値を維持（updateReservation本体で解決済み）
        treatment_id: newTreatmentId,
        patient_name: existing.patient_name,
        color: menuColor ?? existing.color ?? '#FFFFFF',
        pic: existing.pic ?? [null, null, null],
        memo,
        patient_number: existing.patient?.patient_number ?? '',
      };
    };

    // 8. メニュー対応可能担当者チェック、必要なら別担当者を割り当て
    let targetColumnNo: number | undefined;
    if (matchedItem?.use_column?.length) {
      const allowedColumnIds = new Set(matchedItem.use_column);
      if (!allowedColumnIds.has(found.columnNo)) {
        const durationMin = menuTreatmentTime ?? 45;
        const availableStaffId = await this.findAvailableStaff(time, durationMin, menu);
        if (availableStaffId && allowedColumnIds.has(availableStaffId)) {
          targetColumnNo = availableStaffId;
        } else {
          return {
            error: `メニュー「${matchedItem.title}」は現在の担当者では対応できません。同一時間帯に空いている対応可能な担当者もいません`,
          };
        }
      }
    }

    // 9. POST /reservations/{id} で更新
    const postResp = await this.apiClient.post<{ confirmation?: string }>(
      `/reservations/${found.reservationId}`,
      buildBody(targetColumnNo),
    );

    // 10. confirmation がある場合は失敗
    if (postResp.data?.confirmation) {
      const confirmationMessages = JSON.parse(postResp.data.confirmation) as string[];
      return { error: confirmationMessages.join(' ') };
    }

    // 11. result false なら、「別の予約」エラー時は他担当者へのリトライ
    if (!postResp.result) {
      let errorMessage = '予約更新に失敗しました';
      if (postResp.message) {
        const messages = typeof postResp.message === 'string'
          ? [postResp.message]
          : Object.values(postResp.message).flat();
        errorMessage = messages.join(' ') || errorMessage;
      }

      if (errorMessage.includes('別の予約') && (desired?.date || desired?.time)) {
        const targetDate = desired.date || date;
        const targetTime = desired.time || time;
        await this.selectDate(targetDate);
        const durationMin = menuTreatmentTime ?? 45;
        const availableStaffId = await this.findAvailableStaff(targetTime, durationMin, menu);
        if (availableStaffId) {
          const retryResp = await this.apiClient.post<{ confirmation?: string }>(
            `/reservations/${found.reservationId}`,
            buildBody(availableStaffId),
          );
          if (retryResp.result && !retryResp.data?.confirmation) {
            this.step(`updateReservation: complete (retry with column ${availableStaffId})`);
            return { reservationId: found.reservationId };
          }
          let retryErrorMessage = '予約更新に失敗しました（再試行後）';
          if (retryResp.message) {
            const messages = typeof retryResp.message === 'string'
              ? [retryResp.message]
              : Object.values(retryResp.message).flat();
            retryErrorMessage = messages.join(' ') || retryErrorMessage;
          }
          return { error: retryErrorMessage };
        }
        return { error: `${errorMessage}（空いている担当者が見つかりませんでした）` };
      }

      return { error: errorMessage };
    }

    this.step(`updateReservation: complete (reservationId: ${found.reservationId})`);
    return { reservationId: found.reservationId };
  }

  /** キャンセル/削除種別 */
  private static readonly CIRCUMSTANCE_TYPE = {
    /** キャンセル（予約履歴を残す） */
    CANCEL: 1,
    /** 削除（予約履歴を残さない） */
    DELETE: 99,
  } as const;

  /** キャンセル種類 */
  private static readonly CANCEL_TYPE = {
    /** 電話でのキャンセル */
    TEL: 1,
  } as const;

  /**
   * 予約をキャンセルまたは削除する（共通処理）
   */
  private async cancelOrDeleteReservation({
    date,
    time,
    customerPhone,
    circumstanceType,
  }: {
    /** 予約日（YYYY-MM-DD形式） */
    date: string;
    /** 開始時刻（HH:MM形式） */
    time: string;
    /** 顧客電話番号（予約特定用） */
    customerPhone: string;
    /** キャンセル/削除種別（1: キャンセル, 99: 削除） */
    circumstanceType: typeof AppointPage.CIRCUMSTANCE_TYPE[keyof typeof AppointPage.CIRCUMSTANCE_TYPE];
  }): Promise<{ reservationId: string } | { error: string }> {
    const isDelete = circumstanceType === AppointPage.CIRCUMSTANCE_TYPE.DELETE;
    const operationName = isDelete ? '削除' : 'キャンセル';
    this.step(`cancelOrDeleteReservation: start ${operationName} (${date} ${time}, ${customerPhone})`);

    // 1. 日付設定
    await this.selectDate(date);

    // 2. 予約特定
    const found = await this.findReservationByPhoneAndTime(date, time, customerPhone);
    if (!found) {
      return { error: `予約が見つかりません: ${date} ${time} ${customerPhone}` };
    }
    this.step(`cancelOrDeleteReservation: reservation found (id: ${found.reservationId})`);

    // 3. POST /reservations/{id}/cancel
    // 注意: 旧コードでは削除時に cancel_type を undefined にしていたが、
    //       実APIは circumstance_type=99 (削除) でも cancel_type 必須。
    const postResp = await this.apiClient.post(
      `/reservations/${found.reservationId}/cancel`,
      {
        circumstance_type: circumstanceType,
        cancel_type: AppointPage.CANCEL_TYPE.TEL,
      },
    );

    if (!postResp.result) {
      let errorMessage = `予約${operationName}に失敗しました`;
      if (postResp.message) {
        const messages = typeof postResp.message === 'string'
          ? [postResp.message]
          : Object.values(postResp.message).flat();
        errorMessage = messages.join(' ') || errorMessage;
      }
      return { error: errorMessage };
    }

    this.step(`cancelOrDeleteReservation: complete (reservationId: ${found.reservationId})`);
    return { reservationId: found.reservationId };
  }

  /**
   * 予約をキャンセルする
   */
  async cancelReservation(params: {
    /** 予約日（YYYY-MM-DD形式） */
    date: string;
    /** 開始時刻（HH:MM形式） */
    time: string;
    /** 顧客電話番号（予約特定用） */
    customerPhone: string;
  }): Promise<{ reservationId: string } | { error: string }> {
    return this.cancelOrDeleteReservation({
      ...params,
      circumstanceType: AppointPage.CIRCUMSTANCE_TYPE.CANCEL,
    });
  }

  /**
   * 予約を削除する
   */
  async deleteReservation(params: {
    /** 予約日（YYYY-MM-DD形式） */
    date: string;
    /** 開始時刻（HH:MM形式） */
    time: string;
    /** 顧客電話番号（予約特定用） */
    customerPhone: string;
  }): Promise<{ reservationId: string } | { error: string }> {
    return this.cancelOrDeleteReservation({
      ...params,
      circumstanceType: AppointPage.CIRCUMSTANCE_TYPE.DELETE,
    });
  }

}
