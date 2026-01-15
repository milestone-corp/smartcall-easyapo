/**
 * EasyApo Vueコンポーネント型定義
 *
 * EasyApoシステムのVueコンポーネントへの参照に使用する型定義
 */

export type VueComponent = {
  $vnode?: {
    tag: string;
  };
}

/**
 * ログインフォームコンポーネント（Vue）
 */
export type FormLogin = VueComponent & {
  form: {
    login_id: string;
    login_password: string;
  };
  execLogin: () => Promise<void>;
}

/**
 * サイドカレンダーコンポーネント（Vue）
 *
 * 日付を選択して予約日コンポーネント（ReserveDay）にデータを読み込む
 */
export type SideMain = VueComponent & {
  /**
   * 指定した日付の予約データを読み込む
   *
   * このメソッドを呼び出すと、ReserveDayコンポーネントの
   * reserve_rows, column_rows, time_rows が更新される
   *
   * @param param.id 日付（YYYY-MM-DD形式、例: '2026-05-26'）
   */
  clickDay(param: { id: string }): void;
  /** 検索クエリ文字列 */
  s_q: string;
  /** 患者検索を実行（s_qの値で検索） */
  clickSearch(): void;
}

/**
 * 予約メモ情報
 */
export type ReserveMemo = {
  id: number;
  img: string | null;
  memo: string | null;
  part: string[];
}

/**
 * 予約行（1件の予約情報）
 */
export type ReserveRow = {
  /** 予約ID */
  id: number;
  /** 患者ID */
  patient_id: number;
  /** 患者番号 */
  patient_number: string;
  /** カラム番号（リソース/スタッフの列位置） */
  column_no: number;
  /** 予約日（YYYY-MM-DD形式） */
  reservation_date: string;
  /** 開始時刻（HH:MM形式） */
  time_from: string;
  /** 終了時刻（HH:MM形式） */
  time_to: string;
  /** 患者名 */
  patient_name: string;
  /** 診療ID */
  treatment_id: number;
  /** 表示色 */
  color: string;
  /** 担当者 */
  pic: string | null;
  /** メモ情報 */
  memo: ReserveMemo[];
  /** 生年月日（YYYY-MM-DD形式） */
  birthday: string;
  /** ステータス */
  status: number;
  /** キャンセルフラグ */
  cancel: number;
  /** ブロックフラグ */
  block: number;
  /** 回答 */
  answer: unknown | null;
  /** アイコン */
  icons: unknown[];
  /** 親予約ID（繰り返し予約の場合） */
  parent_id: number | null;
  /** 繰り返しタイプ */
  repeat_type: string | null;
  /** 繰り返し終了日 */
  repeat_to: string | null;
  /** 後続予約があるか */
  has_subsequent: boolean;
  /** 表示位置（上からのピクセル） */
  top: number;
  /** 表示高さ（ピクセル） */
  height: number;
  /** 開始時刻（数値形式 HHMM） */
  time_from_num: string;
  /** 終了時刻（数値形式 HHMM） */
  time_to_num: string;
  /** 表示位置（左からのピクセル） */
  left: number;
  /** 表示幅（ピクセル） */
  width: number;
  /** 予約変更中フラグ */
  is_change_reserve: boolean;
}

/**
 * 担当者/リソース情報
 */
export type ColumnRow = {
  /** 担当者ID */
  id: number;
  /** 担当者名（Dr1, DH1, 急患など） */
  name: string;
}

/**
 * 時間枠情報
 */
export type TimeRow = {
  /** 時（2桁文字列） */
  hour: string;
  /** 分（2桁文字列） */
  minute: string;
  /** 時刻テキスト（HH:MM形式） */
  time_text: string;
  /** 時刻数値（HHMM形式） */
  time_num: string;
  /** 表示位置（上からのピクセル） */
  top: number;
  /** 休憩時間フラグ */
  is_break_time: boolean;
  /** 夜間休憩時間フラグ */
  is_night_break_time: boolean;
}

/**
 * 診療メニュー項目（APIレスポンス）
 */
