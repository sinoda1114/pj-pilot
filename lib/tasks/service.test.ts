import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnauthorizedError } from "../auth/errors";
import { createDb, type DbHandle } from "../db/client";
import { projects, tasks } from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { createTask, getTask, listTasks, updateTask } from "./service";

const SESSION = { userId: "u1" };

describe("tasks/service", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-tasks-service-test-"));
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

  describe("createTask", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      await expect(
        createTask(handle.db, null, projectId, {
          title: "T",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
        }),
      ).rejects.toThrow(UnauthorizedError);
    });

    /**
     * Issue #55: 画面の「新規タスク作成」は `boardOrder` を渡さないため、
     * 採番しないと全タスクが既定値 0 のまま作られる。すると
     *   - カンバンの初期表示順が id（cuid2）依存になり、作成順にならない
     *   - `board_order` の正規化が崩れ、並び替えの前提が最初から成立しない
     * の2つが起きる。移動先の列の末尾に採番する。
     */
    it("boardOrder を指定しない場合、同じ status 列の末尾に採番される", async () => {
      const first = await createTask(handle.db, SESSION, projectId, {
        title: "1件目",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      const second = await createTask(handle.db, SESSION, projectId, {
        title: "2件目",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      // 別の列は独立して 0 から始まる
      const done = await createTask(handle.db, SESSION, projectId, {
        title: "完了列の1件目",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        status: "done",
      });

      expect(first.boardOrder).toBe(0);
      expect(second.boardOrder).toBe(1);
      expect(done.boardOrder).toBe(0);
    });

    it("採番は生存しているタスクだけを見る（削除済みは詰める）", async () => {
      const a = await createTask(handle.db, SESSION, projectId, {
        title: "A",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      await handle.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, a.id));

      const next = await createTask(handle.db, SESSION, projectId, {
        title: "B",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      expect(next.boardOrder).toBe(0);
    });

    it("列に欠番や大きい値があっても、必ず末尾に採番される", async () => {
      // Drawer でステータスを変えると board_order は移動元の値のまま持ち込まれるため、
      // 列の中に「件数より大きい値」が残ることがある。件数で採番すると既存行の前に
      // 割り込んでしまう。
      await handle.db.insert(tasks).values({
        projectId,
        title: "既存",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        status: "done",
        boardOrder: 7,
      });

      const created = await createTask(handle.db, SESSION, projectId, {
        title: "新規",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        status: "done",
      });

      expect(created.boardOrder).toBe(8);
    });

    it("boardOrder を明示的に渡した場合はその値を使う", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        boardOrder: 7,
      });

      expect(task.boardOrder).toBe(7);
    });

    it("存在しないプロジェクトは NotFoundError を投げる", async () => {
      await expect(
        createTask(handle.db, SESSION, "nonexistent-project", {
          title: "T",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it("タスクを作成できる", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "設計",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        priority: "high",
      });

      expect(task.title).toBe("設計");
      expect(task.priority).toBe("high");
      expect(task.projectId).toBe(projectId);
    });

    it.each([
      ["不正な形式", "2026-13-01", "2026-08-05"],
      ["実在しない日付", "2026-02-30", "2026-08-05"],
    ])("%s の日付は ValidationError を投げる", async (_label, startDate, endDate) => {
      await expect(
        createTask(handle.db, SESSION, projectId, { title: "T", startDate, endDate }),
      ).rejects.toThrow(ValidationError);
    });

    it("終了日が開始日より前だと ValidationError を投げる", async () => {
      await expect(
        createTask(handle.db, SESSION, projectId, {
          title: "T",
          startDate: "2026-08-10",
          endDate: "2026-08-01",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("開始日と終了日が同じ日（1日タスク）は許可される", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "1日タスク",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
      });

      expect(task.startDate).toBe("2026-08-01");
      expect(task.endDate).toBe("2026-08-01");
    });

    it("存在しない親タスクは NotFoundError を投げる", async () => {
      await expect(
        createTask(handle.db, SESSION, projectId, {
          title: "T",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          parentId: "nonexistent-task",
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it("他のプロジェクトのタスクを親にすると ValidationError を投げる", async () => {
      const [otherProject] = await handle.db.insert(projects).values({ name: "他PJ" }).returning();
      if (!otherProject) {
        throw new Error("Failed to create other project");
      }
      const otherTask = await createTask(handle.db, SESSION, otherProject.id, {
        title: "他PJのタスク",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      await expect(
        createTask(handle.db, SESSION, projectId, {
          title: "T",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          parentId: otherTask.id,
        }),
      ).rejects.toThrow(ValidationError);
    });

    /**
     * Issue #59: 決定 D-11 の集計（日付・進捗・工数の親への積み上げ）は
     * `type === "summary"` の行しか処理しない。子を作った時点で親に印を
     * 付けないと、集計が静かに効かなくなる。
     */
    it("parentId を指定して作成すると、親が summary になる", async () => {
      const parent = await createTask(handle.db, SESSION, projectId, {
        title: "親",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      expect(parent.type).toBe("task");

      await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: parent.id,
      });

      expect((await getTask(handle.db, SESSION, parent.id)).type).toBe("summary");
    });

    it("親が milestone の場合は種別を書き換えない", async () => {
      const parent = await createTask(handle.db, SESSION, projectId, {
        title: "マイルストーン",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
        type: "milestone",
      });

      await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: parent.id,
      });

      expect((await getTask(handle.db, SESSION, parent.id)).type).toBe("milestone");
    });

    it("parentId を指定しない作成では、どのタスクも summary にならない", async () => {
      const first = await createTask(handle.db, SESSION, projectId, {
        title: "A",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      const second = await createTask(handle.db, SESSION, projectId, {
        title: "B",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      expect((await getTask(handle.db, SESSION, first.id)).type).toBe("task");
      expect(second.type).toBe("task");
    });
  });

  describe("listTasks", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      await expect(listTasks(handle.db, null, projectId)).rejects.toThrow(UnauthorizedError);
    });

    it("存在しないプロジェクトは NotFoundError を投げる", async () => {
      await expect(listTasks(handle.db, SESSION, "nonexistent-project")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("プロジェクトに紐づく生存タスクを返す", async () => {
      await createTask(handle.db, SESSION, projectId, {
        title: "T1",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      await createTask(handle.db, SESSION, projectId, {
        title: "T2",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      const result = await listTasks(handle.db, SESSION, projectId);

      expect(result.map((t) => t.title).sort()).toEqual(["T1", "T2"]);
    });
  });

  describe("getTask", () => {
    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(getTask(handle.db, SESSION, "nonexistent-task")).rejects.toThrow(NotFoundError);
    });

    it("タスクを1件返す", async () => {
      const created = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      const result = await getTask(handle.db, SESSION, created.id);

      expect(result.id).toBe(created.id);
    });
  });

  describe("updateTask", () => {
    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(
        updateTask(handle.db, SESSION, "nonexistent-task", { title: "x" }),
      ).rejects.toThrow(NotFoundError);
    });

    it("決定 D-15: 誰でも編集できる", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "元の名前",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      const updated = await updateTask(handle.db, { userId: "other-user" }, task.id, {
        status: "in_progress",
      });

      expect(updated.status).toBe("in_progress");
    });

    it("boardOrder は許可リストに含まれており、更新できる（Phase 2 §4.4）", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      expect(task.boardOrder).toBe(0);

      const updated = await updateTask(handle.db, SESSION, task.id, { boardOrder: 3 });

      expect(updated.boardOrder).toBe(3);
      // sortOrder（WBS階層の表示順）は別の軸。boardOrder を動かしても影響しない
      // （決定 P2-03: 共用すると Gantt 側の並びが壊れるため列を分けている）。
      expect(updated.sortOrder).toBe(task.sortOrder);
    });

    it("更新項目が空でも例外にならない", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      const result = await updateTask(handle.db, SESSION, task.id, {});

      expect(result).toEqual(task);
    });

    it("片方だけ日付を更新すると、既存の日付との前後関係で検証する", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-10",
      });

      // 開始日だけを終了日より後にしようとするとエラー
      await expect(
        updateTask(handle.db, SESSION, task.id, { startDate: "2026-08-11" }),
      ).rejects.toThrow(ValidationError);

      const updated = await updateTask(handle.db, SESSION, task.id, { startDate: "2026-08-05" });
      expect(updated.startDate).toBe("2026-08-05");
    });

    it("自分自身を親にすると ValidationError を投げる", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      await expect(updateTask(handle.db, SESSION, task.id, { parentId: task.id })).rejects.toThrow(
        ValidationError,
      );
    });

    it("子孫を親にすると循環参照として ValidationError を投げる", async () => {
      const parent = await createTask(handle.db, SESSION, projectId, {
        title: "親",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: parent.id,
      });

      await expect(
        updateTask(handle.db, SESSION, parent.id, { parentId: child.id }),
      ).rejects.toThrow(ValidationError);
    });

    it("parentId を null にして親を外せる", async () => {
      const parent = await createTask(handle.db, SESSION, projectId, {
        title: "親",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: parent.id,
      });

      const updated = await updateTask(handle.db, SESSION, child.id, { parentId: null });

      expect(updated.parentId).toBeNull();
    });

    it("存在しないタスクを親に指定すると NotFoundError を投げる", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      await expect(
        updateTask(handle.db, SESSION, task.id, { parentId: "nonexistent-task" }),
      ).rejects.toThrow(NotFoundError);
    });

    it("他プロジェクトのタスクを親に指定すると ValidationError を投げる（PJ をまたぐ親子関係の防止）", async () => {
      const [otherProject] = await handle.db.insert(projects).values({ name: "他PJ" }).returning();
      if (!otherProject) {
        throw new Error("Failed to create other project");
      }
      const otherTask = await createTask(handle.db, SESSION, otherProject.id, {
        title: "他PJのタスク",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      await expect(
        updateTask(handle.db, SESSION, task.id, { parentId: otherTask.id }),
      ).rejects.toThrow(ValidationError);

      expect((await getTask(handle.db, SESSION, task.id)).parentId).toBeNull();
    });

    it("子を持つタスクでも、子孫でない別のタスクの下へは付け替えできる（循環チェックの偽陽性防止）", async () => {
      // 循環チェック（isDescendantOf）が「子孫を親にする」以外まで巻き込んで
      // 拒否してしまうと、正常な階層編集ができなくなる。子を持つタスクを
      // 無関係な別枝へ移せることを確認する。
      const movingParent = await createTask(handle.db, SESSION, projectId, {
        title: "移動する親",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "その子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: movingParent.id,
      });
      const newParent = await createTask(handle.db, SESSION, projectId, {
        title: "新しい親（別枝）",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      const updated = await updateTask(handle.db, SESSION, movingParent.id, {
        parentId: newParent.id,
      });

      expect(updated.parentId).toBe(newParent.id);
      // 子は移動した親の下のまま（巻き添えで動いていない）。
      expect((await getTask(handle.db, SESSION, child.id)).parentId).toBe(movingParent.id);
    });

    it("parent_id が循環している不整合データでも、循環チェックが無限ループしない（防御的ガード）", async () => {
      // 本来は作れないが、直接 SQL で A→B→A の循環を作る。この状態で
      // 親を付け替えると isDescendantOf の BFS が同じノードを何度も辿るため、
      // 訪問済み判定が無いと処理が返ってこなくなる。
      const a = await createTask(handle.db, SESSION, projectId, {
        title: "A",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      const b = await createTask(handle.db, SESSION, projectId, {
        title: "B",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: a.id,
      });
      const newParent = await createTask(handle.db, SESSION, projectId, {
        title: "新しい親",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      await handle.db.update(tasks).set({ parentId: b.id }).where(eq(tasks.id, a.id));

      const updated = await updateTask(handle.db, SESSION, a.id, { parentId: newParent.id });

      expect(updated.parentId).toBe(newParent.id);
    });

    it("マスアサインメント対策: 型に無い projectId が混入しても他プロジェクトへ移動しない（セキュリティレビュー指摘）", async () => {
      const [otherProject] = await handle.db.insert(projects).values({ name: "他PJ" }).returning();
      if (!otherProject) {
        throw new Error("Failed to create other project");
      }
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      // UpdateTaskInput はコンパイル時の型でしかなく、将来 Server Action が
      // ランタイム検証を省略した場合を想定した攻撃シナリオ: projectId を
      // smuggle して、createTask 時点の同一プロジェクト検証を経ずに
      // タスクを別プロジェクトへ移動しようとするケース。
      const maliciousInput = {
        title: "改ざん後",
        projectId: otherProject.id,
      } as unknown as Parameters<typeof updateTask>[3];

      const updated = await updateTask(handle.db, SESSION, task.id, maliciousInput);

      expect(updated.title).toBe("改ざん後");
      expect(updated.projectId).toBe(projectId);
    });

    it("マスアサインメント対策: 型に無い deletedAt が混入しても復活しない（セキュリティレビュー指摘）", async () => {
      const task = await createTask(handle.db, SESSION, projectId, {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
      const maliciousInput = {
        title: "改ざん後",
        deletedAt: new Date(),
      } as unknown as Parameters<typeof updateTask>[3];

      const updated = await updateTask(handle.db, SESSION, task.id, maliciousInput);

      expect(updated.deletedAt).toBeNull();
    });
  });

  /**
   * Issue #59: 親を付け替えると新旧2つの親の `type` が同時に動く。片方でも
   * 漏れると「子が居るのに task（集計されない）」か「子が0件なのに summary
   * （カンバン・ダッシュボードから消え、Gantt でも動かせない）」が残る。
   */
  describe("updateTask による summary の付け外し", () => {
    async function createRootTask(title: string) {
      return createTask(handle.db, SESSION, projectId, {
        title,
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });
    }

    async function typeOf(taskId: string) {
      return (await getTask(handle.db, SESSION, taskId)).type;
    }

    it("別の親へ移すと、新しい親が summary になり、元の親は task に戻る", async () => {
      const oldParent = await createRootTask("元の親");
      const newParent = await createRootTask("新しい親");
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: oldParent.id,
      });
      expect(await typeOf(oldParent.id)).toBe("summary");

      await updateTask(handle.db, SESSION, child.id, { parentId: newParent.id });

      expect(await typeOf(newParent.id)).toBe("summary");
      expect(await typeOf(oldParent.id)).toBe("task");
    });

    it("元の親に他の子が残っていれば summary のまま", async () => {
      const oldParent = await createRootTask("元の親");
      const newParent = await createRootTask("新しい親");
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "移動する子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: oldParent.id,
      });
      await createTask(handle.db, SESSION, projectId, {
        title: "残る子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: oldParent.id,
      });

      await updateTask(handle.db, SESSION, child.id, { parentId: newParent.id });

      expect(await typeOf(oldParent.id)).toBe("summary");
      expect(await typeOf(newParent.id)).toBe("summary");
    });

    it("parentId を null にしてルート化すると、元の親から印が外れる", async () => {
      const parent = await createRootTask("親");
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: parent.id,
      });
      expect(await typeOf(parent.id)).toBe("summary");

      await updateTask(handle.db, SESSION, child.id, { parentId: null });

      expect(await typeOf(parent.id)).toBe("task");
    });

    it("ルートのタスクを初めて親の下に入れると、その親が summary になる", async () => {
      const parent = await createRootTask("親");
      const orphan = await createRootTask("ルートのタスク");

      await updateTask(handle.db, SESSION, orphan.id, { parentId: parent.id });

      expect(await typeOf(parent.id)).toBe("summary");
    });

    it("親が milestone の場合、付け替えても種別を書き換えない", async () => {
      const oldParent = await createRootTask("元の親");
      const milestone = await createTask(handle.db, SESSION, projectId, {
        title: "マイルストーン",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
        type: "milestone",
      });
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: oldParent.id,
      });

      await updateTask(handle.db, SESSION, child.id, { parentId: milestone.id });

      expect(await typeOf(milestone.id)).toBe("milestone");
      expect(await typeOf(oldParent.id)).toBe("task");
    });

    /**
     * 「親に UPDATE が飛んでいない」ことを `updatedAt` で見る。`updated_at` は
     * 秒精度（mode: "timestamp"）なので、直後に比較しても同一秒に収まって
     * 素通ししてしまう。そのため親の `updatedAt` を過去に倒してから確認する
     * （`$onUpdate` は明示指定した値を上書きしないため、この細工が効く）。
     */
    const SENTINEL_UPDATED_AT = new Date("2020-01-01T00:00:00Z");

    async function backdateUpdatedAt(taskId: string) {
      await handle.db
        .update(tasks)
        .set({ updatedAt: SENTINEL_UPDATED_AT })
        .where(eq(tasks.id, taskId));
    }

    it("parentId を変えない更新では、親に余計な UPDATE を撃たない", async () => {
      const parent = await createRootTask("親");
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: parent.id,
      });
      expect(await typeOf(parent.id)).toBe("summary");
      await backdateUpdatedAt(parent.id);

      await updateTask(handle.db, SESSION, child.id, { title: "タイトルだけ変更" });

      const parentAfterUpdate = await getTask(handle.db, SESSION, parent.id);
      expect(parentAfterUpdate.type).toBe("summary");
      expect(parentAfterUpdate.updatedAt).toEqual(SENTINEL_UPDATED_AT);
    });

    it("同じ親を指定し直しただけの更新でも、親に余計な UPDATE を撃たない", async () => {
      const parent = await createRootTask("親");
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: parent.id,
      });
      await backdateUpdatedAt(parent.id);

      await updateTask(handle.db, SESSION, child.id, { parentId: parent.id });

      const parentAfterUpdate = await getTask(handle.db, SESSION, parent.id);
      expect(parentAfterUpdate.type).toBe("summary");
      expect(parentAfterUpdate.updatedAt).toEqual(SENTINEL_UPDATED_AT);
    });

    it("検証に失敗した更新では、親の印が一切変わらない", async () => {
      const oldParent = await createRootTask("元の親");
      const child = await createTask(handle.db, SESSION, projectId, {
        title: "子",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        parentId: oldParent.id,
      });

      await expect(
        updateTask(handle.db, SESSION, child.id, { parentId: "nonexistent-task" }),
      ).rejects.toThrow(NotFoundError);

      expect(await typeOf(oldParent.id)).toBe("summary");
    });
  });

  describe("createTask マスアサインメント対策（セキュリティレビュー指摘）", () => {
    it("型に無い id が混入しても、指定した id ではなく自動生成の id が使われる", async () => {
      const maliciousInput = {
        id: "attacker-chosen-id",
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      } as unknown as Parameters<typeof createTask>[3];

      const task = await createTask(handle.db, SESSION, projectId, maliciousInput);

      expect(task.id).not.toBe("attacker-chosen-id");
    });

    it("型に無い deletedAt が混入しても、削除済み状態では作成されない", async () => {
      const maliciousInput = {
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        deletedAt: new Date(),
      } as unknown as Parameters<typeof createTask>[3];

      const task = await createTask(handle.db, SESSION, projectId, maliciousInput);

      expect(task.deletedAt).toBeNull();
    });
  });
});
