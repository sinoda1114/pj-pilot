/**
 * 認可ヘルパ（`lib/auth/authz.ts`）・service層が受け取る最小限のセッション情報。
 * Better Auth の実セッション型（`user.name`/`email`等を含む）には依存させず、
 * `lib/auth/session.ts` がここへ詰め替えて渡す。表示用に実ユーザー名/emailが
 * 必要な箇所（`app/layout.tsx`）は、この型を経由せず個別に取得する。
 */
export interface AuthSession {
  userId: string;
}