export type TreatmentItemRaw = {
  /** 診療メニューID */
  id: number;
  /** 診療メニュー名 */
  title: string;
  /** 表示色 */
  color: string;
  /** 所要時間（分） */
  treatment_time: number;
  /** 処置可能な担当者ID一覧 */
  use_column: number[];
  /** 担当者 */
  pic: string | null;
  /** 表示順 */
  order: number;
}

/**
 * 診療メニュー項目（担当者名変換済み）
 */
export type TreatmentItem = TreatmentItemRaw & {
  /** 処置可能な担当者名一覧 */
  resources: string[];
}

/**
 * APIレスポンス基本型
 */
export type ApiResponse<T> = {
  result: boolean;
  data: T | undefined;
  message: unknown | null;
}

/**
 * 診療メニュー取得APIレスポンス
 */
export type TreatmentItemsResponse = ApiResponse<{
  treatment_items: TreatmentItemRaw[];
}>

/**
 * 患者検索結果（/patients APIレスポンス）
 */
export type PatientSearchItem = {
  /** 患者ID */
  id: number;
  /** 患者番号（診察券番号） */
  patient_number: string;
  /** 患者名 */
  name: string;
  /** 患者名フリガナ */
  name_kana: string;
  /** 生年月日（YYYY-MM-DD形式） */
  birthday: string;
  /** 住所 */
  address: string;
  /** 電話番号1（主） */
  tel1: string;
  /** 電話番号2（副） */
  tel2: string;
  /** メールアドレス */
  mail: string;
  /** SMS通知設定（0: 無効, 1: 有効） */
  sms: number;
  /** LINE連携設定（0: 無効, 1: 有効） */
  line: number;
  /** 関連患者情報（家族など） */
  relationship: unknown | null;
}

/**
 * 患者検索APIレスポンス
 */
export type PatientsSearchResponse = ApiResponse<{
  /** 検索結果の患者一覧 */
  patients: PatientSearchItem[];
}>

/**
 * 予約履歴項目
 */
export type ReservationHistoryItem = {
  /** 予約ID */
  id: number;
  /** 予約日（YYYY-MM-DD形式） */
  reservation_date: string;
  /** 開始時刻（HH:MM形式） */
  time_from: string;
  /** 終了時刻（HH:MM形式） */
  time_to: string;
  /** 診療メニューID */
  treatment_id: number | null;
  /** 表示色 */
  color: string;
  /** 担当者一覧 */
  pic: { id: number; name: string }[] | null;
  /** メモ情報 */
  memo: ReserveMemo[];
  /** キャンセル種別（キャンセル時のみ設定） */
  cancel_type: string | null;
}

/**
 * 患者詳細（/patients/:id APIレスポンス）
 */
export type PatientDetailResponse = ApiResponse<{
  /** 患者ID */
  id: number;
  /** 患者番号（診察券番号） */
  patient_number: string;
  /** 患者名 */
  name: string;
  /** 患者名フリガナ */
  name_kana: string;
  /** 電話番号1（主） */
  tel1: string;
  /** 電話番号2（副） */
  tel2: string;
  /** メールアドレス */
  mail: string;
  /** 生年月日（YYYY-MM-DD形式） */
  birthday: string;
  /** 最終予約日（YYYY-MM-DD形式） */
  last_reservation_date: string | null;
  /** 予約履歴一覧 */
  reservation_histories: ReservationHistoryItem[];
}>

/**
 * 予約詳細（/reservations/:id APIレスポンス）
 */
export type ReservationDetailResponse = ApiResponse<{
  /** 予約ID */
  id: number;
  /** カラム番号（担当者/リソースのID） */
  column_no: number;
  /** 予約日（YYYY-MM-DD形式） */
  reservation_date: string;
  /** 開始時刻（HH:MM形式） */
  time_from: string;
  /** 終了時刻（HH:MM形式） */
  time_to: string;
  /** 患者名 */
  patient_name: string;
  /** 電話番号 */
  tel: string | null;
  /** キャンセルフラグ（0: 有効, 1: キャンセル済み） */
  cancel: number;
  /** ステータス */
  status: number;
  /** 患者情報 */
  patient: {
    /** 患者ID */
    id: number;
    /** 患者番号（診察券番号） */
    patient_number: string;
    /** 患者名 */
    name: string;
    /** 電話番号1（主） */
    tel1: string;
  };
}>

