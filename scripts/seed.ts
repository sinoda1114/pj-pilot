/**
 * 開発用シードスクリプト（M1 #12）。ダミーの PJ / タスク / 依存を作成する。
 *
 * `project_members.userId` は `user.id` への外部キー制約を持つ（Better Auth導入に
 * 伴うフォローアップ課題）ため、固定文字列ではなく実際の `user` 行を作成して
 * その `id` を使う（`task_assignees.userId` にはFKは無いが、実データとしての
 * 一貫性のため同じユーザーを使い回す）。実際のGoogle OAuthは経由せず、
 * `better-auth/plugins` の `testUtils`（`e2e/helpers/auth.ts` と同じ手法）で
 * ユーザー行だけを作成する（ログインセッションは不要なため`test.login`は呼ばない）。
 * このテスト専用の `betterAuth` インスタンスは本番用 `lib/auth.ts` とは別に定義し、
 * ドメイン制限フックやGoogle OAuth設定（`GOOGLE_CLIENT_ID`等）を要求しない。
 *
 * 実行前に `npm run db:migrate` でマイグレーションを当てておくこと。
 * 実行: npm run db:seed
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { testUtils } from "better-auth/plugins";
import { createDb } from "../lib/db/client";
import * as authSchema from "../lib/db/schema/auth";
import { projectMembers, projects, taskAssignees, taskDependencies, tasks } from "../lib/db/schema";

async function createSeedUser(
  db: ReturnType<typeof createDb>["db"],
  overrides: { email: string; name: string },
): Promise<string> {
  const seedAuth = betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    secret: "seed-script-only-not-used-for-any-real-session",
    plugins: [testUtils()],
  });

  const ctx = await seedAuth.$context;
  const test = ctx.test;
  if (!test) {
    throw new Error("testUtilsプラグインが有効になっていません");
  }

  const saved = await test.saveUser(test.createUser(overrides));
  return saved.id;
}

async function main() {
  const resolvedUrl = process.env.TURSO_DATABASE_URL ?? "file:local.db";

  // ローカルのファイル DB 以外（＝リモートの Turso）への実行はデフォルトで拒否する。
  // 開発機の .env.local に本番/ステージングの URL が入っている状態で誤って
  // `npm run db:seed` を叩くと、ダミーデータを本番に投入してしまうため
  // （Devin レビュー指摘）。
  if (!resolvedUrl.startsWith("file:") && process.env.ALLOW_REMOTE_SEED !== "true") {
    throw new Error(
      "TURSO_DATABASE_URL がローカルのファイル DB を指していません。" +
        "誤って本番/ステージングにダミーデータを投入しないためのガードです。" +
        "意図している場合は環境変数 ALLOW_REMOTE_SEED=true を設定してください。",
    );
  }

  const { db, client } = createDb(resolvedUrl);

  try {
    await seed(db);
  } finally {
    // 途中で例外が起きてもハンドルを開いたままにしない。
    client.close();
  }
}

async function seed(db: ReturnType<typeof createDb>["db"]) {
  const ownerUserId = await createSeedUser(db, {
    email: "seed-owner@example.com",
    name: "Seed Owner",
  });
  const memberUserId = await createSeedUser(db, {
    email: "seed-member@example.com",
    name: "Seed Member",
  });

  const [project] = await db
    .insert(projects)
    .values({ name: "サンプルプロジェクト", description: "開発用のダミーデータ" })
    .returning();

  if (!project) {
    throw new Error("プロジェクトの作成に失敗しました");
  }

  await db.insert(projectMembers).values([
    { projectId: project.id, userId: ownerUserId, role: "owner" },
    { projectId: project.id, userId: memberUserId, role: "member" },
  ]);

  const [summary] = await db
    .insert(tasks)
    .values({
      projectId: project.id,
      title: "要件定義〜リリース",
      type: "summary",
      startDate: "2026-08-10",
      endDate: "2026-09-30",
    })
    .returning();

  if (!summary) {
    throw new Error("サマリータスクの作成に失敗しました");
  }

  // SQLite の RETURNING は複数行 INSERT の場合に行の順序を保証しないため
  // （Devin レビュー指摘）、1件ずつ INSERT して返り値を直接紐付ける。
  const [design] = await db
    .insert(tasks)
    .values({
      projectId: project.id,
      parentId: summary.id,
      title: "要件定義・設計",
      startDate: "2026-08-10",
      endDate: "2026-08-17",
      priority: "high",
      status: "in_progress",
      estimatedHours: 40,
      sortOrder: 0,
    })
    .returning();

  const [dev] = await db
    .insert(tasks)
    .values({
      projectId: project.id,
      parentId: summary.id,
      title: "実装",
      startDate: "2026-08-18",
      endDate: "2026-09-14",
      priority: "high",
      estimatedHours: 120,
      sortOrder: 1,
    })
    .returning();

  const [testTask] = await db
    .insert(tasks)
    .values({
      projectId: project.id,
      parentId: summary.id,
      title: "テスト",
      startDate: "2026-09-15",
      endDate: "2026-09-25",
      estimatedHours: 40,
      sortOrder: 2,
    })
    .returning();

  const [milestone] = await db
    .insert(tasks)
    .values({
      projectId: project.id,
      parentId: summary.id,
      title: "リリース",
      type: "milestone",
      startDate: "2026-09-30",
      endDate: "2026-09-30",
      sortOrder: 3,
    })
    .returning();

  if (!design || !dev || !testTask || !milestone) {
    throw new Error("子タスクの作成に失敗しました");
  }

  await db.insert(taskAssignees).values([
    { taskId: design.id, userId: ownerUserId },
    { taskId: dev.id, userId: ownerUserId },
    { taskId: dev.id, userId: memberUserId },
    { taskId: testTask.id, userId: memberUserId },
  ]);

  await db.insert(taskDependencies).values([
    { projectId: project.id, predecessorId: design.id, successorId: dev.id },
    { projectId: project.id, predecessorId: dev.id, successorId: testTask.id },
    { projectId: project.id, predecessorId: testTask.id, successorId: milestone.id },
  ]);

  console.log(`シード完了: project=${project.id}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
