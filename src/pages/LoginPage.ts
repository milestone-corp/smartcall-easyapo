/**
 * ログインページ Page Object
 *
 * サイト固有のセレクターとログイン処理を実装します。
 */

import { BasePage } from '@smartcall/rpa-sdk';

const ID_INPUT = '.login-wrapper input[type="text"]';
const PW_INPUT = '.login-wrapper input[type="password"]';
const LOGIN_BUTTON = '.login-wrapper button.btn-primary';

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

    await this.waitForSelector('.login-wrapper');

    // DOM操作でフォーム要素の存在確認（Vue3移行で __vue__ 経由のアクセスが不可になったため）
    const idEl = await this.page.$(ID_INPUT);
    const pwEl = await this.page.$(PW_INPUT);
    const btnEl = await this.page.$(LOGIN_BUTTON);
    if (!idEl || !pwEl || !btnEl) {
      throw new AuthError('ログインフォームが見つかりません');
    }

    // ログインAPIのレスポンスを監視
    const loginResponsePromise = this.page.waitForResponse(
      (response) => response.url().includes('/login') && response.request().method() === 'POST'
    );

    // Vueの v-model に input イベントで反映させるため fill を使用（内部で input/change を dispatch）
    await this.page.fill(ID_INPUT, loginId);
    await this.page.fill(PW_INPUT, password);
    await this.page.click(LOGIN_BUTTON);

    // 認証エラーをチェック
    const response = await loginResponsePromise;
    if (!response.ok()) {
      const body = await response.json();
      this.page.reload();
      if (body.result === false && body.message) {
        // メッセージオブジェクトから最初のエラーメッセージを取得
        const messages = Object.values(body.message).flat();
        const errorMessage = messages[0] as string || '認証に失敗しました';
        throw new AuthError(errorMessage);
      }
      throw new AuthError('認証に失敗しました');
    }
    await this.wait(1000);
    await this.page.waitForSelector('#loading', { state: 'hidden' });
  }

  /**
   * ログイン成功を確認
   */
  async isLoggedIn(): Promise<boolean> {
    const mainComponent = await this.page.$('#col-main > div');
    return mainComponent !== null;
  }
}