/**
 * VuexストアのAPI設定
 */
export type ApiStore = {
  get_treatment_items: string;
}

/**
 * 予約作成ダイアログを開くためのパラメータ
 */
export type OpenReserveAddParams = {
  /** カラム番号（担当者ID） */
  column_no: number;
  /** 予約日（YYYY-MM-DD形式） */
  reservation_date: string;
  /** 開始時刻（HH:MM形式） */
  time_from: string;
  /** 終了時刻（HH:MM形式） */
  time_to: string;
}

/**
 * 予約候補情報
 */
export type Candidate = {
  /** アクティブフラグ */
  is_active: boolean;
}

/**
 * 予約日コンポーネント（Vue）
 */
export type ReserveDay = VueComponent & {
  /** 読み込んだ日付の予約情報一覧 */
  reserve_rows: ReserveRow[];
  /** 担当者/リソース一覧 */
  column_rows: ColumnRow[];
  /** 予約可能時間枠一覧 */
  time_rows: TimeRow[];
  /** 診療開始時（0-23） */
  start_hour: number;
  /** 診療開始分（0-59） */
  start_minute: number;
  /** 診療終了時（0-23） */
  end_hour: number;
  /** 診療終了分（0-59） */
  end_minute: number;
  /** 予約候補情報 */
  candidate: Candidate;
  /** VuexストアのAPI設定 */
  $store: {
    state: {
      api: ApiStore;
    };
    /** Vuexストアのcommitメソッド */
    commit(type: 'openReserveAdd', payload: OpenReserveAddParams): void;
    commit(type: 'resetCandidate'): void;
  };
  /** API通信メソッド（Axiosレスポンス形式） */
  get<T>(url: string, params: Record<string, unknown>): Promise<AxiosLikeResponse<T>>;
}

/**
 * Axios風レスポンス型
 */
