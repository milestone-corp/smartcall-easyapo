/**
 * ログインページ Page Object
 *
 * サイト固有のセレクターとログイン処理を実装します。
 */

import { BasePage } from '@smartcall/rpa-sdk';

type FormLogin = {
  form: {
    login_id: string,
    login_password: string,
  },
  execLogin: () => Promise<void>,
}

/**
 * 認証エラー
 */
export class AuthError extends Error {
  readonly code = 'AUTH_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class LoginPage extends BasePage {
  /**
   * ログインを実行
   *
   * @throws {AuthError} 認証エラーの場合
   */
  async login(loginId: string, password: string): Promise<void> {
    // 認証情報が未入力の場合はエラー
    if (!loginId || !password) {
      throw new AuthError('認証情報が設定されていません');
    }

    // ログインAPIのレスポンスを監視
    const loginResponsePromise = this.page.waitForResponse(
      (response) => response.url().includes('/login') && response.request().method() === 'POST'
    );

    await this.waitForSelector('.login-wrapper')

    await this.page.evaluate(
      async ({ loginId, password }) => {
        const formLogin = (document.querySelector('.login-wrapper')?.parentElement as (null | HTMLElement & { __vue__: FormLogin }))?.__vue__
        if (!formLogin) throw new AuthError('ログインフォームが見つかりません');
        formLogin.form.login_id = loginId;
        formLogin.form.login_password = password;
        await formLogin.execLogin();
      },
      { loginId, password }
    );

    // 認証エラーをチェック
    const response = await loginResponsePromise;
    if (!response.ok()) {
      const body = await response.json();
      this.page.reload()
      if (body.result === false && body.message) {
        // メッセージオブジェクトから最初のエラーメッセージを取得
        const messages = Object.values(body.message).flat();
        const errorMessage = messages[0] as string || '認証に失敗しました';
        throw new AuthError(errorMessage);
      }
      throw new AuthError('認証に失敗しました');
    }
    await this.page.waitForSelector('#loading', { state: 'hidden' });
  }

  /**
   * ログイン成功を確認
   */
  async isLoggedIn(): Promise<boolean> {
    const mainComponent = await this.page.$('#col-main > div')
    return mainComponent !== null
  }
}
