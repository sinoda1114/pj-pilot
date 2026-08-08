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
import { listBoardTasks, moveTaskOnBoard } from "./service";

const SESSION = { userId: "u1" };

describe("board/service", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-board-service-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });

    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    const [other] = await handle.db.insert(projects).values({ name: "Other" }).returning();
    projectId = project!.id;
    otherProjectId = other!.id;
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

  async function insertTask(overrides: {
    title: string;
    status?: "todo" | "in_progress" | "review" | "done";
    boardOrder?: number;
    type?: "task" | "summary" | "milestone";
    projectId?: string;
    deleted?: boolean;
  }) {
    const [task] = await handle.db
      .insert(tasks)
      .values({
        projectId: overrides.projectId ?? projectId,
        title: overrides.title,
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        status: overrides.status ?? "todo",
        boardOrder: overrides.boardOrder ?? 0,
        type: overrides.type ?? "task",
        deletedAt: overrides.deleted ? new Date() : null,
      })
      .returning();
    return task!;
  }

  /** 指定した列（status）のタスクを board_order 昇順でタイトル配列にして返す。 */
  async function columnTitles(status: string): Promise<string[]> {
    const rows = await handle.db.select().from(tasks).where(eq(tasks.projectId, projectId));
    return rows
      .filter((row) => row.status === status && row.deletedAt === null && row.type === "task")
      .sort((a, b) => a.boardOrder - b.boardOrder || a.id.localeCompare(b.id))
      .map((row) => row.title);
  }

  describe("listBoardTasks", () => {
    it("type='task' の生存タスクのみを board_order 昇順で返す（決定 P2-02）", async () => {
      await insertTask({ title: "2番目", boardOrder: 1 });
      await insertTask({ title: "1番目", boardOrder: 0 });
      await insertTask({ title: "サマリー", boardOrder: 0, type: "summary" });
      await insertTask({ title: "マイルストーン", boardOrder: 0, type: "milestone" });
      await insertTask({ title: "削除済み", boardOrder: 0, deleted: true });
      await insertTask({ title: "他PJ", boardOrder: 0, projectId: otherProjectId });

      const result = await listBoardTasks(handle.db, SESSION, projectId);

      expect(result.map((task) => task.title)).toEqual(["1番目", "2番目"]);
    });

    it("未ログインは UnauthorizedError を投げる", async () => {
      await expect(listBoardTasks(handle.db, null, projectId)).rejects.toThrow(UnauthorizedError);
    });

    it("存在しないプロジェクトは NotFoundError を投げる", async () => {
      await expect(listBoardTasks(handle.db, SESSION, "nope")).rejects.toThrow(NotFoundError);
    });
  });

  describe("moveTaskOnBoard", () => {
    it("列間の移動で status と board_order の両方が更新され、移動元が詰まる", async () => {
      const a = await insertTask({ title: "A", status: "todo", boardOrder: 0 });
      await insertTask({ title: "B", status: "todo", boardOrder: 1 });
      await insertTask({ title: "C", status: "todo", boardOrder: 2 });
      await insertTask({ title: "X", status: "in_progress", boardOrder: 0 });

      await moveTaskOnBoard(handle.db, SESSION, projectId, a.id, "in_progress", 1);

      expect(await columnTitles("todo")).toEqual(["B", "C"]);
      expect(await columnTitles("in_progress")).toEqual(["X", "A"]);

      // 移動元の列が 0..n-1 に詰め直されていること（欠番を残さない）
      const todoRows = await handle.db.select().from(tasks).where(eq(tasks.status, "todo"));
      expect(todoRows.map((row) => row.boardOrder).sort()).toEqual([0, 1]);
    });

    it("列内の並び替えができる", async () => {
      await insertTask({ title: "A", boardOrder: 0 });
      await insertTask({ title: "B", boardOrder: 1 });
      const c = await insertTask({ title: "C", boardOrder: 2 });

      await moveTaskOnBoard(handle.db, SESSION, projectId, c.id, "todo", 0);

      expect(await columnTitles("todo")).toEqual(["C", "A", "B"]);
    });

    it("空の列へ移動できる（空の列がドロップ先になる要件）", async () => {
      const a = await insertTask({ title: "A", status: "todo", boardOrder: 0 });

      await moveTaskOnBoard(handle.db, SESSION, projectId, a.id, "done", 0);

      expect(await columnTitles("todo")).toEqual([]);
      expect(await columnTitles("done")).toEqual(["A"]);
    });

    it("同じ列の同じ位置への移動は何も変えない", async () => {
      const a = await insertTask({ title: "A", boardOrder: 0 });
      await insertTask({ title: "B", boardOrder: 1 });
      const before = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));

      await moveTaskOnBoard(handle.db, SESSION, projectId, a.id, "todo", 0);

      const after = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
      expect(after[0]?.updatedAt).toEqual(before[0]?.updatedAt);
      expect(await columnTitles("todo")).toEqual(["A", "B"]);
    });

    it("他プロジェクトのタスクIDは NotFoundError（Server Action の引数は任意に送れるため）", async () => {
      const foreign = await insertTask({ title: "他PJ", projectId: otherProjectId });

      await expect(
        moveTaskOnBoard(handle.db, SESSION, projectId, foreign.id, "done", 0),
      ).rejects.toThrow(NotFoundError);
    });

    it("type='summary' のタスクはボード経由で動かせない", async () => {
      const summary = await insertTask({ title: "サマリー", type: "summary" });

      await expect(
        moveTaskOnBoard(handle.db, SESSION, projectId, summary.id, "done", 0),
      ).rejects.toThrow(ValidationError);
    });

    it("論理削除済みのタスクは対象外（NotFoundError）", async () => {
      const deleted = await insertTask({ title: "削除済み", deleted: true });

      await expect(
        moveTaskOnBoard(handle.db, SESSION, projectId, deleted.id, "done", 0),
      ).rejects.toThrow(NotFoundError);
    });

    it("論理削除済みプロジェクトのタスクは動かせない（NotFoundError）", async () => {
      // PJ の削除は owner 限定だが（決定 D-15）、`deleteProject` は
      // `projects.deleted_at` を立てるだけで配下タスクには触れない。PJ の生存を
      // 見ないと、owner が消して画面から見えなくなった PJ のカードを誰でも
      // 動かし続けられる。他の Server Action と条件を揃える。
      const a = await insertTask({ title: "A" });
      await handle.db
        .update(projects)
        .set({ deletedAt: new Date() })
        .where(eq(projects.id, projectId));

      await expect(
        moveTaskOnBoard(handle.db, SESSION, projectId, a.id, "done", 0),
      ).rejects.toThrow(NotFoundError);

      const [unchanged] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
      expect(unchanged?.status).toBe("todo");
    });

    it("未ログインは UnauthorizedError を投げる", async () => {
      const a = await insertTask({ title: "A" });

      await expect(moveTaskOnBoard(handle.db, null, projectId, a.id, "done", 0)).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it("不正な status は ValidationError を投げる", async () => {
      const a = await insertTask({ title: "A" });

      await expect(
        // ランタイムでは任意の文字列が届きうるため、型を外して検証する
        moveTaskOnBoard(handle.db, SESSION, projectId, a.id, "bogus" as never, 0),
      ).rejects.toThrow(ValidationError);
    });

    it("範囲外の index は末尾に丸める（列を壊さない）", async () => {
      const a = await insertTask({ title: "A", boardOrder: 0 });
      await insertTask({ title: "B", boardOrder: 1 });

      await moveTaskOnBoard(handle.db, SESSION, projectId, a.id, "todo", 999);

      expect(await columnTitles("todo")).toEqual(["B", "A"]);
    });

    it("移動先の列に summary/削除済み/他PJ が混ざっていても、それらの board_order を書き換えない", async () => {
      const a = await insertTask({ title: "A", status: "todo", boardOrder: 0 });
      const summary = await insertTask({
        title: "サマリー",
        status: "done",
        boardOrder: 7,
        type: "summary",
      });
      const deleted = await insertTask({
        title: "削除済み",
        status: "done",
        boardOrder: 8,
        deleted: true,
      });

      await moveTaskOnBoard(handle.db, SESSION, projectId, a.id, "done", 0);

      const summaryAfter = await handle.db.select().from(tasks).where(eq(tasks.id, summary.id));
      const deletedAfter = await handle.db.select().from(tasks).where(eq(tasks.id, deleted.id));
      expect(summaryAfter[0]?.boardOrder).toBe(7);
      expect(deletedAfter[0]?.boardOrder).toBe(8);
      expect(await columnTitles("done")).toEqual(["A"]);
    });
  });
});