export type AxiosLikeResponse<T> = {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/**
 * キャンセル登録フォーム
 */
export type CancelAddForm = {
  /** 予約ID */
  id: number;
  /** キャンセル/削除種別（1: キャンセル, 99: 削除） */
  circumstance_type: 1 | 99;
  /** キャンセル種類（1: TEL, 2: TEL変更, 11: WEB, 99: 無断） */
  cancel_type: 1 | 2 | 11 | 99;
  /** キャンセル理由 */
  cancel_reason: string;
  /** キャンセルメモ */
  cancel_memo: string;
  /** メール送信フラグ */
  send_mail: number;
  /** SMS送信フラグ */
  send_sms: number;
  /** LINE送信フラグ */
  send_line: number;
  /** 未定登録フラグ */
  regist_undecided: number;
}

/**
 * キャンセル登録ダイアログコンポーネント（Vue）
 */
export type CancelAdd = VueComponent & {
  /** キャンセル登録フォーム */
  form: CancelAddForm;
}

/**
 * 予約作成/更新APIレスポンス（POST /reservations）
 */
export type ReservationApiResponse = {
  /** 処理結果 */
  result: boolean;
  /** データ（通常null） */
  data: null;
  /** エラーメッセージ */
  message: Record<string, string[]> | null;
  /** 確認メッセージ（診療時間外等の警告がある場合） */
  confirmation?: string;
}

/**
 * 予約一覧取得APIレスポンス（GET /reservations）
 */
export type ReservationsListResponse = {
  /** 処理結果 */
  result: boolean;
  /** データ */
  data: {
    /** 予約一覧 */
    reservations: ReserveRow[];
  } | null;
  /** メッセージ */
  message: unknown | null;
}

/**
 * 予約作成フォームのメモ項目
 */
export type ReserveAddFormMemo = {
  /** メモID */
  id: number;
  /** メモ内容 */
  memo: string;
}

/**
 * 予約作成フォーム
 */
export type ReserveAddForm = {
  /** 変更元予約ID（予約変更時のみ設定） */
  prev_reservation_id: number | null;
  /** 患者番号（診察券番号） */
  patient_number: string;
  /** カラム番号（担当者/リソースのID） */
  column_no: number;
  /** 予約日（YYYY-MM-DD形式） */
  reservation_date: string;
  /** 開始時刻（HH:MM形式） */
  time_from: string;
  /** 終了時刻（HH:MM形式） */
  time_to: string;
  /** 患者名 */
  patient_name: string;
  /** 診療メニューID */
  treatment_id: number | null;
  /** 表示色 */
  color: string;
  /** 担当者一覧 */
  pic: unknown[];
  /** メモ情報 */
  memo: ReserveAddFormMemo[];
}

/**
 * 予約作成ダイアログコンポーネント（Vue）
 */
export type ReserveAdd = VueComponent & {
  /** 予約作成フォーム */
  form: ReserveAddForm;
  /**
   * 患者番号から患者情報を取得・設定
   *
   * form.patient_numberを設定した後に呼び出すと、
   * 患者情報を取得してフォームに反映する
   */
  getPatient(): Promise<void>;
  /**
   * 予約メモを追加
   *
   * form.memoに新しいメモ項目を追加する
   */
  addMemo(): void;
  /**
   * 予約作成ダイアログを閉じる
   */
  clickClose(): void;
}

/**
 * 予約編集フォームのメモ項目
 */
export type ReserveEditFormMemo = {
  /** メモID */
  id: number;
  /** メモ内容 */
  memo: string;
}

/**
 * 予約編集フォーム
 */
export type ReserveEditForm = {
  /** 予約ID */
  id: number;
  /** 親予約ID（繰り返し予約の場合） */
  parent_id: number | null;
  /** 繰り返しタイプ */
  repeat_type: string | null;
  /** 繰り返し終了日 */
  repeat_to: string | null;
  /** カラム番号（担当者/リソースのID） */
  column_no: number;
  /** 予約日（YYYY-MM-DD形式） */
  reservation_date: string;
  /** 開始時刻（HH:MM形式） */
  time_from: string;
  /** 終了時刻（HH:MM形式） */
  time_to: string;
  /** 患者名 */
  patient_name: string;
  /** 電話番号 */
  tel: string | null;
  /** メールアドレス */
  mail: string;
  /** 予約時メールアドレス */
  reservation_mail: string | null;
  /** 生年月日 */
  birthday: string | null;
  /** 診療メニューID */
  treatment_id: number | null;
  /** 表示色 */
  color: string;
  /** 担当者 */
  pic: unknown | null;
  /** メモ情報 */
  memo: ReserveEditFormMemo[];
  /** ステータス */
  status: number;
  /** キャンセルフラグ */
  cancel: number;
  /** キャンセル日 */
  cancel_date: string | null;
  /** ブロックフラグ */
  block: number;
  /** 患者情報 */
  patient: unknown;
  /** 患者フォーム */
  patient_form: unknown | null;
  /** 回答 */
  answer: unknown | null;
  /** 後続予約があるか */
  has_subsequent: boolean;
  /** 単独予約ではないか */
  is_not_alone: boolean;
  /** Web予約かどうか */
  is_web_reservation: boolean;
}

/**
 * 予約編集ダイアログコンポーネント（Vue）
 */
export type ReserveEdit = VueComponent & {
  /** 予約編集フォーム */
  form: ReserveEditForm;
  /** 編集対象の情報が読み込み完了したか */
  is_loaded: boolean;
  /**
   * 予約編集ダイアログを閉じる
   */
  clickClose(): void;
  /**
   * 予約キャンセルダイアログを表示
   */
  clickReserveCancel(): void;
}

/**
 * 患者一覧ダイアログコンポーネント（Vue）
 */
export type PatientList = VueComponent & {
  /**
   * 患者一覧ダイアログを閉じる
   */
  clickClose(): void;
}
