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
import { NotFoundError, ValidationError } from "../errors";
import { indentTask, outdentTask } from "./hierarchy";

const SESSION = { userId: "u1" };

describe("tasks/hierarchy", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-task-hierarchy-test-"));
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

  /**
   * `taskId` から `parentId` を root まで辿り、途中で自分自身（または既に訪れたノード）に
   * 戻ってこないこと（循環していないこと）を確認する。
   * indent/outdent が循環を作らないという設計上の主張を、実データで裏付けるためのヘルパー。
   */
  async function expectNoCycleFromAncestorChain(taskId: string): Promise<void> {
    const visited = new Set<string>([taskId]);
    let currentParentId = (await getTaskById(handle.db, taskId))?.parentId ?? null;

    while (currentParentId !== null) {
      expect(visited.has(currentParentId)).toBe(false);
      visited.add(currentParentId);
      currentParentId = (await getTaskById(handle.db, currentParentId))?.parentId ?? null;
    }
  }

  describe("indentTask", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      const task = await insertTask();
      await expect(indentTask(handle.db, null, task.id)).rejects.toThrow(UnauthorizedError);
    });

    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(indentTask(handle.db, SESSION, "nonexistent")).rejects.toThrow(NotFoundError);
    });

    it("直前の兄弟が居る場合、その子になる", async () => {
      const first = await insertTask({ title: "1番目", sortOrder: 0 });
      const second = await insertTask({ title: "2番目", sortOrder: 1 });

      await indentTask(handle.db, SESSION, second.id);

      const result = await getTaskById(handle.db, second.id);
      expect(result?.parentId).toBe(first.id);
    });

    it("直前の兄弟が居ない（最初の子）場合、ValidationError を投げる", async () => {
      const parent = await insertTask({ title: "親" });
      const onlyChild = await insertTask({ title: "唯一の子", parentId: parent.id, sortOrder: 0 });

      await expect(indentTask(handle.db, SESSION, onlyChild.id)).rejects.toThrow(ValidationError);
    });

    it("兄弟が全く居ない場合、ValidationError を投げる", async () => {
      const alone = await insertTask({ title: "一人っ子" });

      await expect(indentTask(handle.db, SESSION, alone.id)).rejects.toThrow(ValidationError);
    });

    it("論理削除済みの兄弟は「直前の兄弟」とみなさない", async () => {
      const first = await insertTask({ title: "1番目", sortOrder: 0 });
      const deletedSecond = await insertTask({ title: "削除済み2番目", sortOrder: 1 });
      await handle.db
        .update(tasks)
        .set({ deletedAt: new Date() })
        .where(eq(tasks.id, deletedSecond.id));
      const third = await insertTask({ title: "3番目", sortOrder: 2 });

      await indentTask(handle.db, SESSION, third.id);

      const result = await getTaskById(handle.db, third.id);
      expect(result?.parentId).toBe(first.id);
    });

    it("sortOrder は新しい親の生存している子の末尾（最大 + 1）になる", async () => {
      const newParent = await insertTask({ title: "新しい親", sortOrder: 0 });
      await insertTask({ title: "既存の子A", parentId: newParent.id, sortOrder: 0 });
      await insertTask({ title: "既存の子B", parentId: newParent.id, sortOrder: 3 });
      const target = await insertTask({ title: "インデント対象", sortOrder: 1 });

      await indentTask(handle.db, SESSION, target.id);

      const result = await getTaskById(handle.db, target.id);
      expect(result?.parentId).toBe(newParent.id);
      expect(result?.sortOrder).toBe(4);
    });

    it("新しい親に生存している子が居ない場合、sortOrder は 0 になる", async () => {
      const first = await insertTask({ title: "1番目", sortOrder: 0 });
      const second = await insertTask({ title: "2番目", sortOrder: 1 });

      await indentTask(handle.db, SESSION, second.id);

      const result = await getTaskById(handle.db, second.id);
      expect(result?.parentId).toBe(first.id);
      expect(result?.sortOrder).toBe(0);
    });

    it("循環参照は起こらない: インデントで新しい親（直前の兄弟）になるのは常に自分の子孫ではない別枝である", async () => {
      // 3階層のツリーを組み、末端の子をインデントしても、新しい親（直前の兄弟）が
      // 自分の子孫になることはない（兄弟同士は別枝であるため）ことを確認する。
      const root = await insertTask({ title: "root", sortOrder: 0 });
      const childA = await insertTask({ title: "childA", parentId: root.id, sortOrder: 0 });
      const childB = await insertTask({ title: "childB", parentId: root.id, sortOrder: 1 });
      const grandchild = await insertTask({
        title: "grandchild",
        parentId: childA.id,
        sortOrder: 0,
      });

      await indentTask(handle.db, SESSION, childB.id);

      const result = await getTaskById(handle.db, childB.id);
      expect(result?.parentId).toBe(childA.id);
      // grandchild は childA の子のまま（インデントの巻き添えで動いていない）。
      expect((await getTaskById(handle.db, grandchild.id))?.parentId).toBe(childA.id);
      // childB から親を root まで辿っても、途中で childB 自身に戻ってこない（循環していない）。
      await expectNoCycleFromAncestorChain(childB.id);
    });

    it("兄弟が sortOrder 順に並んでいなくても、sortOrder が最大の「直前の兄弟」が選ばれる", async () => {
      // `listActiveTasksByParent` は ORDER BY を持たず、返る順序は挿入順に依存する。
      // 「直前の兄弟」の判定を先頭一致や最後の要素で済ませていると、
      // 挿入順と sortOrder がずれた瞬間に誤った親を選んでしまう。
      const first = await insertTask({ title: "sortOrder 0", sortOrder: 0 });
      const expectedParent = await insertTask({ title: "sortOrder 2", sortOrder: 2 });
      const middle = await insertTask({ title: "sortOrder 1（後から挿入）", sortOrder: 1 });
      const target = await insertTask({ title: "インデント対象", sortOrder: 3 });

      await indentTask(handle.db, SESSION, target.id);

      const result = await getTaskById(handle.db, target.id);
      expect(result?.parentId).toBe(expectedParent.id);
      expect(result?.parentId).not.toBe(first.id);
      expect(result?.parentId).not.toBe(middle.id);
    });

    it("プロジェクトをまたいだ「直前の兄弟」は選ばれない（別プロジェクトのルートタスクへの誤ヒット防止）", async () => {
      const [otherProject] = await handle.db.insert(projects).values({ name: "別PJ" }).returning();
      if (!otherProject) {
        throw new Error("Failed to create test project");
      }
      // 別プロジェクトの root タスク（sortOrder 0）。parentId が同じ null であっても
      // 対象タスクの「直前の兄弟」として選ばれてはならない。
      const [otherRoot] = await handle.db
        .insert(tasks)
        .values({
          projectId: otherProject.id,
          title: "別PJのroot",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          sortOrder: 0,
        })
        .returning();
      if (!otherRoot) {
        throw new Error("Failed to create test task");
      }
      const target = await insertTask({ title: "対象", sortOrder: 1 });

      await expect(indentTask(handle.db, SESSION, target.id)).rejects.toThrow(ValidationError);

      const result = await getTaskById(handle.db, target.id);
      expect(result?.parentId).not.toBe(otherRoot.id);
      expect(result?.parentId).toBeNull();
    });
  });

  describe("outdentTask", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      const parent = await insertTask({ title: "親" });
      const child = await insertTask({ title: "子", parentId: parent.id });
      await expect(outdentTask(handle.db, null, child.id)).rejects.toThrow(UnauthorizedError);
    });

    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(outdentTask(handle.db, SESSION, "nonexistent")).rejects.toThrow(NotFoundError);
    });

    it("親が祖父母の子として繰り上がる", async () => {
      const grandparent = await insertTask({ title: "祖父母" });
      const parent = await insertTask({ title: "親", parentId: grandparent.id });
      const child = await insertTask({ title: "子", parentId: parent.id });

      await outdentTask(handle.db, SESSION, child.id);

      const result = await getTaskById(handle.db, child.id);
      expect(result?.parentId).toBe(grandparent.id);
    });

    it("親がルート（parentId が null）の場合、アウトデント後は自分もルートになる", async () => {
      const parent = await insertTask({ title: "親（ルート）" });
      const child = await insertTask({ title: "子", parentId: parent.id });

      await outdentTask(handle.db, SESSION, child.id);

      const result = await getTaskById(handle.db, child.id);
      expect(result?.parentId).toBeNull();
    });

    it("親が論理削除済みの不整合データでは NotFoundError を投げ、階層を書き換えない（防御的ガード）", async () => {
      // 生存している子を持つ親は通常削除できない（lib/tasks/deletion.ts）が、
      // 万一その不変条件が破れたときに、祖父母 ID を undefined 扱いで
      // 黙ってルートへ繰り上げてしまわないことを確認する。
      const grandparent = await insertTask({ title: "祖父母" });
      const parent = await insertTask({ title: "親", parentId: grandparent.id });
      const child = await insertTask({ title: "子", parentId: parent.id });
      await handle.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, parent.id));

      await expect(outdentTask(handle.db, SESSION, child.id)).rejects.toThrow(NotFoundError);

      expect((await getTaskById(handle.db, child.id))?.parentId).toBe(parent.id);
    });

    it("既にルート（親が居ない）タスクは ValidationError を投げる", async () => {
      const root = await insertTask({ title: "root" });

      await expect(outdentTask(handle.db, SESSION, root.id)).rejects.toThrow(ValidationError);
    });

    it("sortOrder は新しい親（祖父母）の生存している子の末尾（最大 + 1）になる", async () => {
      const grandparent = await insertTask({ title: "祖父母" });
      await insertTask({ title: "祖父母の既存の子", parentId: grandparent.id, sortOrder: 5 });
      const parent = await insertTask({ title: "親", parentId: grandparent.id, sortOrder: 0 });
      const child = await insertTask({ title: "子", parentId: parent.id, sortOrder: 0 });

      await outdentTask(handle.db, SESSION, child.id);

      const result = await getTaskById(handle.db, child.id);
      expect(result?.sortOrder).toBe(6);
    });

    it("循環参照は起こらない: アウトデントで新しい親（祖父母）は常に自分の祖先であり子孫にはなり得ない", async () => {
      const grandparent = await insertTask({ title: "祖父母" });
      const parent = await insertTask({ title: "親", parentId: grandparent.id });
      const child = await insertTask({ title: "子", parentId: parent.id });
      const grandchild = await insertTask({ title: "孫", parentId: child.id });

      await outdentTask(handle.db, SESSION, child.id);

      const result = await getTaskById(handle.db, child.id);
      // 新しい親（grandparent）は元々 child の祖先であり、child の子孫ではあり得ない。
      expect(result?.parentId).toBe(grandparent.id);
      // grandchild は child の子のまま（アウトデントの巻き添えで動いていない）。
      expect((await getTaskById(handle.db, grandchild.id))?.parentId).toBe(child.id);
      // child から親を root まで辿っても、途中で child 自身に戻ってこない（循環していない）。
      await expectNoCycleFromAncestorChain(child.id);
    });

    it("プロジェクトをまたいだタスクは新しい親（祖父母）の子カウントに混ざらない（sortOrder算出のプロジェクト混在防止）", async () => {
      const [otherProject] = await handle.db.insert(projects).values({ name: "別PJ" }).returning();
      if (!otherProject) {
        throw new Error("Failed to create test project");
      }
      // 別プロジェクトの root タスク（sortOrder が大きい）。アウトデント後の
      // 新しい親（このプロジェクトの root = null）の子カウントに混ざってはいけない。
      await handle.db.insert(tasks).values({
        projectId: otherProject.id,
        title: "別PJのroot",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        sortOrder: 100,
      });

      const parent = await insertTask({ title: "親（ルート）", sortOrder: 0 });
      const child = await insertTask({ title: "子", parentId: parent.id, sortOrder: 0 });

      await outdentTask(handle.db, SESSION, child.id);

      const result = await getTaskById(handle.db, child.id);
      expect(result?.parentId).toBeNull();
      // 同一プロジェクトの root タスクは parent のみなので、sortOrder は 0（parent の次）+1 = 1。
      // 別PJの sortOrder=100 のタスクに引きずられて 101 にならないことを確認する。
      expect(result?.sortOrder).toBe(1);
    });
  });
});
