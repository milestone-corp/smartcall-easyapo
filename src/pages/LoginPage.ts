/**
 * ログインページ Page Object
 *
 * サイト固有のセレクターとログイン処理を実装します。
 */

import { BasePage } from '@smartcall/rpa-sdk';
import type { FormLogin } from '../types/easyapo.d.ts';

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

    const formLoginError = await this.page.evaluate(
      async ({ loginId, password }) => {
        const el = Array.from(document.querySelectorAll<HTMLElement & { __vue__: FormLogin }>('*'))
          .find(el => el?.__vue__?.$vnode?.tag?.endsWith('FormLogin'));
        const formLogin = el?.__vue__;
        if (!formLogin) return 'ログインフォームが見つかりません';
        formLogin.form.login_id = loginId;
        formLogin.form.login_password = password;
        await formLogin.execLogin();
        return null;
      },
      { loginId, password }
    );
    if (formLoginError) {
      throw new AuthError(formLoginError);
    }

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
    await this.wait(1000)
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
