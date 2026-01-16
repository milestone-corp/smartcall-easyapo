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
  SideMain,
  ReserveDay,
  ReserveAdd,
  ReserveEdit,
  PatientList,
  ColumnRow,
  TimeRow,
  ReserveRow,
  TreatmentItem,
  TreatmentItemsResponse,
  PatientsSearchResponse,
  PatientSearchItem,
  PatientDetailResponse,
  ReservationDetailResponse,
  ReservationApiResponse,
  ReservationsListResponse,
  CancelAdd,
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
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: SideMain }>('*')).find(el => el?.__vue__?.$vnode?.tag?.endsWith('SideMain'));
        const calendar = el?.__vue__;
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
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveDay }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveDay'));
        const appoint = el?.__vue__;
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
   * @param params.menu メニュー情報（指定時はメニューのresources/treatment_timeで絞り込み・調整）
   */
  async getAvailableSlots({ dateFrom, dateTo, resources, duration, menu }: {
    dateFrom: string;
    dateTo: string;
    resources?: string[];
    duration?: number;
    menu?: MenuInfo;
  }): Promise<SlotInfo[]> {
    // メニューから診療メニュー情報を取得
    const matchedItem = await this.findTreatmentItem(menu);

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

    const slots: SlotInfo[] = [];
    const startDate = dayjs(dateFrom);
    const endDate = dayjs(dateTo);

    let currentDate = startDate;
    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, 'day')) {
      const dateStr = currentDate.format('YYYY-MM-DD');

      await this.selectDate(dateStr);
      const dayData = await this.getReserveDayData();

      if (dayData) {
        const daySlots = this.getAvailableSlotsForDate(dateStr, dayData, effectiveResources, effectiveDuration);
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
      const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveDay }>('*'))
        .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveDay'));
      const reserveDay = el?.__vue__;
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
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveDay }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveDay'));
        const reserveDay = el?.__vue__;
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
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveDay }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveDay'));
        const reserveDay = el?.__vue__;
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
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: SideMain }>('*')).find(el => el?.__vue__?.$vnode?.tag?.endsWith('SideMain'));
        const sideMain = el?.__vue__;
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

    // 患者が見つからない場合、PatientListダイアログを閉じてメモ内の電話番号で検索
    if (!patientsData.result || !patientsData.data?.patients?.length) {
      await this.page.evaluate(() => {
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: PatientList }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('PatientList'));
        el?.__vue__?.clickClose();
      });
      return await this.searchReservationsByMemo(dateFrom, dateTo, customerPhone);
    }

    // 電話番号が一致する患者をすべて検索（tel1またはtel2、家族など複数人の可能性あり）
    const matchedPatients = patientsData.data.patients.filter(
      (patient: PatientSearchItem) => patient.tel1 === customerPhone || patient.tel2 === customerPhone
    );

    // 電話番号が一致する患者がいない場合、PatientListダイアログを閉じてメモ内の電話番号で検索
    if (matchedPatients.length === 0) {
      await this.page.evaluate(() => {
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: PatientList }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('PatientList'));
        el?.__vue__?.clickClose();
      });
      return await this.searchReservationsByMemo(dateFrom, dateTo, customerPhone);
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

    // 各日の予約を検索
    for (let i = 0; i < diffDays; i++) {
      const currentDate = startDate.add(i, 'day').format('YYYY-MM-DD');

      // /reservations APIで指定日の予約を取得
      const apiResult = await this.page.evaluate(
        async ({ date }) => {
          const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveDay }>('*'))
            .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveDay'));
          const reserveDay = el?.__vue__;
          if (!reserveDay) return null;

          const response = await reserveDay.get<ReservationsListResponse>(
            '/reservations',
            { from: date, days: 1 }
          );
          return response?.data ?? null;
        },
        { date: currentDate }
      );

      if (!apiResult?.result || !apiResult.data?.reservations) {
        continue;
      }

      // メモ内の電話番号が一致する予約をすべて取得
      const matchedReservations = apiResult.data.reservations.filter((reservation) => {
        // キャンセル済みは除外
        if (reservation.cancel === 1) return false;

        // メモ内の電話番号を確認
        if (reservation.memo && reservation.memo.length > 0) {
          const memoText = reservation.memo.map((m) => m.memo || '').join(' ');
          // tel:[電話番号] 形式で電話番号を検索
          if (memoText.includes(`tel:[${customerPhone}]`)) {
            return true;
          }
        }

        return false;
      });

      // 検索結果を追加
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

    // 結果がある場合、一番最後の日付を読み込み
    if (results.length > 0) {
      const lastDate = results.reduce((latest, r) => r.date > latest ? r.date : latest, results[0].date);
      await this.page.evaluate(
        ({ date }) => {
          const calendar = Array.from(document.querySelectorAll<HTMLElement & { __vue__: SideMain }>('*'))
            .find(el => el?.__vue__?.$vnode?.tag?.endsWith('SideMain'))?.__vue__;
          calendar?.clickDay({ id: date });
        },
        { date: lastDate }
      );
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
    if (!menu?.menu_name && !menu?.external_menu_id) {
      return undefined;
    }
    const treatmentItems = await this.getTreatmentItems();
    return (
      menu.external_menu_id && treatmentItems.find((item) => String(item.id) === String(menu.external_menu_id)) ||
      treatmentItems.find((item) => item.title.includes(menu.menu_name)
    ));
  }

  /**
   * 予約を作成する
   *
   * @param params.date 予約日（YYYY-MM-DD形式）
   * @param params.timeFrom 開始時刻（HH:MM形式）
   * @param params.timeTo 終了時刻（HH:MM形式）。未指定の場合はduration_minから計算
   * @param params.durationMin 所要時間（分）。既定値は45分、2ヶ月以内の再診は30分
   * @param params.columnNo カラム番号（担当者ID）
   * @param params.customerName 顧客名（予約名として使用）
   * @param params.patientId 患者ID（既存患者の場合）
   * @param params.menu 診療メニュー情報（予約内容として選択）
   * @param params.customerPhone 顧客電話番号
   * @returns 作成された予約ID、または失敗時はエラー
   */
  async createReservation(params: {
    date: string;
    timeFrom: string;
    timeTo?: string;
    durationMin?: number;
    columnNo: number;
    customerName: string;
    patientId?: string;
    menu?: MenuInfo;
    customerPhone?: string;
  }): Promise<{ reservationId: string } | { error: string }> {
    const { date, timeFrom, timeTo, durationMin, columnNo, customerName, patientId, menu, customerPhone } = params;

    // 1. 予約日を読み込む
    await this.selectDate(date);

    // メニューからtreatment_timeとcolorを取得
    const matchedItem = await this.findTreatmentItem(menu);
    const menuTreatmentTime = matchedItem?.treatment_time;
    const menuColor = matchedItem?.color;

    // time_toを計算（優先順位: timeTo > durationMin > menuTreatmentTime > 既定値45分）
    const duration = durationMin ?? menuTreatmentTime ?? 45;
    const calculatedTimeTo = timeTo || dayjs(`${date} ${timeFrom}`, 'YYYY-MM-DD HH:mm')
      .add(duration, 'minute')
      .format('HH:mm');

    // 2. 予約作成ダイアログを開く
    await this.page.evaluate(
      ({ column_no, reservation_date, time_from, time_to }) => {
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveDay }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveDay'));
        const reserveDay = el?.__vue__;
        if (!reserveDay) throw new Error('ReserveDayコンポーネントが見つかりません');

        reserveDay.$store.commit('openReserveAdd', {
          column_no,
          reservation_date,
          time_from,
          time_to,
        });
      },
      {
        column_no: columnNo,
        reservation_date: date,
        time_from: timeFrom,
        time_to: calculatedTimeTo,
      }
    );

    // ダイアログが表示されるまで待機
    await this.page.waitForSelector('.alert-wrapper .alert h2');

    // 3. candidateがアクティブな場合はリセット
    await this.page.evaluate(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveDay }>('*'))
        .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveDay'));
      const reserveDay = el?.__vue__;
      if (reserveDay?.candidate?.is_active) {
        reserveDay.$store.commit('resetCandidate');
      }
    });

    // 4. ReserveAddコンポーネントを取得してフォームに入力
    // 患者ID入力（既存患者の場合）
    if (patientId) {
      // 患者検索APIのレスポンスを監視
      const patientSearchPromise = this.page.waitForResponse(
        (response) => response.url().includes('/patients/number/') && response.request().method() === 'GET'
      );

      // ReserveAddコンポーネントで患者番号を設定してgetPatient()を呼び出し
      await this.page.evaluate(
        ({ patientId }) => {
          const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveAdd }>('*'))
            .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveAdd'));
          const reserveAdd = el?.__vue__;
          if (!reserveAdd) throw new Error('ReserveAddコンポーネントが見つかりません');
          reserveAdd.form.patient_number = patientId;
          reserveAdd.getPatient();
        },
        { patientId }
      );

      // 患者検索APIのレスポンスを確認
      const patientSearchResponse = await patientSearchPromise;
      const patientSearchData = await patientSearchResponse.json() as { result: boolean; data: unknown; message: Record<string, string[]> | null };

      if (!patientSearchData.result) {
        // 患者が見つからなかった場合、アラートダイアログを閉じる
        const alertCloseButton = await this.page.$('#alert_common_wrapper .alert_common_label_close');
        if (alertCloseButton) {
          await alertCloseButton.click();
          // アラートが閉じるまで待機
          await this.page.waitForSelector('#alert_common_wrapper', { state: 'hidden' }).catch(() => {});
        }

        // 予約作成ダイアログを閉じる（ReserveAdd.clickClose()を使用）
        await this.page.evaluate(() => {
          const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveAdd }>('*'))
            .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveAdd'));
          el?.__vue__?.clickClose();
        });

        return { error: `患者ID「${patientId}」が見つかりません` };
      }
    }

    // 予約名（顧客名）、表示色、メモをReserveAddコンポーネントで設定
    await this.page.evaluate(
      ({ customerName, menuColor, menuName, customerPhone }) => {
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveAdd }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveAdd'));
        const reserveAdd = el?.__vue__;
        if (!reserveAdd) throw new Error('ReserveAddコンポーネントが見つかりません');

        // 予約名（顧客名）を入力
        reserveAdd.form.patient_name = customerName;

        // 表示色を設定
        if (menuColor) {
          reserveAdd.form.color = menuColor;
        }

        // 予約メモにメニュー名を入力
        if (menuName) {
          reserveAdd.addMemo();
          if (reserveAdd.form.memo.length > 0) {
            reserveAdd.form.memo[0].memo = `【SmartCall予約】 症状:[${menuName}]、tel:[${customerPhone || ''}]`;
          }
        }
      },
      { customerName, menuColor, menuName: matchedItem?.title || menu?.menu_name, customerPhone }
    );

    // 5. 予約APIのレスポンスを監視（POST: 作成、GET: 予約一覧取得）
    const postResponsePromise = this.page.waitForResponse(
      (response) => response.url().includes('/reservations') && response.request().method() === 'POST'
    );
    const getResponsePromise = this.page.waitForResponse(
      (response) => response.url().includes('/reservations?') && response.request().method() === 'GET'
    );

    // 「予約を作成」ボタンをクリック
    const createButton = await this.page.$('.alert-wrapper .contentfooter button.btn-primary');
    if (!createButton) {
      return { error: '予約作成ボタンが見つかりません' };
    }
    await createButton.click();

    // 6. POSTレスポンスを確認
    const postResponse = await postResponsePromise;
    const postResponseData = await postResponse.json() as ReservationApiResponse;

    // confirmationがある場合は失敗（診療時間外など）
    if (postResponseData.confirmation) {
      const confirmationMessages = JSON.parse(postResponseData.confirmation) as string[];
      const errorMessage = confirmationMessages.join(' ');
      console.error(`[AppointPage] 予約作成失敗（確認メッセージ）: ${errorMessage}`);

      // ページをリロードしてダイアログを閉じる
      await this.page.reload();
      await this.waitForLoading();

      return { error: errorMessage };
    }

    // resultがfalseの場合は失敗
    if (!postResponseData.result) {
      let errorMessage = '予約作成に失敗しました';
      if (postResponseData.message) {
        const messages = Object.values(postResponseData.message).flat();
        errorMessage = messages.join(' ') || errorMessage;
      }
      console.error(`[AppointPage] 予約作成失敗: ${errorMessage}`);

      // ページをリロードしてダイアログを閉じる
      await this.page.reload();
      await this.waitForLoading();

      return { error: errorMessage };
    }

    // 7. GETレスポンスから作成された予約IDを特定
    const getResponse = await getResponsePromise;
    const getResponseData = await getResponse.json() as ReservationsListResponse;

    if (!getResponseData.result || !getResponseData.data?.reservations) {
      return { error: '予約一覧の取得に失敗しました' };
    }

    // 作成した予約を特定（time_from, time_to, patient_name で絞り込み）
    const createdReservation = getResponseData.data.reservations.find((reservation) => {
      // 時間が一致するかチェック
      if (reservation.time_from !== timeFrom || reservation.time_to !== calculatedTimeTo) {
        return false;
      }

      // 患者番号が指定されている場合はpatient_numberで照合
      if (patientId) {
        return reservation.patient_number === patientId;
      }

      // 新規予約の場合はpatient_nameで照合
      return reservation.patient_name === customerName;
    });

    if (!createdReservation) {
      console.error(`[AppointPage] 作成した予約が見つかりませんでした: ${customerName} ${timeFrom}-${calculatedTimeTo}`);
      return { error: '作成した予約が見つかりませんでした' };
    }

    await this.waitForLoading();

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
    menu?: MenuInfo
  ): Promise<number | null> {
    // 予約日のデータを取得
    const dayData = await this.getReserveDayData();
    if (!dayData) return null;

    // 急患枠を除外した担当者リスト
    let availableColumns = dayData.column_rows.filter(
      (col) => col.name !== '急患'
    );

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
    const results: ReservationResult[] = [];

    for (const reservation of reservations) {
      if (reservation.operation === 'create') {
        // 予約日を読み込む（担当者検索のため）
        await this.selectDate(reservation.slot.date);

        // 担当者IDを決定
        let columnNo: number;
        const staffInfo = reservation.staff;
        const preference = staffInfo?.preference || 'any';

        if (preference === 'specific' && staffInfo?.staff_id) {
          // specific指定で staff_id がある場合はそれを使用
          columnNo = parseInt(staffInfo.staff_id, 10);
        } else {
          // preference が 'any' または staff_id がない場合は自動選択
          const durationMin = reservation.slot.duration_min || 45;
          const availableStaffId = await this.findAvailableStaff(
            reservation.slot.start_at,
            durationMin,
            reservation.menu
          );

          if (!availableStaffId) {
            results.push({
              reservation_id: reservation.reservation_id,
              operation: 'create',
              result: {
                status: 'failed',
                error_code: 'NO_AVAILABLE_STAFF',
                error_message: `指定時間枠（${reservation.slot.date} ${reservation.slot.start_at}）に空いている担当者がいません`,
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
            },
          });
        }
      } else if (reservation.operation === 'update') {
        // 予約更新
        const result = await this.updateReservation({
          date: reservation.slot.date,
          time: reservation.slot.start_at,
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
    await this.waitForNavigation();
    await this.waitForLoading();

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
    customerPhone: string
  ): Promise<{ reservationId: string; columnNo: number } | null> {
    // /reservations APIで指定日の予約を取得
    const result = await this.page.evaluate(
      async ({ date }) => {
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveDay }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveDay'));
        const reserveDay = el?.__vue__;
        if (!reserveDay) return null;

        const response = await reserveDay.get<ReservationsListResponse>(
          '/reservations',
          { from: date, days: 1 }
        );
        return response?.data ?? null;
      },
      { date }
    );

    if (!result?.result || !result.data?.reservations) {
      return null;
    }

    // 時刻と電話番号（メモ内）が一致する予約を探す
    const matched = result.data.reservations.find((reservation) => {
      // キャンセル済みは除外
      if (reservation.cancel === 1) return false;

      // 時刻が一致するか確認
      if (time && reservation.time_from !== time) return false;

      // メモ内の電話番号を確認
      if (reservation.memo && reservation.memo.length > 0) {
        const memoText = reservation.memo.map((m) => m.memo || '').join(' ');
        // tel:[電話番号] 形式で電話番号を検索
        if (memoText.includes(`tel:[${customerPhone}]`)) {
          return true;
        }
      }

      return false;
    });

    if (!matched) {
      return null;
    }

    return {
      reservationId: String(matched.id),
      columnNo: matched.column_no,
    };
  }

  /**
   * 予約編集ダイアログを開く
   *
   * @param reservationId 予約ID
   */
  private async openReserveEditDialog(reservationId: string): Promise<void> {
    // 予約編集ダイアログを開く
    await this.page.evaluate(
      (id) => {
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveDay & { openReserveEdit(id: number): void } }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveDay'));
        const reserveDay = el?.__vue__;
        if (!reserveDay) throw new Error('ReserveDayコンポーネントが見つかりません');
        reserveDay.openReserveEdit(parseInt(id, 10));
      },
      reservationId
    );

    // ダイアログが表示されるまで待機
    await this.page.waitForSelector('.alert-wrapper .alert h2');
    await this.waitForLoading();
  }

  /**
   * 予約を更新する（メモのみ）
   *
   * @param params.date 予約日（YYYY-MM-DD形式）
   * @param params.time 開始時刻（HH:MM形式）
   * @param params.customerPhone 顧客電話番号（予約特定用）
   * @param params.menu 新しいメニュー情報（メモに設定）
   * @returns 更新結果
   */
  async updateReservation(params: {
    date: string;
    time: string;
    customerPhone: string;
    menu?: MenuInfo;
  }): Promise<{ reservationId: string } | { error: string }> {
    const { date, time, customerPhone, menu } = params;

    // 1. 予約日を読み込む
    await this.selectDate(date);

    // メニューからcolor、treatment_timeを取得
    const matchedItem = await this.findTreatmentItem(menu);
    const menuColor = matchedItem?.color;
    const menuTreatmentTime = matchedItem?.treatment_time;

    // 2. 予約を見つける
    const found = await this.findReservationByPhoneAndTime(date, time, customerPhone);
    if (!found) {
      return { error: `予約が見つかりません: ${date} ${time} ${customerPhone}` };
    }

    // 3. 予約編集ダイアログを開く
    await this.openReserveEditDialog(found.reservationId);
    await this.waitForLoading()

    // 4. ReserveEditコンポーネントを取得してフォームを更新
    const calculatedTimeTo = menuTreatmentTime
      ? dayjs(`${date} ${time}`, 'YYYY-MM-DD HH:mm').add(menuTreatmentTime, 'minute').format('HH:mm')
      : null;

    await this.page.evaluate(
      async ({ menuName, customerPhone, menuColor, timeTo }) => {
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveEdit }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveEdit'));
        const reserveEdit = el?.__vue__;
        if (!reserveEdit) throw new Error('ReserveEditコンポーネントが見つかりません');

        // 編集対象の読み込み完了を待機
        await new Promise<void>(res => {
          if (reserveEdit.is_loaded) {
            res();
            return;
          } else {
            const test = () => {
              if (reserveEdit?.is_loaded) {
                res();
              } else {
                setTimeout(test, 10);
              }
            }
            test();
          }
        });

        // メモを更新
        if (menuName) {
          const memoItem = reserveEdit.form.memo?.find(item => item.memo.includes('【SmartCall予約】'))
          if (memoItem) {
            // 既存のメモを更新
            memoItem.memo = `【SmartCall予約】 症状:[${menuName}]、tel:[${customerPhone}]`;
          } else {
            // メモがない場合は追加
            reserveEdit.form.memo.push({
              id: 1,
              memo: `【SmartCall予約】 症状:[${menuName}]、tel:[${customerPhone}]`,
            });
          }
        }

        // 表示色を更新
        if (menuColor) {
          reserveEdit.form.color = menuColor;
        }

        // 終了時間を更新
        if (timeTo) {
          reserveEdit.form.time_to = timeTo;
        }
      },
      { menuName: matchedItem?.title, customerPhone, menuColor, timeTo: calculatedTimeTo }
    );

    // 7. 更新APIのレスポンスを監視
    const postResponsePromise = this.page.waitForResponse(
      (response) => {
        const url = response.url();
        // /reservations/{id} へのPOST（数字IDを含むURL）
        return /\/reservations\/\d+$/.test(url) && response.request().method() === 'POST';
      }
    );

    // 「更新」ボタンをクリック
    const updateButton = await this.page.$('.alert-wrapper .contentfooter button.btn-primary');
    if (!updateButton) {
      return { error: '更新ボタンが見つかりません' };
    }
    await updateButton.click();

    // 8. POSTレスポンスを確認
    const postResponse = await postResponsePromise;
    const postResponseData = await postResponse.json() as ReservationApiResponse;

    if (!postResponseData.result) {
      let errorMessage = '予約更新に失敗しました';
      if (postResponseData.message) {
        const messages = Object.values(postResponseData.message).flat();
        errorMessage = messages.join(' ') || errorMessage;
      }
      console.error(`[AppointPage] 予約更新失敗: ${errorMessage}`);

      // ページをリロードしてダイアログを閉じる
      await this.page.reload();
      await this.waitForLoading();

      return { error: errorMessage };
    }

    await this.waitForLoading();

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
   *
   * @param params.date 予約日（YYYY-MM-DD形式）
   * @param params.time 開始時刻（HH:MM形式）
   * @param params.customerPhone 顧客電話番号（予約特定用）
   * @param params.circumstanceType キャンセル/削除種別（1: キャンセル, 99: 削除）
   * @returns 処理結果
   */
  private async cancelOrDeleteReservation(params: {
    date: string;
    time: string;
    customerPhone: string;
    circumstanceType: typeof AppointPage.CIRCUMSTANCE_TYPE[keyof typeof AppointPage.CIRCUMSTANCE_TYPE];
  }): Promise<{ reservationId: string } | { error: string }> {
    const { date, time, customerPhone, circumstanceType } = params;
    const isDelete = circumstanceType === AppointPage.CIRCUMSTANCE_TYPE.DELETE;
    const operationName = isDelete ? '削除' : 'キャンセル';

    // 1. 予約日を読み込む
    await this.selectDate(date);

    // 2. 予約を見つける
    const found = await this.findReservationByPhoneAndTime(date, time, customerPhone);
    if (!found) {
      return { error: `予約が見つかりません: ${date} ${time} ${customerPhone}` };
    }

    // 3. 予約編集ダイアログを開く
    await this.openReserveEditDialog(found.reservationId);

    // 4. 「予約をキャンセル」ボタンをクリック
    await this.page.evaluate(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: ReserveEdit }>('*'))
        .find(el => el?.__vue__?.$vnode?.tag?.endsWith('ReserveEdit'));
      const reserveEdit = el?.__vue__;
      if (!reserveEdit) throw new Error('ReserveEditコンポーネントが見つかりません');
      reserveEdit.clickReserveCancel();
    });

    // キャンセルダイアログが表示されるまで待機
    await this.page.waitForSelector('.alert-wrapper .alert-dlList');

    // 5. CancelAddコンポーネントのformを直接操作
    const error = await this.page.evaluate(
      ({ circumstanceType, cancelType }) => {
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: CancelAdd }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('CancelAdd'));
        const cancelAdd = el?.__vue__;
        if (!cancelAdd) throw new Error('CancelAddコンポーネントが見つかりません');

        cancelAdd.form.circumstance_type = circumstanceType;
        if (cancelType !== undefined) {
          cancelAdd.form.cancel_type = cancelType;
        }

        const submitButton = el.querySelector<HTMLButtonElement>('.btn-primary');
        if (!submitButton) {
          return '登録ボタンが見つかりません';
        }
        submitButton.click();
        return null;
      },
      {
        circumstanceType,
        cancelType: isDelete ? undefined : AppointPage.CANCEL_TYPE.TEL,
      }
    );
    if (error) {
      return { error };
    }

    // 6. APIレスポンスを監視
    const postResponsePromise = this.page.waitForResponse(
      (response) => {
        const url = response.url();
        return /\/reservations\/\d+\/cancel$/.test(url) && response.request().method() === 'POST';
      }
    );

    // 7. POSTレスポンスを確認
    const postResponse = await postResponsePromise;
    const postResponseData = await postResponse.json() as ReservationApiResponse;

    if (!postResponseData.result) {
      let errorMessage = `予約${operationName}に失敗しました`;
      if (postResponseData.message) {
        const messages = Object.values(postResponseData.message).flat();
        errorMessage = messages.join(' ') || errorMessage;
      }
      console.error(`[AppointPage] 予約${operationName}失敗: ${errorMessage}`);

      await this.page.reload();
      await this.waitForLoading();

      return { error: errorMessage };
    }

    await this.waitForLoading();

    return { reservationId: found.reservationId };
  }

  /**
   * 予約をキャンセルする
   *
   * @param params.date 予約日（YYYY-MM-DD形式）
   * @param params.time 開始時刻（HH:MM形式）
   * @param params.customerPhone 顧客電話番号（予約特定用）
   * @returns キャンセル結果
   */
  async cancelReservation(params: {
    date: string;
    time: string;
    customerPhone: string;
  }): Promise<{ reservationId: string } | { error: string }> {
    return this.cancelOrDeleteReservation({
      ...params,
      circumstanceType: AppointPage.CIRCUMSTANCE_TYPE.CANCEL,
    });
  }

  /**
   * 予約を削除する
   *
   * @param params.date 予約日（YYYY-MM-DD形式）
   * @param params.time 開始時刻（HH:MM形式）
   * @param params.customerPhone 顧客電話番号（予約特定用）
   * @returns 削除結果
   */
  async deleteReservation(params: {
    date: string;
    time: string;
    customerPhone: string;
  }): Promise<{ reservationId: string } | { error: string }> {
    return this.cancelOrDeleteReservation({
      ...params,
      circumstanceType: AppointPage.CIRCUMSTANCE_TYPE.DELETE,
    });
  }

}
