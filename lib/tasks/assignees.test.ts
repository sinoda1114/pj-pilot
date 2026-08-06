import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnauthorizedError } from "../auth/errors";
import { createDb, type DbHandle } from "../db/client";
import { projects, tasks } from "../db/schema";
import { NotFoundError } from "../errors";
import { listTaskAssignees, setTaskAssignees } from "./assignees";

const SESSION = { userId: "u1" };

describe("tasks/assignees", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;
  let taskId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-assignees-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });

    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    if (!project) {
      throw new Error("Failed to create test project");
    }
    projectId = project.id;
    const [task] = await handle.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      })
      .returning();
    if (!task) {
      throw new Error("Failed to create test task");
    }
    taskId = task.id;
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

  describe("listTaskAssignees", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      await expect(listTaskAssignees(handle.db, null, taskId)).rejects.toThrow(UnauthorizedError);
    });

    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(listTaskAssignees(handle.db, SESSION, "nonexistent")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("担当者が居なければ空配列を返す", async () => {
      const result = await listTaskAssignees(handle.db, SESSION, taskId);
      expect(result).toEqual([]);
    });
  });

  describe("setTaskAssignees", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      await expect(setTaskAssignees(handle.db, null, taskId, ["a"])).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(setTaskAssignees(handle.db, SESSION, "nonexistent", ["a"])).rejects.toThrow(
        NotFoundError,
      );
    });

    it("何も居ない状態から担当者を追加できる", async () => {
      await setTaskAssignees(handle.db, SESSION, taskId, ["alice", "bob"]);

      const result = await listTaskAssignees(handle.db, SESSION, taskId);
      expect(result.map((r) => r.userId).sort()).toEqual(["alice", "bob"]);
    });

    it("一覧を置き換えると、いない分は削除され新しい分だけ追加される", async () => {
      await setTaskAssignees(handle.db, SESSION, taskId, ["alice", "bob"]);

      await setTaskAssignees(handle.db, SESSION, taskId, ["bob", "carol"]);

      const result = await listTaskAssignees(handle.db, SESSION, taskId);
      expect(result.map((r) => r.userId).sort()).toEqual(["bob", "carol"]);
    });

    it("空配列を渡すと全員解除される", async () => {
      await setTaskAssignees(handle.db, SESSION, taskId, ["alice", "bob"]);

      await setTaskAssignees(handle.db, SESSION, taskId, []);

      const result = await listTaskAssignees(handle.db, SESSION, taskId);
      expect(result).toEqual([]);
    });

    it("重複した userId を渡しても1件だけ登録される", async () => {
      await setTaskAssignees(handle.db, SESSION, taskId, ["alice", "alice"]);

      const result = await listTaskAssignees(handle.db, SESSION, taskId);
      expect(result.map((r) => r.userId)).toEqual(["alice"]);
    });

    it("既に同じ一覧を渡しても例外にならない（変更なし）", async () => {
      await setTaskAssignees(handle.db, SESSION, taskId, ["alice"]);

      await expect(setTaskAssignees(handle.db, SESSION, taskId, ["alice"])).resolves.toBeUndefined();

      const result = await listTaskAssignees(handle.db, SESSION, taskId);
      expect(result.map((r) => r.userId)).toEqual(["alice"]);
    });

    it("他のタスクの担当者には影響しない", async () => {
      const [otherTask] = await handle.db
        .insert(tasks)
        .values({
          projectId,
          title: "他タスク",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
        })
        .returning();
      if (!otherTask) {
        throw new Error("Failed to create other test task");
      }
      await setTaskAssignees(handle.db, SESSION, otherTask.id, ["dave"]);

      await setTaskAssignees(handle.db, SESSION, taskId, ["alice"]);

      const otherResult = await listTaskAssignees(handle.db, SESSION, otherTask.id);
      expect(otherResult.map((r) => r.userId)).toEqual(["dave"]);
    });
  });
});
