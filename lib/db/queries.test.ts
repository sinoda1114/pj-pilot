import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";
import { getActiveProject, listActiveProjects, listDeletedTasksByProject } from "./queries";
import { projects, tasks } from "./schema";

describe("queries: 生存レコードのみを返す（§3.2 / §4.4(c)）", () => {
  let dir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-queries-test-"));
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

  it("listActiveProjects は論理削除済みのプロジェクトを除外する", async () => {
    const [alive] = await handle.db.insert(projects).values({ name: "生存中" }).returning();
    const [deleted] = await handle.db.insert(projects).values({ name: "削除済み" }).returning();
    if (!alive || !deleted) {
      throw new Error("Failed to create test projects");
    }
    await handle.db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(eq(projects.id, deleted.id));

    const result = await listActiveProjects(handle.db);

    expect(result.map((p) => p.id)).toEqual([alive.id]);
  });

  it("getActiveProject は論理削除済みのプロジェクトには undefined を返す", async () => {
    const [deleted] = await handle.db.insert(projects).values({ name: "削除済み" }).returning();
    if (!deleted) {
      throw new Error("Failed to create test project");
    }
    await handle.db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(eq(projects.id, deleted.id));

    const result = await getActiveProject(handle.db, deleted.id);

    expect(result).toBeUndefined();
  });

  it("getActiveProject は生存中のプロジェクトを返す", async () => {
    const [alive] = await handle.db.insert(projects).values({ name: "生存中" }).returning();
    if (!alive) {
      throw new Error("Failed to create test project");
    }

    const result = await getActiveProject(handle.db, alive.id);

    expect(result?.id).toBe(alive.id);
  });
});

describe("listDeletedTasksByProject（M1 #9c ゴミ箱一覧）", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-queries-trash-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });

    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    if (!project) {
      throw new Error("Failed to create test project");
    }
    projectId = project.id;
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

  async function insertTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
    const [task] = await handle.db
      .insert(tasks)
      .values({
        projectId,
        title: "タスク",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        ...overrides,
      })
      .returning();
    if (!task) {
      throw new Error("Failed to create test task");
    }
    return task;
  }

  it("論理削除済みのタスクのみを返し、生存中のタスクは含めない", async () => {
    const alive = await insertTask({ title: "生存中" });
    const deleted = await insertTask({ title: "削除済み" });
    await handle.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, deleted.id));

    const result = await listDeletedTasksByProject(handle.db, projectId);

    expect(result.map((t) => t.id)).toEqual([deleted.id]);
    expect(result.map((t) => t.id)).not.toContain(alive.id);
  });

  it("他プロジェクトの削除済みタスクは含めない", async () => {
    const [otherProject] = await handle.db.insert(projects).values({ name: "他PJ" }).returning();
    if (!otherProject) {
      throw new Error("Failed to create other test project");
    }
    const [otherTask] = await handle.db
      .insert(tasks)
      .values({
        projectId: otherProject.id,
        title: "他PJの削除済みタスク",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      })
      .returning();
    if (!otherTask) {
      throw new Error("Failed to create other test task");
    }
    await handle.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, otherTask.id));

    const result = await listDeletedTasksByProject(handle.db, projectId);

    expect(result).toHaveLength(0);
  });

  it("削除済みタスクが無ければ空配列を返す", async () => {
    await insertTask();

    const result = await listDeletedTasksByProject(handle.db, projectId);

    expect(result).toEqual([]);
  });
});
