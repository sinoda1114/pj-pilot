import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnauthorizedError } from "../auth/errors";
import { createDb, type DbHandle } from "../db/client";
import { getTaskById } from "../db/queries";
import { projects, tasks } from "../db/schema";
import { NotFoundError } from "../errors";
import {
  deleteTask,
  deleteTaskSubtree,
  promoteChildrenAndDeleteTask,
  restoreTask,
} from "./deletion";
import { HasChildrenError } from "./errors";
import { createTask } from "./service";

const SESSION = { userId: "u1" };

describe("tasks/deletion", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-task-deletion-test-"));
    // busyTimeoutMs: 0（SQLite の既定＝即エラー）を明示する。このファイルには
    // 「同一プロセス内で削除と子作成を競合させる」TOCTOU 検証テストがあり、
    // busy timeout があると待機中にイベントループごと止まって相手の
    // トランザクションが進めず、タイムアウト分だけ固まってから結局失敗する
    // （lib/db/client.ts の CreateDbOptions 参照）。
    handle = createDb(`file:${join(dir, "test.db")}`, undefined, { busyTimeoutMs: 0 });
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

  describe("deleteTask", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      const task = await insertTask();
      await expect(deleteTask(handle.db, null, task.id)).rejects.toThrow(UnauthorizedError);
    });

    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(deleteTask(handle.db, SESSION, "nonexistent")).rejects.toThrow(NotFoundError);
    });

    it("子を持たないタスクは論理削除される", async () => {
      const task = await insertTask();

      await deleteTask(handle.db, SESSION, task.id);

      const result = await getTaskById(handle.db, task.id);
      expect(result?.deletedAt).not.toBeNull();
    });

    it("決定 D-02: 子を持つタスクの削除は既定で拒否する", async () => {
      const parent = await insertTask({ title: "親" });
      await insertTask({ title: "子", parentId: parent.id });

      await expect(deleteTask(handle.db, SESSION, parent.id)).rejects.toThrow(HasChildrenError);

      const result = await getTaskById(handle.db, parent.id);
      expect(result?.deletedAt).toBeNull();
    });

    it("トランザクション: 並行して子タスクが作られても「アクティブな子を持つ削除済みタスク」にはならない（セキュリティレビュー指摘の TOCTOU 対策の検証）", async () => {
      const parent = await insertTask({ title: "親" });

      await Promise.allSettled([
        deleteTask(handle.db, SESSION, parent.id),
        createTask(handle.db, SESSION, projectId, {
          title: "並行して作られる子",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          parentId: parent.id,
        }),
      ]);

      const parentAfter = await getTaskById(handle.db, parent.id);
      const children = await handle.db.select().from(tasks).where(eq(tasks.parentId, parent.id));
      const activeChildren = children.filter((child) => child.deletedAt === null);

      // 親が削除されているなら、アクティブな子が存在してはいけない
      // （逆に子が作られたなら、親の削除は HasChildrenError で失敗しているはず）。
      if (parentAfter?.deletedAt !== null) {
        expect(activeChildren).toHaveLength(0);
      }
    });

    it("論理削除済みの子は「子を持つ」とみなさない", async () => {
      const parent = await insertTask({ title: "親" });
      const child = await insertTask({ title: "子", parentId: parent.id });
      await handle.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, child.id));

      await deleteTask(handle.db, SESSION, parent.id);

      const result = await getTaskById(handle.db, parent.id);
      expect(result?.deletedAt).not.toBeNull();
    });
  });

  describe("deleteTaskSubtree", () => {
    it("決定 D-02: サブツリーごと削除すると、タスク自身と子孫全てが論理削除される", async () => {
      const root = await insertTask({ title: "root" });
      const child = await insertTask({ title: "child", parentId: root.id });
      const grandchild = await insertTask({ title: "grandchild", parentId: child.id });
      const sibling = await insertTask({ title: "sibling（無関係）" });

      await deleteTaskSubtree(handle.db, SESSION, root.id);

      expect((await getTaskById(handle.db, root.id))?.deletedAt).not.toBeNull();
      expect((await getTaskById(handle.db, child.id))?.deletedAt).not.toBeNull();
      expect((await getTaskById(handle.db, grandchild.id))?.deletedAt).not.toBeNull();
      expect((await getTaskById(handle.db, sibling.id))?.deletedAt).toBeNull();
    });

    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(deleteTaskSubtree(handle.db, SESSION, "nonexistent")).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe("promoteChildrenAndDeleteTask", () => {
    it("決定 D-02: 子の parent_id を祖父に付け替えて、親だけ削除する", async () => {
      const grandparent = await insertTask({ title: "祖父" });
      const parent = await insertTask({ title: "親", parentId: grandparent.id });
      const child = await insertTask({ title: "子", parentId: parent.id });

      await promoteChildrenAndDeleteTask(handle.db, SESSION, parent.id);

      const parentResult = await getTaskById(handle.db, parent.id);
      const childResult = await getTaskById(handle.db, child.id);
      expect(parentResult?.deletedAt).not.toBeNull();
      expect(childResult?.deletedAt).toBeNull();
      expect(childResult?.parentId).toBe(grandparent.id);
    });

    it("削除対象がルート（parent_id が null）の場合、子はルートに繰り上がる", async () => {
      const root = await insertTask({ title: "root" });
      const child = await insertTask({ title: "child", parentId: root.id });

      await promoteChildrenAndDeleteTask(handle.db, SESSION, root.id);

      const childResult = await getTaskById(handle.db, child.id);
      expect(childResult?.parentId).toBeNull();
    });

    it("子が居なくても単にタスクを削除する", async () => {
      const task = await insertTask();

      await promoteChildrenAndDeleteTask(handle.db, SESSION, task.id);

      expect((await getTaskById(handle.db, task.id))?.deletedAt).not.toBeNull();
    });
  });

  describe("restoreTask", () => {
    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(restoreTask(handle.db, SESSION, "nonexistent")).rejects.toThrow(NotFoundError);
    });

    it("削除済みタスクの deleted_at を NULL に戻す", async () => {
      const task = await insertTask();
      await deleteTask(handle.db, SESSION, task.id);

      await restoreTask(handle.db, SESSION, task.id);

      expect((await getTaskById(handle.db, task.id))?.deletedAt).toBeNull();
    });

    it("§4.4(a): 祖先が削除済みならまとめて復元する（宙に浮いた子を作らない）", async () => {
      const root = await insertTask({ title: "root" });
      const child = await insertTask({ title: "child", parentId: root.id });
      const grandchild = await insertTask({ title: "grandchild", parentId: child.id });
      await deleteTaskSubtree(handle.db, SESSION, root.id);

      await restoreTask(handle.db, SESSION, grandchild.id);

      expect((await getTaskById(handle.db, grandchild.id))?.deletedAt).toBeNull();
      expect((await getTaskById(handle.db, child.id))?.deletedAt).toBeNull();
      expect((await getTaskById(handle.db, root.id))?.deletedAt).toBeNull();
    });

    it("生存している祖先には触らない", async () => {
      const root = await insertTask({ title: "root" });
      const child = await insertTask({ title: "child", parentId: root.id });
      await deleteTask(handle.db, SESSION, child.id);

      await restoreTask(handle.db, SESSION, child.id);

      expect((await getTaskById(handle.db, root.id))?.deletedAt).toBeNull();
    });

    it("循環した parent_id があっても無限ループしない（防御的ガード）", async () => {
      const a = await insertTask({ title: "A" });
      const b = await insertTask({ title: "B", parentId: a.id });
      // 本来 CHECK 制約では防げない多段循環（A→B→A）を直接 SQL で作る。
      await handle.db.update(tasks).set({ parentId: b.id }).where(eq(tasks.id, a.id));
      await handle.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, a.id));

      await expect(restoreTask(handle.db, SESSION, a.id)).resolves.toBeUndefined();
    });
  });
});
