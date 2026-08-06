/**
 * 開発用ユーザーの定義（`lib/auth/session.ts` の暫定セッション実装用）。
 *
 * `next/headers` に依存しない純粋な定数だけを切り出しているのは、
 * クライアントコンポーネント（`components/dev/DevUserSwitcher.tsx`）から
 * `DEV_USERS` を参照する際に、サーバ専用の `cookies()` 呼び出しまで
 * バンドルに引き込んでしまわないようにするため。
 */
export const DEV_SESSION_COOKIE = "pj-pilot-dev-user";

export const DEV_USERS = [
  { userId: "dev-owner", label: "開発用ユーザーA（オーナー想定）" },
  { userId: "dev-member", label: "開発用ユーザーB（メンバー想定）" },
] as const;
