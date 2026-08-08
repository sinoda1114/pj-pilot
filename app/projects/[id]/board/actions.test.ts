/**
 * カンバンボードの Server Action のテスト（Phase 2 M8 #41）。
 *
 * `app/projects/[id]/tasks/actions.test.ts` と同じ構成。`actions.ts` は
 * `db` シングルトンと `getSession()`（内部で `next/headers` を呼ぶ）に直接依存する
 * ため、`vi.mock` で一時 DB とセッションを注入する。
 *
 * ここで検証するのは Server Action の責務、すなわち
 * 「ランタイム検証」「ドメインエラーの ActionResult 化」「予期しないエラーの再 throw」の3点。
 * 並び替えのロジック自体は lib/board/service.test.ts と lib/board/order.test.ts が持つ。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../../../../lib/db/client";
import { projects, tasks } from "../../../../lib/db/schema";
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

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { moveTaskOnBoardAction } = await import("./actions");

describe("app/projects/[id]/board/actions", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;
  let taskId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-board-actions-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    state.db = handle.db;
    state.session = { userId: "u1" };

    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    projectId = project!.id;

    const [task] = await handle.db
      .insert(tasks)
      .values({
        projectId,
        title: "A",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      })
      .returning();
    taskId = task!.id;
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

  it("正常系: ステータスと順序が更新される", async () => {
    const result = await moveTaskOnBoardAction(projectId, taskId, "in_progress", 0);

    expect(result).toEqual({ ok: true });
    const [after] = await handle.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(after?.status).toBe("in_progress");
  });

  it("未ログインは ok:false を返す（例外を投げない）", async () => {
    state.session = null;

    const result = await moveTaskOnBoardAction(projectId, taskId, "done", 0);

    expect(result.ok).toBe(false);
  });

  it.each([
    ["taskId が文字列でない", 123, "done", 0],
    ["taskId が空文字", "   ", "done", 0],
    ["status が enum 外", "t", "bogus", 0],
    ["status が文字列でない", "t", 42, 0],
    ["index が負数", "t", "done", -1],
    ["index が小数", "t", "done", 1.5],
    ["index が数値でない", "t", "done", "0"],
  ])("ランタイム検証: %s は ok:false を返す", async (_label, badTaskId, badStatus, badIndex) => {
    const result = await moveTaskOnBoardAction(projectId, badTaskId, badStatus, badIndex);

    expect(result.ok).toBe(false);
  });

  it("他プロジェクトのタスクIDは ok:false を返す（マスアサインメント防止）", async () => {
    const [other] = await handle.db.insert(projects).values({ name: "Other" }).returning();
    const [foreign] = await handle.db
      .insert(tasks)
      .values({
        projectId: other!.id,
        title: "他PJ",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      })
      .returning();

    const result = await moveTaskOnBoardAction(projectId, foreign!.id, "done", 0);

    expect(result.ok).toBe(false);
    // 実際に書き換わっていないことも確認する（メッセージだけ見て安心しない）
    const [after] = await handle.db.select().from(tasks).where(eq(tasks.id, foreign!.id));
    expect(after?.status).toBe("todo");
  });

  it("予期しないエラーは握りつぶさず再 throw する", async () => {
    state.db = {
      transaction: () => {
        throw new TypeError("想定外の障害");
      },
    } as never;

    await expect(moveTaskOnBoardAction(projectId, taskId, "done", 0)).rejects.toThrow(TypeError);
  });
});
