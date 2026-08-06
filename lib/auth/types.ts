/**
 * 認証実装（Better Auth）が入るまでのプレースホルダー型。
 *
 * 2026-08-06 時点で better-auth 本体に未修正の Critical 脆弱性があるため
 * 導入を保留している（lib/db/schema/app.ts のコメント参照）。認可ヘルパは
 * 実際のセッション取得手段（`auth.api.getSession()` 等）に依存させず、
 * 最小限のセッション情報だけを受け取る形にしておく。Better Auth 導入後は
 * 実際のセッション型からこの形に詰め替えて渡す想定。
 */
export interface AuthSession {
  userId: string;
}
