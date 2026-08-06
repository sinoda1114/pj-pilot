/**
 * 開発用シードスクリプト（M1 #12）。ダミーの PJ / タスク / 依存を作成する。
 *
 * 認証テーブルがまだ無い（better-auth 導入保留中。lib/db/schema/app.ts 参照）ため、
 * userId は固定のダミー文字列を使う。認証実装後、実際のユーザーに置き換わっても
 * project_members / task_assignees の userId カラムに FK 制約は無いため、
 * このスクリプト自体は変更不要。
 *
 * 実行前に `npm run db:migrate` でマイグレーションを当てておくこと。
 * 実行: npm run db:seed
 */
import { createDb } from "../lib/db/client";
import { projectMembers, projects, taskAssignees, taskDependencies, tasks } from "../lib/db/schema";

const SEED_OWNER_USER_ID = "seed-owner";
const SEED_MEMBER_USER_ID = "seed-member";

async function main() {
  const { db, client } = createDb();

  try {
    await seed(db);
  } finally {
    // 途中で例外が起きてもハンドルを開いたままにしない。
    client.close();
  }
}

async function seed(db: ReturnType<typeof createDb>["db"]) {
  const [project] = await db
    .insert(projects)
    .values({ name: "サンプルプロジェクト", description: "開発用のダミーデータ" })
    .returning();

  if (!project) {
    throw new Error("プロジェクトの作成に失敗しました");
  }

  await db.insert(projectMembers).values([
    { projectId: project.id, userId: SEED_OWNER_USER_ID, role: "owner" },
    { projectId: project.id, userId: SEED_MEMBER_USER_ID, role: "member" },
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

  const [design, dev, testTask, milestone] = await db
    .insert(tasks)
    .values([
      {
        projectId: project.id,
        parentId: summary.id,
        title: "要件定義・設計",
        startDate: "2026-08-10",
        endDate: "2026-08-17",
        priority: "high",
        status: "in_progress",
        estimatedHours: 40,
        sortOrder: 0,
      },
      {
        projectId: project.id,
        parentId: summary.id,
        title: "実装",
        startDate: "2026-08-18",
        endDate: "2026-09-14",
        priority: "high",
        estimatedHours: 120,
        sortOrder: 1,
      },
      {
        projectId: project.id,
        parentId: summary.id,
        title: "テスト",
        startDate: "2026-09-15",
        endDate: "2026-09-25",
        estimatedHours: 40,
        sortOrder: 2,
      },
      {
        projectId: project.id,
        parentId: summary.id,
        title: "リリース",
        type: "milestone",
        startDate: "2026-09-30",
        endDate: "2026-09-30",
        sortOrder: 3,
      },
    ])
    .returning();

  if (!design || !dev || !testTask || !milestone) {
    throw new Error("子タスクの作成に失敗しました");
  }

  await db.insert(taskAssignees).values([
    { taskId: design.id, userId: SEED_OWNER_USER_ID },
    { taskId: dev.id, userId: SEED_OWNER_USER_ID },
    { taskId: dev.id, userId: SEED_MEMBER_USER_ID },
    { taskId: testTask.id, userId: SEED_MEMBER_USER_ID },
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
