/**
 * DB 接続層（M1 #8）。
 *
 * 本番（Vercel serverless）は Turso への HTTP 接続、ローカル開発・テストは
 * ファイル DB を使う。`@libsql/client` はどちらも同じ API で扱えるため、
 * 接続文字列（`TURSO_DATABASE_URL`）の有無だけで切り替える。
 *
 * 重要: 外部キー制約はここでは当てにしない（決定 D-06/R-7）。
 * Turso の HTTP 接続は接続ごとに `PRAGMA foreign_keys = ON` を担保できないため、
 * 本番では PRAGMA を投げても効果を保証しない。ローカル/テスト（ファイル DB）では
 * 実際に効くので、削除ロジックの実装漏れを CI で検出する目的でのみ有効化する。
 */

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

export interface DbHandle {
  client: Client;
  db: LibSQLDatabase<typeof schema>;
}

/**
 * DB ハンドルを作成する。`url` を省略するとローカルのファイル DB
 * （`file:local.db`、テストでは呼び出し側が個別のパスを渡す）を使う。
 */
export function createDb(url?: string, authToken?: string): DbHandle {
  const client = createClient({
    url: url ?? process.env.TURSO_DATABASE_URL ?? "file:local.db",
    authToken: authToken ?? process.env.TURSO_AUTH_TOKEN,
  });

  const db = drizzle(client, { schema });

  return { client, db };
}

/**
 * ローカル/テスト環境でのみ外部キー制約を有効化する。
 * 本番の Turso HTTP 接続では効果が保証されないため呼び出さない
 * （client.ts の設計方針を参照）。
 */
export async function enableForeignKeysForLocalDev(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON;");
}
