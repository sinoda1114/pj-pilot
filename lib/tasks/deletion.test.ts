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

    it("循環した parent_id があっても無限ループせず、循環に含まれるタスクを削除する（防御的ガード）", async () => {
      // 本来 CHECK 制約でも防げない多段循環（A→B→A）を直接 SQL で作る。
      // 子孫の収集が訪問済み判定を失うと、この構造で処理が返ってこなくなる。
      const a = await insertTask({ title: "A" });
      const b = await insertTask({ title: "B", parentId: a.id });
      await handle.db.update(tasks).set({ parentId: b.id }).where(eq(tasks.id, a.id));

      await expect(deleteTaskSubtree(handle.db, SESSION, a.id)).resolves.toBeUndefined();

      expect((await getTaskById(handle.db, a.id))?.deletedAt).not.toBeNull();
      expect((await getTaskById(handle.db, b.id))?.deletedAt).not.toBeNull();
    });
  });

  describe("promoteChildrenAndDeleteTask", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      const task = await insertTask();
      await expect(promoteChildrenAndDeleteTask(handle.db, null, task.id)).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it("存在しないタスクは NotFoundError を投げる", async () => {
      await expect(promoteChildrenAndDeleteTask(handle.db, SESSION, "nonexistent")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("既に論理削除済みのタスクは NotFoundError を投げる（二重削除で子を巻き込まない）", async () => {
      const parent = await insertTask({ title: "親" });
      const child = await insertTask({ title: "子", parentId: parent.id });
      await promoteChildrenAndDeleteTask(handle.db, SESSION, parent.id);

      await expect(promoteChildrenAndDeleteTask(handle.db, SESSION, parent.id)).rejects.toThrow(
        NotFoundError,
      );

      // 1回目の繰り上げでルートに上がった子が、2回目の呼び出しで動かされていない。
      expect((await getTaskById(handle.db, child.id))?.parentId).toBeNull();
      expect((await getTaskById(handle.db, child.id))?.deletedAt).toBeNull();
    });

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

    /**
     * Issue #54: 「子タスクごと削除」したあと親だけを復元すると、子孫がゴミ箱に
     * 取り残され、30日後の cron で静かに物理削除されていた（データ消失）。
     *
     * 復元の範囲は「**同じ操作で消したもの**」に限る。`deleteTaskSubtree` は全行に
     * 同一の `deleted_at` を入れるので、それを手掛かりに判定する。別々のタイミングで
     * 消した子まで巻き込んで戻すと、利用者が意図して残したものを勝手に復活させて
     * しまうため。
     */
    it("サブツリー削除した親を復元すると、同時に消した子孫もまとめて戻る（Issue #54）", async () => {
      const root = await insertTask({ title: "root" });
      const child = await insertTask({ title: "child", parentId: root.id });
      const grandchild = await insertTask({ title: "grandchild", parentId: child.id });
      await deleteTaskSubtree(handle.db, SESSION, root.id);

      await restoreTask(handle.db, SESSION, root.id);

      expect((await getTaskById(handle.db, root.id))?.deletedAt).toBeNull();
      expect((await getTaskById(handle.db, child.id))?.deletedAt).toBeNull();
      expect((await getTaskById(handle.db, grandchild.id))?.deletedAt).toBeNull();
    });

    it("別のタイミングで消した子孫は復活させない", async () => {
      const root = await insertTask({ title: "root" });
      const child = await insertTask({ title: "child", parentId: root.id });
      // 先に子だけを消しておく（利用者が意図して消したもの）
      await deleteTask(handle.db, SESSION, child.id);
      await handle.db
        .update(tasks)
        .set({ deletedAt: new Date("2020-01-01T00:00:00Z") })
        .where(eq(tasks.id, child.id));
      // そのあと親を消す
      await deleteTask(handle.db, SESSION, root.id);

      await restoreTask(handle.db, SESSION, root.id);

      expect((await getTaskById(handle.db, root.id))?.deletedAt).toBeNull();
      expect((await getTaskById(handle.db, child.id))?.deletedAt).not.toBeNull();
    });

    it("子孫の復元は祖先の復元と両立する（中間から復元しても全体が戻る）", async () => {
      const root = await insertTask({ title: "root" });
      const child = await insertTask({ title: "child", parentId: root.id });
      const grandchild = await insertTask({ title: "grandchild", parentId: child.id });
      await deleteTaskSubtree(handle.db, SESSION, root.id);

      await restoreTask(handle.db, SESSION, child.id);

      expect((await getTaskById(handle.db, root.id))?.deletedAt).toBeNull();
      expect((await getTaskById(handle.db, child.id))?.deletedAt).toBeNull();
      expect((await getTaskById(handle.db, grandchild.id))?.deletedAt).toBeNull();
    });

    it("生存している祖先には触らない", async () => {
      const root = await insertTask({ title: "root" });
      const child = await insertTask({ title: "child", parentId: root.id });
      await deleteTask(handle.db, SESSION, child.id);

      await restoreTask(handle.db, SESSION, child.id);

      expect((await getTaskById(handle.db, root.id))?.deletedAt).toBeNull();
    });

    it("祖先の行が物理削除で消えていても、そこで打ち切って対象タスクだけ復元する", async () => {
      // 実際に起こり得る状態: `lib/tasks/purge.ts` は 30 日超前に論理削除された
      // タスクを子の `parent_id` を書き換えずに物理削除する。本番（Turso の HTTP 接続）は
      // 外部キー制約が効かない前提（lib/db/client.ts）なので、親だけ先に消えて
      // 子の `parent_id` が宙に浮いたゴミ箱タスクが残り得る。
      // その状態で復元しても NotFoundError にならず復元できることを確認する。
      const ancestor = await insertTask({ title: "先に物理削除される祖先" });
      const child = await insertTask({ title: "残る子", parentId: ancestor.id });
      await deleteTaskSubtree(handle.db, SESSION, ancestor.id);
      // テスト DB では外部キー制約が有効なので、本番相当の状態を作るため一時的に外す。
      await handle.client.execute("PRAGMA foreign_keys = OFF;");
      await handle.db.delete(tasks).where(eq(tasks.id, ancestor.id));
      await handle.client.execute("PRAGMA foreign_keys = ON;");

      await expect(restoreTask(handle.db, SESSION, child.id)).resolves.toBeUndefined();

      expect((await getTaskById(handle.db, child.id))?.deletedAt).toBeNull();
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

/**
 * summary の印の付け外し（Issue #51）。
 *
 * 親子関係が変わるすべての経路で整合が取れていないと、「生存する子を持つ task」
 * （決定 D-11 の集計が効かない）や「子が0件の summary」（カンバン・ダッシュボードから
 * 消え、Gantt でもドラッグできない行き止まり）が生まれる。
 */
describe("削除・復元と type='summary' の整合", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-summary-marker-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    projectId = project!.id;
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

  async function mk(title: string, parentId: string | null, type: "task" | "summary" = "task") {
    const [t] = await handle.db
      .insert(tasks)
      .values({
        projectId,
        title,
        parentId,
        type,
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      })
      .returning();
    return t!;
  }

  it("最後の子を削除すると、親の summary の印が外れる", async () => {
    const parent = await mk("親", null, "summary");
    const child = await mk("子", parent.id);

    await deleteTask(handle.db, SESSION, child.id);

    expect((await getTaskById(handle.db, parent.id))?.type).toBe("task");
  });

  it("子が残っているうちは summary のままにする", async () => {
    const parent = await mk("親", null, "summary");
    const a = await mk("子A", parent.id);
    await mk("子B", parent.id);

    await deleteTask(handle.db, SESSION, a.id);

    expect((await getTaskById(handle.db, parent.id))?.type).toBe("summary");
  });

  it("サブツリー削除でも、残された親の印が外れる", async () => {
    const parent = await mk("親", null, "summary");
    const child = await mk("子", parent.id, "summary");
    await mk("孫", child.id);

    await deleteTaskSubtree(handle.db, SESSION, child.id);

    expect((await getTaskById(handle.db, parent.id))?.type).toBe("task");
  });

  it("子を繰り上げて削除すると、繰り上げ先が summary になる", async () => {
    const grandparent = await mk("祖父", null);
    const parent = await mk("親", grandparent.id, "summary");
    await mk("子", parent.id);

    await promoteChildrenAndDeleteTask(handle.db, SESSION, parent.id);

    // 子は祖父の直下へ上がるので、祖父が summary になる
    expect((await getTaskById(handle.db, grandparent.id))?.type).toBe("summary");
  });

  it("復元すると、親に summary の印が付き直す", async () => {
    const parent = await mk("親", null, "summary");
    const child = await mk("子", parent.id);
    // 最後の子を消して印が外れた状態を作る
    await deleteTask(handle.db, SESSION, child.id);
    expect((await getTaskById(handle.db, parent.id))?.type).toBe("task");

    await restoreTask(handle.db, SESSION, child.id);

    expect((await getTaskById(handle.db, parent.id))?.type).toBe("summary");
  });

  it("子を繰り上げて消したサマリーを復元しても、子0件のサマリーは復活させない", async () => {
    // 復元は親方向だけでなく自分自身の印も整える必要がある。子0件のサマリーが
    // 復活すると、カンバン・ダッシュボードから消え Gantt でも動かせない
    // 行き止まりの行になる（実測で再現）。
    const grandparent = await mk("祖父", null);
    const parent = await mk("親", grandparent.id, "summary");
    await mk("子", parent.id);
    await promoteChildrenAndDeleteTask(handle.db, SESSION, parent.id);

    await restoreTask(handle.db, SESSION, parent.id);

    expect((await getTaskById(handle.db, parent.id))?.type).toBe("task");
  });

  it("マイルストーンは印の付け外しで書き換えない", async () => {
    const parent = await mk("親", null);
    await handle.db.update(tasks).set({ type: "milestone" }).where(eq(tasks.id, parent.id));
    const child = await mk("子", parent.id);

    await restoreTask(handle.db, SESSION, child.id);
    await deleteTask(handle.db, SESSION, child.id);

    expect((await getTaskById(handle.db, parent.id))?.type).toBe("milestone");
  });
});
