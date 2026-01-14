/**
 * アポイント管理台帳ページ Page Object
 *
 * 空き枠の取得、予約の作成・キャンセルを行う
 */

import {
  BasePage,
  type ReservationRequest as ReservationRequestBase,
  type ScreenshotManager,
} from '@smartcall/rpa-sdk';
import type { Page } from 'playwright';
import type {
  SideMain,
  ReserveDay,
  ColumnRow,
  TimeRow,
  ReserveRow,
  TreatmentItem,
  TreatmentItemsResponse,
  PatientsSearchResponse,
  PatientSearchItem,
  PatientDetailResponse,
  ReservationDetailResponse,
} from '../types/easyapo.d.ts';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);

/**
 * 予約リクエスト（SDKの型を拡張してdeleteオペレーションを追加）
 */
export type ReservationRequest = Omit<ReservationRequestBase, 'operation'> & {
  operation: ReservationRequestBase['operation'] | 'delete' | 'update';
};

/**
 * 予約結果詳細
 */
export interface ReservationResultDetail {
  status: 'success' | 'failed' | 'conflict';
  external_reservation_id?: string;
  error_code?: string;
  error_message?: string;
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
  }

  /**
   * ローディング表示が消えるまで待機
   */
  private async waitForLoading(): Promise<void> {
    await this.page.waitForSelector('#loading', { state: 'hidden' });
  }

  /**
   * アポイント管理台帳ページに遷移
   */
  async navigate(baseUrl: string): Promise<void> {
    await this.goto(`${baseUrl}/`);
    // メインコンポーネントが表示されるまで待機
    await this.page.waitForSelector('#col-main > div');
    await this.page.waitForSelector('#col-side > div');
    await this.waitForLoading();
  }

  /**
   * 指定日付の予約データを読み込む（カレンダーで日付を選択）
   */
  private async selectDate(dateStr: string): Promise<void> {
    await this.waitForLoading();
    // 予約データ取得APIのレスポンスを監視
    const reservationsResponsePromise = this.page.waitForResponse(
      (response) => response.url().includes('/reservations?') && response.request().method() === 'GET'
    );

    // カレンダーコンポーネントのclickDayを呼び出す
    await this.page.evaluate(
      (dateId) => {
        const el = document.querySelector('#col-side > div')
        const calendar = (el as (null | HTMLElement & { __vue__: SideMain }))?.__vue__;
        if (calendar) {
          calendar.clickDay({ id: dateId });
        }
      },
      dateStr
    );

    // APIレスポンスを待機
    await reservationsResponsePromise;

    await this.waitForLoading();
  }

  /**
   * 予約日コンポーネントからデータを取得
   */
  private async getReserveDayData(): Promise<{
    reserve_rows: ReserveRow[];
    column_rows: ColumnRow[];
    time_rows: TimeRow[];
    start_hour: number;
    start_minute: number;
    end_hour: number;
    end_minute: number;
  } | null> {
    return await this.page.evaluate(
      () => {
        const el = document.querySelector('#col-main > div')
        const appoint = (el as (null | HTMLElement & { __vue__: ReserveDay }))?.__vue__;
        if (!appoint) return null;
        return {
          reserve_rows: appoint.reserve_rows,
          column_rows: appoint.column_rows,
          time_rows: appoint.time_rows,
          start_hour: appoint.start_hour,
          start_minute: appoint.start_minute,
          end_hour: appoint.end_hour,
          end_minute: appoint.end_minute,
        };
      }
    );
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
   * 1日分の空き枠を取得
   */
  private getAvailableSlotsForDate(
    dateStr: string,
    dayData: NonNullable<Awaited<ReturnType<typeof this.getReserveDayData>>>,
    resources: string[] | undefined,
    duration: number | undefined
  ): SlotInfo[] {
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

    // 必要な連続枠数を計算（15分刻み）
    const requiredSlots = duration ? Math.ceil(duration / 15) : 1;

    // 診療時間内の時間枠をフィルタ
    const timeRows = dayData.time_rows.filter(
      (timeRow) => timeRow.time_num >= startTimeNum && timeRow.time_num < endTimeNum
    );

    // 各時間枠をチェック
    for (let i = 0; i < timeRows.length; i++) {
      const timeRow = timeRows[i];

      // 休憩時間はスキップ
      if (this.isBreakTime(timeRow)) continue;

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
   * 指定日付の空き枠を取得
   *
   * @param params.dateFrom 開始日 (YYYY-MM-DD)
   * @param params.dateTo 終了日 (YYYY-MM-DD)
   * @param params.resources 対象リソース名の配列（指定した場合、このリソースのみを対象とする）
   * @param params.duration 所要時間（分）。指定した場合、同一担当者で連続して確保できる枠のみを返す
   */
  async getAvailableSlots({ dateFrom, dateTo, resources, duration }: {
    dateFrom: string;
    dateTo: string;
    resources?: string[];
    duration?: number;
  }): Promise<SlotInfo[]> {
    const slots: SlotInfo[] = [];
    const startDate = dayjs(dateFrom);
    const endDate = dayjs(dateTo);

    let currentDate = startDate;
    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, 'day')) {
      const dateStr = currentDate.format('YYYY-MM-DD');

      await this.selectDate(dateStr);
      const dayData = await this.getReserveDayData();

      if (dayData) {
        const daySlots = this.getAvailableSlotsForDate(dateStr, dayData, resources, duration);
        slots.push(...daySlots);
      }

      currentDate = currentDate.add(1, 'day');
    }

    return slots;
  }

  /**
   * 診療メニュー一覧を取得
   *
   * @returns 診療メニュー一覧（所要時間、処置可能担当者を含む）
   */
  async getTreatmentItems(): Promise<TreatmentItem[]> {
    const result = await this.page.evaluate(async () => {
      const el = document.querySelector('#col-main > div');
      const reserveDay = (el as (null | HTMLElement & { __vue__: ReserveDay }))?.__vue__;
      if (!reserveDay) return null;

      const apiUrl = reserveDay.$store.state.api.get_treatment_items;
      const response = await reserveDay.get<TreatmentItemsResponse>(apiUrl, {});
      const columnRows = reserveDay.column_rows;

      // response.dataがAPIレスポンス本体（Axiosレスポンス形式）
      return { apiResponse: response?.data, columnRows };
    });

    if (!result || !result.apiResponse || !result.apiResponse.result || !result.apiResponse.data) {
      return [];
    }

    // use_columnのIDを担当者名に変換
    const columnMap = new Map(result.columnRows.map((col) => [col.id, col.name]));

    return result.apiResponse.data.treatment_items.map((item) => ({
      ...item,
      resources: item.use_column
        .map((id) => columnMap.get(id))
        .filter((name): name is string => name !== undefined),
    }));
  }

  /**
   * 患者詳細を取得（予約履歴を含む）
   */
  private async getPatientDetail(patientId: number): Promise<PatientDetailResponse | null> {
    return await this.page.evaluate(
      async (id) => {
        const el = document.querySelector('#col-main > div');
        const reserveDay = (el as (null | HTMLElement & { __vue__: ReserveDay }))?.__vue__;
        if (!reserveDay) return null;

        const response = await reserveDay.get<PatientDetailResponse>(
          `/patients/${id}`,
          { id, original: true }
        );
        return response?.data ?? null;
      },
      patientId
    );
  }

  /**
   * 予約詳細を取得
   */
  private async getReservationDetail(reservationId: number): Promise<ReservationDetailResponse | null> {
    return await this.page.evaluate(
      async (id) => {
        const el = document.querySelector('#col-main > div');
        const reserveDay = (el as (null | HTMLElement & { __vue__: ReserveDay }))?.__vue__;
        if (!reserveDay) return null;

        const response = await reserveDay.get<ReservationDetailResponse>(
          `/reservations/${id}`,
          { id, original: true }
        );
        return response?.data ?? null;
      },
      reservationId
    );
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
    customerPhone: string
  ): Promise<ReservationSearchResult[]> {
    await this.waitForLoading();

    // 患者検索APIのレスポンスを監視
    const patientsResponsePromise = this.page.waitForResponse(
      (response) => response.url().includes('/patients?') && response.request().method() === 'GET'
    );

    // SideMainで患者検索を実行
    await this.page.evaluate(
      (phone) => {
        const el = document.querySelector('#col-side > div');
        const sideMain = (el as (null | HTMLElement & { __vue__: SideMain }))?.__vue__;
        if (sideMain) {
          sideMain.s_q = phone;
          sideMain.clickSearch();
        }
      },
      customerPhone
    );

    // 患者検索APIのレスポンスを取得
    const patientsResponse = await patientsResponsePromise;
    const patientsData = await patientsResponse.json() as PatientsSearchResponse;
    if (!patientsData.result || !patientsData.data || !patientsData.data.patients.length) {
      return [];
    }

    // 電話番号が一致する患者をすべて検索（tel1またはtel2、家族など複数人の可能性あり）
    const matchedPatients = patientsData.data.patients.filter(
      (patient: PatientSearchItem) => patient.tel1 === customerPhone || patient.tel2 === customerPhone
    );
    if (matchedPatients.length === 0) {
      return [];
    }

    const results: ReservationSearchResult[] = [];

    // 各患者の予約を取得
    for (const patient of matchedPatients) {
      const patientDetail = await this.getPatientDetail(patient.id);
      if (!patientDetail?.result || !patientDetail.data?.reservation_histories?.length) {
        continue;
      }

      // 日付範囲内の予約履歴をフィルタ
      const filteredHistories = patientDetail.data.reservation_histories.filter(
        (history) => history.reservation_date >= dateFrom && history.reservation_date <= dateTo
      );

      // 各予約の詳細を取得
      for (const history of filteredHistories) {
        const detail = await this.getReservationDetail(history.id);
        if (!detail?.result || !detail.data) {
          continue;
        }

        // キャンセル済みの予約は除外
        if (detail.data.cancel) {
          continue;
        }

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

    return results;
  }


  /**
   * 予約操作を一括処理する
   *
   * @param reservations 予約リクエストの配列
   * @param staffId スタッフID
   * @returns 予約操作結果の配列
   */
  async processReservations(
    reservations: ReservationRequest[],
    staffId?: string,
  ): Promise<ReservationResult[]>  {
    return []; // TODO
  }

}
