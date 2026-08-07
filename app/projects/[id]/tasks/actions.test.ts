/**
 * タスク一覧画面の Server Actions のテスト（M2 #14〜#17）。
 *
 * `actions.ts` は `db` シングルトン（`lib/db/index.ts`）と `getSession()`
 * （`lib/auth/session.ts`。内部で `next/headers` の `cookies()` を呼ぶ）に
 * 直接依存しているため、`vi.mock` で差し替えてテスト用の一時 DB とセッションを注入する。
 * 他の `*.test.ts`（例: `lib/tasks/service.test.ts`）と同じ「一時ファイル DB + migrate」の
 * パターンをそのまま使う。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../../../../lib/db/client";
import { projects, taskAssignees } from "../../../../lib/db/schema";
import type { AuthSession } from "../../../../lib/auth/types";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  session: null as AuthSession | null,
}));

vi.mock("../../../../lib/db", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("../../../../lib/auth/session", () => ({
  getSession: async () => state.session,
}));

// `revalidatePath` は Next.js のリクエストスコープ（static generation store）を
// 前提にしており、Next サーバー外（vitest）から直接呼ぶと例外になるためモックする。
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { createTaskAction, updateTaskAction, deleteTaskAction, setTaskAssigneesAction } =
  await import("./actions");

describe("app/projects/[id]/tasks/actions", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-tasks-actions-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    state.db = handle.db;

    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    if (!project) {
      throw new Error("Failed to create test project");
    }
    projectId = project.id;
  });

  afterAll(() => {
    try {
      handle.client.close();
    } finally {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  afterEach(() => {
    state.session = null;
  });

  describe("createTaskAction", () => {
    it("未ログインなら ok:false を返す", async () => {
      const result = await createTaskAction(
        projectId,
        { title: "T", startDate: "2026-08-01", endDate: "2026-08-05" },
        [],
      );
      expect(result.ok).toBe(false);
    });

    it("タイトルが空文字なら ok:false を返す", async () => {
      state.session = { userId: "u1" };
      const result = await createTaskAction(
        projectId,
        { title: "   ", startDate: "2026-08-01", endDate: "2026-08-05" },
        [],
      );
      expect(result).toEqual({ ok: false, message: "タイトルは必須です" });
    });

    it("不正な priority を渡すと ok:false を返す（マスアサインメント対策）", async () => {
      state.session = { userId: "u1" };
      const result = await createTaskAction(
        projectId,
        {
          title: "T",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          priority: "not-a-priority",
        },
        [],
      );
      expect(result).toEqual({ ok: false, message: "優先度の値が不正です" });
    });

    it("進捗が範囲外（101）なら ok:false を返す", async () => {
      state.session = { userId: "u1" };
      const result = await createTaskAction(
        projectId,
        { title: "T", startDate: "2026-08-01", endDate: "2026-08-05", progress: 101 },
        [],
      );
      expect(result.ok).toBe(false);
    });

    it("担当者が上限（50人）を超えると ok:false を返す", async () => {
      state.session = { userId: "u1" };
      const tooMany = Array.from({ length: 51 }, (_, i) => `user-${i}`);
      const result = await createTaskAction(
        projectId,
        { title: "T", startDate: "2026-08-01", endDate: "2026-08-05" },
        tooMany,
      );
      expect(result.ok).toBe(false);
    });

    it("担当者に文字列以外が混ざっていると ok:false を返す", async () => {
      state.session = { userId: "u1" };
      const result = await createTaskAction(
        projectId,
        { title: "T", startDate: "2026-08-01", endDate: "2026-08-05" },
        ["ok-user", 123],
      );
      expect(result.ok).toBe(false);
    });

    it("画面が許可していない type / deletedAt 等の余剰フィールドは無視される", async () => {
      state.session = { userId: "u1" };
      const result = await createTaskAction(
        projectId,
        {
          title: "T",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          type: "milestone",
          deletedAt: new Date(),
          projectId: "other-project",
        },
        [],
      );
      expect(result.ok).toBe(true);
    });

    it("正常な入力でタスクと担当者（重複排除済み）を作成する", async () => {
      state.session = { userId: "u1" };
      const result = await createTaskAction(
        projectId,
        { title: "設計", startDate: "2026-08-01", endDate: "2026-08-05", priority: "high" },
        ["alice", "bob", "alice"],
      );
      expect(result.ok).toBe(true);
      if (!result.ok || !result.taskId) {
        throw new Error("unreachable");
      }

      const assignees = await handle.db
        .select()
        .from(taskAssignees)
        .where(eq(taskAssignees.taskId, result.taskId));
      expect(assignees.map((a) => a.userId).sort()).toEqual(["alice", "bob"]);
    });
  });

  describe("updateTaskAction", () => {
    it("存在しないタスクIDなら ok:false を返す", async () => {
      state.session = { userId: "u1" };
      const result = await updateTaskAction(
        projectId,
        "nonexistent-task",
        { title: "T", startDate: "2026-08-01", endDate: "2026-08-05" },
        [],
      );
      expect(result.ok).toBe(false);
    });

    it("正常な入力でタスクを更新できる", async () => {
      state.session = { userId: "u1" };
      const created = await createTaskAction(
        projectId,
        { title: "元タイトル", startDate: "2026-08-01", endDate: "2026-08-05" },
        [],
      );
      if (!created.ok || !created.taskId) {
        throw new Error("unreachable");
      }

      const result = await updateTaskAction(
        projectId,
        created.taskId,
        {
          title: "更新後タイトル",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          status: "in_progress",
        },
        ["carol"],
      );
      expect(result).toEqual({ ok: true });

      const assignees = await handle.db
        .select()
        .from(taskAssignees)
        .where(eq(taskAssignees.taskId, created.taskId));
      expect(assignees.map((a) => a.userId)).toEqual(["carol"]);
    });
  });

  describe("deleteTaskAction", () => {
    it("子タスクを持つタスクは mode 指定なしだと ok:false を返す", async () => {
      state.session = { userId: "u1" };
      const parent = await createTaskAction(
        projectId,
        { title: "親", startDate: "2026-08-01", endDate: "2026-08-05" },
        [],
      );
      if (!parent.ok || !parent.taskId) {
        throw new Error("unreachable");
      }

      // 子タスクの作成は lib/tasks/service を直接使う
      // （actions.ts は画面から parentId を受け付けないため）。
      const { createTask } = await import("../../../../lib/tasks/service");
      await createTask(handle.db, { userId: "u1" }, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-02",
        parentId: parent.taskId,
      });

      const blocked = await deleteTaskAction(projectId, parent.taskId);
      expect(blocked.ok).toBe(false);

      const subtreeDeleted = await deleteTaskAction(projectId, parent.taskId, "subtree");
      expect(subtreeDeleted).toEqual({ ok: true });
    });
  });

  describe("setTaskAssigneesAction", () => {
    it("不正な担当者IDが混じっていれば ok:false を返す", async () => {
      state.session = { userId: "u1" };
      const created = await createTaskAction(
        projectId,
        { title: "T", startDate: "2026-08-01", endDate: "2026-08-05" },
        [],
      );
      if (!created.ok || !created.taskId) {
        throw new Error("unreachable");
      }

      const result = await setTaskAssigneesAction(projectId, created.taskId, ["ok-user", 123]);
      expect(result.ok).toBe(false);
    });
  });
});
