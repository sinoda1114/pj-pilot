import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";

/**
 * マイグレーションのバックフィルの検証（Phase 2 §4.3）。
 *
 * `0003` は `tasks.board_order` を追加する。`NOT NULL DEFAULT 0` を足すだけだと
 * 既存の全タスクが 0 になり、カンバンの列内の順序が「同値の並び」＝不定になる。
 * そのため生成された `ALTER TABLE` に手書きでバックフィルの `UPDATE` を足してある。
 *
 * ここでは「0003 の直前まで適用した DB に既存データを入れてから 0003 を当てる」
 * という、実際の本番と同じ順序を再現して検証する。まっさらな DB に全マイグレーションを
 * 一気に当てるだけでは、バックフィル対象の行が1件も無く、この UPDATE を一切検証できない。
 */

const MIGRATIONS_BEFORE_BOARD_ORDER = ["0000", "0001", "0002"] as const;

describe("drizzle migrations: 0003 board_order のバックフィル", () => {
  let dir: string;
  let handle: DbHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-migration-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
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

  /**
   * `drizzle/` のマイグレーションのうち、0003 より前のものだけを手で適用する。
   * `migrate()` はフォルダ内の全件を当ててしまうため、途中で止めるにはこの方法しかない。
   */
  async function applyMigrationsBeforeBoardOrder(): Promise<void> {
    const { readdirSync, readFileSync } = await import("node:fs");
    const files = readdirSync("./drizzle")
      .filter((name) => name.endsWith(".sql"))
      .filter((name) => MIGRATIONS_BEFORE_BOARD_ORDER.some((prefix) => name.startsWith(prefix)))
      .sort();

    expect(files).toHaveLength(MIGRATIONS_BEFORE_BOARD_ORDER.length);

    for (const file of files) {
      const sql = readFileSync(join("./drizzle", file), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim().length > 0) {
          await handle.client.executeMultiple(statement);
        }
      }
    }
  }

  /** 0003 だけを適用する。 */
  async function applyBoardOrderMigration(): Promise<void> {
    const { readdirSync, readFileSync } = await import("node:fs");
    const file = readdirSync("./drizzle").find((name) => name.startsWith("0003"));
    expect(file).toBeDefined();

    const sql = readFileSync(join("./drizzle", file!), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) {
        await handle.client.executeMultiple(statement);
      }
    }
  }

  async function insertTaskBefore0003(row: {
    id: string;
    projectId: string;
    status: string;
    createdAt: number;
  }): Promise<void> {
    await handle.client.execute({
      sql: `INSERT INTO tasks (id, project_id, title, start_date, end_date, status, created_at, updated_at)
            VALUES (?, ?, ?, '2026-08-01', '2026-08-05', ?, ?, ?)`,
      args: [row.id, row.projectId, row.id, row.status, row.createdAt, row.createdAt],
    });
  }

  it("(project_id, status) ごとに created_at 順で 0..n-1 が振られる", async () => {
    await applyMigrationsBeforeBoardOrder();

    await handle.client.execute({
      sql: "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
      args: ["p1", "PJ1"],
    });
    await handle.client.execute({
      sql: "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
      args: ["p2", "PJ2"],
    });

    // p1/todo に3件（作成順を意図的にバラす）、p1/done に1件、p2/todo に2件
    await insertTaskBefore0003({ id: "a", projectId: "p1", status: "todo", createdAt: 300 });
    await insertTaskBefore0003({ id: "b", projectId: "p1", status: "todo", createdAt: 100 });
    await insertTaskBefore0003({ id: "c", projectId: "p1", status: "todo", createdAt: 200 });
    await insertTaskBefore0003({ id: "d", projectId: "p1", status: "done", createdAt: 150 });
    await insertTaskBefore0003({ id: "e", projectId: "p2", status: "todo", createdAt: 400 });
    await insertTaskBefore0003({ id: "f", projectId: "p2", status: "todo", createdAt: 500 });

    await applyBoardOrderMigration();

    const result = await handle.client.execute(
      "SELECT id, project_id, status, board_order FROM tasks ORDER BY project_id, status, board_order",
    );
    expect(
      result.rows.map((row) => `${row.project_id}/${row.status}/${row.board_order}:${row.id}`),
    ).toEqual([
      "p1/done/0:d",
      "p1/todo/0:b", // created_at 100
      "p1/todo/1:c", // created_at 200
      "p1/todo/2:a", // created_at 300
      "p2/todo/0:e",
      "p2/todo/1:f",
    ]);
  });

  it("created_at が同値でも id をタイブレークにして重複しない（決定的な結果になる）", async () => {
    await applyMigrationsBeforeBoardOrder();

    await handle.client.execute({
      sql: "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
      args: ["p1", "PJ1"],
    });

    // 同一 created_at。シード投入や一括作成では実際に起こりうる。
    await insertTaskBefore0003({ id: "z", projectId: "p1", status: "todo", createdAt: 100 });
    await insertTaskBefore0003({ id: "x", projectId: "p1", status: "todo", createdAt: 100 });
    await insertTaskBefore0003({ id: "y", projectId: "p1", status: "todo", createdAt: 100 });

    await applyBoardOrderMigration();

    const result = await handle.client.execute(
      "SELECT id, board_order FROM tasks ORDER BY board_order",
    );
    // id の昇順（x < y < z）で 0,1,2 になる。重複が出ないことが要点。
    expect(result.rows.map((row) => `${row.board_order}:${row.id}`)).toEqual(["0:x", "1:y", "2:z"]);
  });

  it("論理削除済みのタスクも採番対象に含む（復元時に順序が壊れないため）", async () => {
    await applyMigrationsBeforeBoardOrder();

    await handle.client.execute({
      sql: "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
      args: ["p1", "PJ1"],
    });
    await insertTaskBefore0003({ id: "alive1", projectId: "p1", status: "todo", createdAt: 100 });
    await insertTaskBefore0003({ id: "deleted", projectId: "p1", status: "todo", createdAt: 200 });
    await insertTaskBefore0003({ id: "alive2", projectId: "p1", status: "todo", createdAt: 300 });
    await handle.client.execute("UPDATE tasks SET deleted_at = 999 WHERE id = 'deleted'");

    await applyBoardOrderMigration();

    const result = await handle.client.execute(
      "SELECT id, board_order FROM tasks ORDER BY board_order",
    );
    expect(result.rows.map((row) => `${row.board_order}:${row.id}`)).toEqual([
      "0:alive1",
      "1:deleted",
      "2:alive2",
    ]);
  });

  it("まっさらな DB でも全マイグレーションが通り、board_order の既定値は 0 になる", async () => {
    await migrate(handle.db, { migrationsFolder: "./drizzle" });

    await handle.client.execute({
      sql: "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
      args: ["p1", "PJ1"],
    });
    await handle.client.execute({
      sql: `INSERT INTO tasks (id, project_id, title, start_date, end_date)
            VALUES ('t1', 'p1', 'T', '2026-08-01', '2026-08-05')`,
    });

    const result = await handle.client.execute("SELECT board_order FROM tasks WHERE id = 't1'");
    expect(result.rows[0]?.board_order).toBe(0);
  });
});
