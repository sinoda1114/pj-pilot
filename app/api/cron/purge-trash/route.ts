/**
 * ゴミ箱の物理削除エンドポイント（M1 #9c）。Vercel Cron（`vercel.json`）から日次で叩かれる。
 *
 * 削除ロジック本体は `lib/tasks/purge.ts` に切り出してある。このファイルは
 * 認証（`CRON_SECRET`）の検証と HTTP レスポンスへの変換だけを担う。
 *
 * `CRON_SECRET` が環境変数に設定されていない場合は 500 を返して拒否する。
 * 「未設定なら検証をスキップして通す」実装にすると、環境変数の設定漏れという
 * 単純なミスだけで誰でもこのエンドポイントを叩けてしまう（＝物理削除を任意に
 * トリガーできてしまう）ため、fail-closed（安全側に倒す）にする。
 */

import { NextResponse } from "next/server";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { db } from "../../../../lib/db";
import type * as schema from "../../../../lib/db/schema";
import { purgeExpiredTrash } from "../../../../lib/tasks/purge";

type AuthResult = { ok: true } | { ok: false; status: 401 | 500; message: string };

function checkAuthorization(request: Request): AuthResult {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, status: 500, message: "CRON_SECRET が設定されていません" };
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  return { ok: true };
}

/**
 * `GET`/`POST` から共通で呼ぶ本体。`database` を引数として受け取れるようにしているのは、
 * `lib/db/index.ts` の DB シングルトンが環境変数から接続先を決めるため差し替えにくく、
 * テストから一時ファイル DB を注入できるようにするため
 * （`lib/tasks/purge.test.ts` の結合テストとは別に、この Route Handler 自体の
 * 認証・HTTP変換をテストする `route.test.ts` から利用する）。
 */
export async function handlePurgeTrashRequest(
  request: Request,
  database: LibSQLDatabase<typeof schema>,
): Promise<Response> {
  const auth = checkAuthorization(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  const result = await purgeExpiredTrash(database);
  return NextResponse.json(result, { status: 200 });
}

// Vercel Cron は GET でリクエストする。手動トリガー用に POST も同じ挙動で受ける。
export async function GET(request: Request): Promise<Response> {
  return handlePurgeTrashRequest(request, db);
}

export async function POST(request: Request): Promise<Response> {
  return handlePurgeTrashRequest(request, db);
}
