/**
 * EasyApo 2 APIクライアント
 *
 * Vue 2 → Vue 3 移行に伴い、Vue内部インスタンスへの直接アクセス（__vue__、$store等）
 * が不可能になったため、ブラウザ内 fetch でAPIを直接叩く方針に変更。
 *
 * Playwrightのブラウザコンテキスト内で動作するため、セッションCookie/XSRF-TOKENが
 * 自動的に共有される。
 *
 * APIエンドポイント仕様は docs/20260617_easyapo2-api-spec/ を参照。
 */

import type { Page } from 'playwright';

/**
 * EasyApo APIの共通レスポンス形式
 * 例: { result: true, data: {...}, message: null }
 *     { result: false, data: null, message: { field: ["error"] }, error: "..." }
 */
export interface ApiResponse<T = unknown> {
  result: boolean;
  data: T | null;
  message: Record<string, string[]> | string | null;
  error?: string;
}

/**
 * APIリクエスト失敗時のエラー
 */
export class EasyApoApiError extends Error {
  readonly code = 'EASYAPO_API_ERROR';

  constructor(
    public readonly status: number,
    public readonly response: ApiResponse,
    public readonly method: string,
    public readonly path: string,
  ) {
    const message = response.error
      ?? (typeof response.message === 'string' ? response.message : null)
      ?? `${method} ${path} failed: HTTP ${status}`;
    super(message);
    this.name = 'EasyApoApiError';
  }
}

/**
 * EasyApo APIクライアント
 *
 * Playwrightブラウザコンテキスト内で動作する fetch ベースのAPIクライアント。
 * セッションCookie (`laravel_session`) は自動付与され、書き込み系には
 * Cookie の XSRF-TOKEN を X-XSRF-TOKEN ヘッダに展開する。
 */
export class EasyApoApiClient {
  constructor(private readonly page: Page) {}

  /**
   * GETリクエスト
   *
   * @param path APIパス (例: "/reservations", "/columns")
   * @param params クエリパラメータ。`t`（タイムスタンプ）は自動付与
   * @returns 共通レスポンス形式
   */
  async get<T = unknown>(
    path: string,
    params: Record<string, string | number | boolean | null | undefined> = {},
  ): Promise<ApiResponse<T>> {
    // クエリ組み立て（path内のパラメータ展開は呼び出し側で済ませる）
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const pathWithQuery = qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;

    const result = await this.page.evaluate(
      async (target) => {
        const sep = target.includes('?') ? '&' : '?';
        const url = `${target}${sep}t=${Date.now()}`;
        const r = await fetch(url, {
          credentials: 'include',
          headers: { accept: 'application/json, text/plain, */*' },
        });
        const text = await r.text();
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: r.status, ok: r.ok, body };
      },
      pathWithQuery,
    );

    return this.unwrap<T>('GET', path, result);
  }

  /**
   * POSTリクエスト（書き込み系）
   *
   * X-XSRF-TOKEN ヘッダを Cookie の XSRF-TOKEN から自動展開する。
   *
   * @param path APIパス (例: "/reservations", "/reservations/{id}/cancel")
   * @param body リクエストボディ。`t`（タイムスタンプ）は自動付与
   * @returns 共通レスポンス形式
   */
  async post<T = unknown>(
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<ApiResponse<T>> {
    const result = await this.page.evaluate(
      async ({ path, body }) => {
        const xsrf = decodeURIComponent(
          document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] || '',
        );
        const finalBody = { ...body, t: Date.now() };
        const r = await fetch(path, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json, text/plain, */*',
            'x-xsrf-token': xsrf,
          },
          body: JSON.stringify(finalBody),
        });
        const text = await r.text();
        let respBody: unknown = null;
        try { respBody = JSON.parse(text); } catch { respBody = text; }
        return { status: r.status, ok: r.ok, body: respBody };
      },
      { path, body },
    );

    return this.unwrap<T>('POST', path, result);
  }

  /**
   * fetchレスポンスを ApiResponse<T> に整形
   * - JSON形式で result/data/message が揃っていれば成功扱い（HTTPステータスに関わらず）
   * - 完全に異常な応答（HTML/プレーンテキスト等）の場合はエラーを投げる
   */
  private unwrap<T>(
    method: 'GET' | 'POST',
    path: string,
    raw: { status: number; ok: boolean; body: unknown },
  ): ApiResponse<T> {
    const { status, body } = raw;

    // JSON形式の共通レスポンスを期待する
    if (body && typeof body === 'object' && 'result' in (body as object)) {
      return body as ApiResponse<T>;
    }

    // 期待外の応答（HTML、ネットワークエラー文字列等）
    throw new EasyApoApiError(
      status,
      {
        result: false,
        data: null,
        message: typeof body === 'string' ? body : null,
        error: `Unexpected response format from ${method} ${path}`,
      },
      method,
      path,
    );
  }
}
