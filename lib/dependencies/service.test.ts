import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnauthorizedError } from "../auth/errors";
import { createDb, type DbHandle } from "../db/client";
import { projects, tasks } from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { createDependency, deleteDependency, listDependencies } from "./service";

const SESSION = { userId: "u1" };

describe("dependencies/service", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-dependencies-test-"));
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

  async function insertTask(title: string, overrides: Partial<typeof tasks.$inferInsert> = {}) {
    const [task] = await handle.db
      .insert(tasks)
      .values({
        projectId,
        title,
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

  describe("createDependency", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      const a = await insertTask("A");
      const b = await insertTask("B");
      await expect(createDependency(handle.db, null, projectId, a.id, b.id)).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it("存在しないプロジェクトは NotFoundError を投げる", async () => {
      const a = await insertTask("A");
      const b = await insertTask("B");
      await expect(
        createDependency(handle.db, SESSION, "nonexistent-project", a.id, b.id),
      ).rejects.toThrow(NotFoundError);
    });

    it("依存を作成できる", async () => {
      const a = await insertTask("A");
      const b = await insertTask("B");

      const dependency = await createDependency(handle.db, SESSION, projectId, a.id, b.id);

      expect(dependency.predecessorId).toBe(a.id);
      expect(dependency.successorId).toBe(b.id);
      expect(dependency.type).toBe("FS");
    });

    it("自分自身への依存は ValidationError を投げる", async () => {
      const a = await insertTask("A");

      await expect(createDependency(handle.db, SESSION, projectId, a.id, a.id)).rejects.toThrow(
        ValidationError,
      );
    });

    it("存在しない先行タスクは NotFoundError を投げる", async () => {
      const b = await insertTask("B");
      await expect(
        createDependency(handle.db, SESSION, projectId, "nonexistent-task", b.id),
      ).rejects.toThrow(NotFoundError);
    });

    it("存在しない後続タスクは NotFoundError を投げる", async () => {
      const a = await insertTask("A");
      await expect(
        createDependency(handle.db, SESSION, projectId, a.id, "nonexistent-task"),
      ).rejects.toThrow(NotFoundError);
    });

    it("他プロジェクトのタスクを先行にすると ValidationError を投げる", async () => {
      const [otherProject] = await handle.db.insert(projects).values({ name: "他PJ" }).returning();
      if (!otherProject) {
        throw new Error("Failed to create other project");
      }
      const [otherTask] = await handle.db
        .insert(tasks)
        .values({
          projectId: otherProject.id,
          title: "他PJのタスク",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
        })
        .returning();
      if (!otherTask) {
        throw new Error("Failed to create other task");
      }
      const b = await insertTask("B");

      await expect(
        createDependency(handle.db, SESSION, projectId, otherTask.id, b.id),
      ).rejects.toThrow(ValidationError);
    });

    it("同じ依存を重複して作成すると ValidationError を投げる", async () => {
      const a = await insertTask("A");
      const b = await insertTask("B");
      await createDependency(handle.db, SESSION, projectId, a.id, b.id);

      await expect(createDependency(handle.db, SESSION, projectId, a.id, b.id)).rejects.toThrow(
        ValidationError,
      );
    });

    it("§5.2: 循環参照になる依存は ValidationError を投げる", async () => {
      const a = await insertTask("A");
      const b = await insertTask("B");
      const c = await insertTask("C");
      await createDependency(handle.db, SESSION, projectId, a.id, b.id);
      await createDependency(handle.db, SESSION, projectId, b.id, c.id);

      // A→B→C が既にある状態で C→A を足すと循環になる
      await expect(createDependency(handle.db, SESSION, projectId, c.id, a.id)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe("listDependencies", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      await expect(listDependencies(handle.db, null, projectId)).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it("プロジェクトに紐づく依存を返す", async () => {
      const a = await insertTask("A");
      const b = await insertTask("B");
      await createDependency(handle.db, SESSION, projectId, a.id, b.id);

      const result = await listDependencies(handle.db, SESSION, projectId);

      expect(result).toHaveLength(1);
      expect(result[0]?.predecessorId).toBe(a.id);
    });
  });

  describe("deleteDependency", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      const a = await insertTask("A");
      const b = await insertTask("B");
      const dependency = await createDependency(handle.db, SESSION, projectId, a.id, b.id);

      await expect(deleteDependency(handle.db, null, dependency.id)).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it("存在しない依存は NotFoundError を投げる", async () => {
      await expect(deleteDependency(handle.db, SESSION, "nonexistent-dependency")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("依存を削除できる（物理削除）", async () => {
      const a = await insertTask("A");
      const b = await insertTask("B");
      const dependency = await createDependency(handle.db, SESSION, projectId, a.id, b.id);

      await deleteDependency(handle.db, SESSION, dependency.id);

      const result = await listDependencies(handle.db, SESSION, projectId);
      expect(result).toEqual([]);
    });

    it("削除後は同じ依存を再作成できる", async () => {
      const a = await insertTask("A");
      const b = await insertTask("B");
      const dependency = await createDependency(handle.db, SESSION, projectId, a.id, b.id);
      await deleteDependency(handle.db, SESSION, dependency.id);

      await expect(createDependency(handle.db, SESSION, projectId, a.id, b.id)).resolves.toBeDefined();
    });
  });
});
