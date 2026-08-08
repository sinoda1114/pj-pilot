/**
 * DB 接続層（M1 #8）。
 *
 * 本番（Vercel serverless）は Turso への HTTP 接続、ローカル開発・テストは
 * ファイル DB を使う。`@libsql/client` はどちらも同じ API で扱えるため、
 * 接続文字列（`TURSO_DATABASE_URL`）の有無だけで切り替える。
 *
 * 重要: 外部キー制約はここでは当てにしない（決定 D-06/R-7）。
 * Turso の HTTP 接続は接続ごとに `PRAGMA foreign_keys = ON` を担保できないため、
 * 本番では PRAGMA を投げても効果を保証しない。
 *
 * 一方 `@libsql/client` のローカルドライバは **PRAGMA を投げなくても既定で
 * `foreign_keys = 1`** になる（実測で確認）。つまりローカル/テストは黙って FK が
 * 効いた状態で走る。この差のせいで、**同じバグがローカルでは例外、本番では無言の
 * 孤児**という形で現れる。「テストでは FK が切れているから本番相当」という判断は
 * 誤りなので、本番相当を検証したいテストでは `PRAGMA foreign_keys = OFF` を
 * 明示すること（`lib/tasks/purge.test.ts` の孤児検証がその例）。
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
 * ローカルのファイル DB に対する busy timeout（ミリ秒）。
 *
 * SQLite の既定は 0、つまり他の接続がロックを持っていると**待たずに即座に**
 * `SQLITE_BUSY: database is locked` で失敗する。ローカル開発と E2E では
 * 同じ `file:local.db` に複数プロセスが書き込むため、これが非決定的な
 * CI 失敗（flaky）の原因になっていた。
 *
 *   - Playwright のテストプロセス: `e2e/helpers/auth.ts` がユーザーを作成する
 *   - Next.js サーバープロセス（`webServer`）: Server Actions が書き込む
 *
 * `playwright.config.ts` の `workers: 1` / `fullyParallel: false` はスペック間の
 * 並列を止めるだけで、**プロセス間**の競合には効かない。実際に PR #34 の CI
 * （Markdown 1ファイルの追加のみ）で e2e が2件落ちている。
 *
 * 値の根拠: ロック保持側の1トランザクションは数十〜数百ms で終わるため、
 * 5秒あれば十分に吸収できる。長すぎると本当のデッドロックの発見が遅れるので、
 * Playwright の各アクションのタイムアウトより短い範囲に収める。
 *
 * ⚠️ **同一プロセス内の競合には効かない**（`createDb` の `busyTimeoutMs` 参照）。
 */
export const LOCAL_BUSY_TIMEOUT_MS = 5000;

export interface CreateDbOptions {
  /**
   * ローカルのファイル DB に対する busy timeout（ミリ秒）。既定は
   * {@link LOCAL_BUSY_TIMEOUT_MS}。**0 を渡すと即エラー**（SQLite の既定挙動）になる。
   *
   * 0 を明示的に渡すべきなのは「同一プロセス内で2つの書き込みを競合させる」テスト
   * （TOCTOU 対策の検証）だけ。`@libsql/client` のローカルドライバは同期実行のため、
   * 待機中はイベントループごと止まる。同一プロセスではロックを持っている側の
   * continuation が走れず、待っても永久に解放されない。待つだけ無駄で、
   * タイムアウト分だけ固まってから結局失敗する。
   *
   * 逆に**プロセス間**（Playwright のテストプロセス ↔ Next.js サーバープロセス）では、
   * 相手は別のイベントループで動いているので、待てば解放される。これが本来の狙い。
   */
  busyTimeoutMs?: number;
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
export function createDb(
  url?: string,
  authToken?: string,
  options: CreateDbOptions = {},
): DbHandle {
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
    // `PRAGMA busy_timeout` を後から execute するのではなく、この設定オプションを使う。
    // `@libsql/client` の型定義に「client が開くすべての接続に適用される。
    // `transaction()` の後に内部的に作られる接続も含む」と明記されており、
    // 手動 PRAGMA では `db.transaction()`（lib/tasks/hierarchy.ts 等が TOCTOU 対策で
    // 多用している）の内部接続に効かず、肝心のところで取りこぼすため。
    // 実測でも、設定オプションなら通常の execute と transaction() の両方で
    // ロック解放を待って成功することを確認済み。
    // remote（Turso の HTTP 接続）ではこのオプションは無視される、と型定義に明記がある。
    timeout: options.busyTimeoutMs ?? LOCAL_BUSY_TIMEOUT_MS,
  });

  const db = drizzle(client, { schema });

  return { client, db };
}

/**
 * ローカル/テスト環境で外部キー制約を明示的に有効化する。
 *
 * ローカルドライバは既定で有効なので、これは「有効であることを明示する」ための
 * 関数であって、呼ばないと無効になるわけではない（ファイル冒頭の注記を参照）。
 * 本番の Turso HTTP 接続では効果が保証されないため呼び出さない。
 */
export async function enableForeignKeysForLocalDev(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON;");
}
