/**
 * 開発用ユーザーの定義（`lib/auth/session.ts` の暫定セッション実装用）。
 *
 * `next/headers` に依存しない純粋な定数だけを切り出しているのは、
 * クライアントコンポーネント（`components/dev/DevUserSwitcher.tsx`）から
 * `DEV_USERS` を参照する際に、サーバ専用の `cookies()` 呼び出しまで
 * バンドルに引き込んでしまわないようにするため。
 *
 * userId は `scripts/seed.ts` の `SEED_OWNER_USER_ID` / `SEED_MEMBER_USER_ID`
 * と同じ値に揃えている。ここが食い違うと、シード済みデータに対して
 * owner 用の開発用ユーザーに切り替えても `requireProjectOwner` が
 * 常に失敗し、オーナー専用機能をUIで検証できなくなる（Bugbot 指摘）。
 */
export const DEV_SESSION_COOKIE = "pj-pilot-dev-user";

export const DEV_USERS = [
  { userId: "seed-owner", label: "開発用ユーザーA（オーナー / シード済み）" },
  { userId: "seed-member", label: "開発用ユーザーB（メンバー / シード済み）" },
] as const;
