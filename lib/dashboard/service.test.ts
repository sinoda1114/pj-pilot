import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnauthorizedError } from "../auth/errors";
import { createDb, type DbHandle } from "../db/client";
import { projects, tasks } from "../db/schema";
import { getDashboardData } from "./service";

const SESSION = { userId: "u1" };
const TODAY = "2026-08-08";

describe("dashboard/service", () => {
  let dir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-dashboard-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
  });

  afterEach(() => {
    try {
      handle.client.close();
    } finally {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function insertProject(name: string, deleted = false) {
    const [project] = await handle.db
      .insert(projects)
      .values({ name, deletedAt: deleted ? new Date() : null })
      .returning();
    return project!;
  }

  async function insertTask(overrides: {
    projectId: string;
    title: string;
    status?: "todo" | "in_progress" | "review" | "done";
    endDate?: string;
    type?: "task" | "summary" | "milestone";
    deleted?: boolean;
  }) {
    await handle.db.insert(tasks).values({
      projectId: overrides.projectId,
      title: overrides.title,
      startDate: "2026-08-01",
      endDate: overrides.endDate ?? "2026-08-31",
      status: overrides.status ?? "todo",
      type: overrides.type ?? "task",
      deletedAt: overrides.deleted ? new Date() : null,
    });
  }

  it("未ログインは UnauthorizedError を投げる", async () => {
    await expect(getDashboardData(handle.db, null, TODAY)).rejects.toThrow(UnauthorizedError);
  });

  it("全プロジェクト横断でステータス別件数・期限超過・PJ別進捗を返す", async () => {
    const a = await insertProject("PJ-A");
    const b = await insertProject("PJ-B");

    await insertTask({ projectId: a.id, title: "A完了", status: "done" });
    await insertTask({ projectId: a.id, title: "A対応中", status: "in_progress" });
    await insertTask({ projectId: a.id, title: "A遅延", endDate: "2026-08-01" });
    await insertTask({ projectId: b.id, title: "B完了", status: "done" });

    const result = await getDashboardData(handle.db, SESSION, TODAY);

    expect(result.statusCounts).toEqual({ todo: 1, in_progress: 1, review: 0, done: 2 });
    expect(result.overdueTasks.map((row) => row.title)).toEqual(["A遅延"]);
    expect(result.projectProgress).toEqual([
      { projectId: a.id, name: "PJ-A", total: 3, done: 1, percent: 33 },
      { projectId: b.id, name: "PJ-B", total: 1, done: 1, percent: 100 },
    ]);
  });

  it("論理削除済みのタスクは集計に入らない", async () => {
    const a = await insertProject("PJ-A");
    await insertTask({ projectId: a.id, title: "生存", status: "todo" });
    await insertTask({ projectId: a.id, title: "削除済み", status: "todo", deleted: true });

    const result = await getDashboardData(handle.db, SESSION, TODAY);

    expect(result.statusCounts.todo).toBe(1);
  });

  it("論理削除済みプロジェクトのタスクは集計にも一覧にも出ない", async () => {
    const alive = await insertProject("生存PJ");
    const deleted = await insertProject("削除済みPJ", true);
    await insertTask({ projectId: alive.id, title: "生存PJのタスク", endDate: "2026-08-01" });
    // プロジェクトだけ論理削除し、タスク側の deleted_at は立てない
    await insertTask({ projectId: deleted.id, title: "削除済みPJのタスク", endDate: "2026-08-01" });

    const result = await getDashboardData(handle.db, SESSION, TODAY);

    expect(result.overdueTasks.map((row) => row.title)).toEqual(["生存PJのタスク"]);
    expect(result.statusCounts.todo).toBe(1);
    expect(result.projectProgress.map((row) => row.name)).toEqual(["生存PJ"]);
  });

  it("summary / milestone は集計に入らない", async () => {
    const a = await insertProject("PJ-A");
    await insertTask({ projectId: a.id, title: "タスク", status: "todo" });
    await insertTask({ projectId: a.id, title: "サマリー", status: "todo", type: "summary" });
    await insertTask({
      projectId: a.id,
      title: "マイルストーン",
      status: "todo",
      type: "milestone",
    });

    const result = await getDashboardData(handle.db, SESSION, TODAY);

    expect(result.statusCounts.todo).toBe(1);
    expect(result.projectProgress[0]?.total).toBe(1);
  });

  it("期限超過タスクにはプロジェクト名が付く（画面でどのPJか分かるように）", async () => {
    const a = await insertProject("PJ-A");
    await insertTask({ projectId: a.id, title: "遅延", endDate: "2026-08-01" });

    const result = await getDashboardData(handle.db, SESSION, TODAY);

    expect(result.overdueTasks[0]).toMatchObject({ title: "遅延", projectName: "PJ-A" });
  });

  it("タスクが1件も無くても壊れない（空状態）", async () => {
    await insertProject("空PJ");

    const result = await getDashboardData(handle.db, SESSION, TODAY);

    expect(result.statusCounts).toEqual({ todo: 0, in_progress: 0, review: 0, done: 0 });
    expect(result.overdueTasks).toEqual([]);
    expect(result.projectProgress).toEqual([
      { projectId: expect.any(String), name: "空PJ", total: 0, done: 0, percent: null },
    ]);
  });

  it("プロジェクトが1件も無くても壊れない", async () => {
    const result = await getDashboardData(handle.db, SESSION, TODAY);

    expect(result.projectProgress).toEqual([]);
    expect(result.overdueTasks).toEqual([]);
  });
});
