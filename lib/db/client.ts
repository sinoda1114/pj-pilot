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
 *
 * このモジュールは現時点でテストからしか呼ばれていない（M2 以降で Server Actions
 * から使われ始める）。そのため、まだ実際の呼び出しパターンが無い次の2点は
 * 意図的に実装していない（実装先取りによる過剰な抽象化を避けるため）。
 * アプリコードから使い始める際に、実際のパターンに合わせて対応する。
 *
 *  - 接続のシングルトン化（Next.js の HMR / Server Action からの呼び出しで
 *    接続が積み上がらないよう、`globalThis` へのキャッシュ等を検討する）
 *  - ローカル開発サーバ起動時に `enableForeignKeysForLocalDev` を自動で
 *    呼ぶ導線（現状はテストの `beforeEach` からのみ呼ばれている）
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
 *
 * ただし Vercel 上（`VERCEL` 環境変数が設定される）で `url` も
 * `TURSO_DATABASE_URL` も無い場合はエラーにする。黙ってローカルの
 * ファイル DB にフォールバックすると、サーバレス環境では毎回まっさらな
 * ファイルに書き込むことになり、「データが保存されない」という
 * 原因不明の障害になる（Devin レビュー指摘）。
 */
export function createDb(url?: string, authToken?: string): DbHandle {
  const resolvedUrl = url ?? process.env.TURSO_DATABASE_URL;

  if (!resolvedUrl) {
    if (process.env.VERCEL) {
      throw new Error(
        "TURSO_DATABASE_URL が設定されていません。Vercel の環境変数を確認してください。",
      );
    }
  }

  const client = createClient({
    url: resolvedUrl ?? "file:local.db",
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
