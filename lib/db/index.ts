/**
 * アプリコード（Server Actions・Route Handlers・Server Components）から使う
 * DB ハンドルのシングルトン（M2 で `lib/db/client.ts` の想定通り追加）。
 *
 * Next.js の HMR（開発時のモジュール再評価）で `createDb()` が毎回呼ばれて
 * 接続が積み上がらないよう、`globalThis` にキャッシュする（Prisma 等でも
 * 使われる標準的な回避策）。
 */
import { createDb, type DbHandle } from "./client";

declare global {
  var __pjPilotDbHandle: DbHandle | undefined;
}

const handle: DbHandle = globalThis.__pjPilotDbHandle ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalThis.__pjPilotDbHandle = handle;
}

export const db = handle.db;
