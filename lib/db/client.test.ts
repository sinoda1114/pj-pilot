import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, enableForeignKeysForLocalDev, type DbHandle } from "./client";
import { projects, tasks } from "./schema";

/**
 * DB 接続層・スキーマ・マイグレーションの結合テスト（M1 #8, #9）。
 * ローカルのファイル DB に対して実際にマイグレーションを走らせ、
 * PRAGMA foreign_keys=ON が効くことと、決定 D-06/§4.4 のとおり
 * ON DELETE CASCADE を宣言していない（＝関連行が残ったままの親を
 * 消そうとすると外部キー制約違反になる）ことを確認する。
 */

let dir: string;
let handle: DbHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pj-pilot-db-test-"));
  handle = createDb(`file:${join(dir, "test.db")}`);
  await enableForeignKeysForLocalDev(handle.client);
  await migrate(handle.db, { migrationsFolder: "./drizzle" });
});

afterEach(() => {
  // close() が例外を投げても一時ディレクトリの削除は必ず行う
  // （テストごとに tmpdir が積み残ると CI のディスクを圧迫するため）。
  try {
    handle.client.close();
  } finally {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("db schema migration", () => {
  it("マイグレーション後にプロジェクトを作成できる", async () => {
    const [created] = await handle.db.insert(projects).values({ name: "テストPJ" }).returning();

    expect(created?.name).toBe("テストPJ");
    expect(created?.dependencySyncEnabled).toBe(true);
    expect(created?.deletedAt).toBeNull();
  });

  it("タスクの日付は date-only 文字列としてそのまま保存・取得できる", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();

    const [created] = await handle.db
      .insert(tasks)
      .values({
        projectId: project!.id,
        title: "タスクA",
        startDate: "2026-08-03",
        endDate: "2026-08-05",
      })
      .returning();

    expect(created?.startDate).toBe("2026-08-03");
    expect(created?.endDate).toBe("2026-08-05");
    expect(created?.priority).toBe("medium");
    expect(created?.status).toBe("todo");
    expect(created?.type).toBe("task");
  });

  it("PRAGMA foreign_keys=ON が効いており、子タスクが残るプロジェクトは削除できない（決定 D-06/§4.4）", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    await handle.db.insert(tasks).values({
      projectId: project!.id,
      title: "子タスク",
      startDate: "2026-08-03",
      endDate: "2026-08-05",
    });

    // ON DELETE CASCADE を宣言していないため、外部キー制約違反で拒否されるはず。
    // アプリ層で明示的に子を先に削除する設計（§4.4）を、DB レベルでも裏付ける。
    // メッセージまで確認するのは、無関係なエラー（SQL誤字等）で誤って
    // テストが通ってしまうのを防ぐため。
    await expect(
      handle.client.execute({ sql: "DELETE FROM projects WHERE id = ?", args: [project!.id] }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("親タスクの id 重複や必須カラム欠落は挿入時に拒否される", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();

    await expect(
      handle.client.execute({
        sql: "INSERT INTO tasks (id, project_id, title, start_date) VALUES (?, ?, ?, ?)",
        args: ["t1", project!.id, "終了日なしタスク", "2026-08-03"],
      }),
    ).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("priority/status/type は CHECK 制約により無効な値を拒否する（enum は TS 型のみで SQL 制約にならないため）", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();

    await expect(
      handle.client.execute({
        sql: "INSERT INTO tasks (id, project_id, title, start_date, end_date, priority) VALUES (?, ?, ?, ?, ?, ?)",
        args: ["t1", project!.id, "不正な優先度", "2026-08-03", "2026-08-05", "urgent2"],
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("progress は 0-100 の範囲外を CHECK 制約で拒否する", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();

    await expect(
      handle.client.execute({
        sql: "INSERT INTO tasks (id, project_id, title, start_date, end_date, progress) VALUES (?, ?, ?, ?, ?, ?)",
        args: ["t1", project!.id, "進捗異常", "2026-08-03", "2026-08-05", 150],
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("estimated_hours / actual_hours の負値を CHECK 制約で拒否する", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();

    await expect(
      handle.client.execute({
        sql: "INSERT INTO tasks (id, project_id, title, start_date, end_date, estimated_hours) VALUES (?, ?, ?, ?, ?, ?)",
        args: ["t1", project!.id, "工数異常", "2026-08-03", "2026-08-05", -5],
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("タスクが自分自身を親にすることを CHECK 制約で拒否する", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();

    await expect(
      handle.client.execute({
        sql: "INSERT INTO tasks (id, project_id, parent_id, title, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)",
        args: ["t1", project!.id, "t1", "自己参照", "2026-08-03", "2026-08-05"],
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("依存が自分自身を先行タスクにすることを CHECK 制約で拒否する", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    const [task] = await handle.db
      .insert(tasks)
      .values({
        projectId: project!.id,
        title: "T",
        startDate: "2026-08-03",
        endDate: "2026-08-05",
      })
      .returning();

    await expect(
      handle.client.execute({
        sql: "INSERT INTO task_dependencies (id, project_id, predecessor_id, successor_id) VALUES (?, ?, ?, ?)",
        args: ["d1", project!.id, task!.id, task!.id],
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("updated_at は UPDATE 時に自動で更新される（$onUpdate。Devin レビュー指摘）", async () => {
    // INSERT 時の updated_at は SQLite 側の unixepoch()（実時刻）で決まるため、
    // フェイクタイマーは UPDATE（$onUpdate は JS の Date を使う）の後にだけ適用し、
    // 確実に「未来」になる時刻へ進める。
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
      const [updated] = await handle.db
        .update(projects)
        .set({ name: "P2" })
        .where(eq(projects.id, project!.id))
        .returning();

      expect(updated?.name).toBe("P2");
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(project!.updatedAt.getTime());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createDb: 本番での接続先未設定ガード（Devin レビュー指摘）", () => {
  const originalVercel = process.env.VERCEL;
  const originalTursoUrl = process.env.TURSO_DATABASE_URL;

  afterEach(() => {
    if (originalVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = originalVercel;
    }
    if (originalTursoUrl === undefined) {
      delete process.env.TURSO_DATABASE_URL;
    } else {
      process.env.TURSO_DATABASE_URL = originalTursoUrl;
    }
  });

  it("Vercel 上で TURSO_DATABASE_URL が無いと例外を投げる", () => {
    process.env.VERCEL = "1";
    delete process.env.TURSO_DATABASE_URL;

    expect(() => createDb()).toThrow(/TURSO_DATABASE_URL/);
  });

  it("Vercel 上でも url を明示的に渡せば例外にならない", () => {
    process.env.VERCEL = "1";
    delete process.env.TURSO_DATABASE_URL;

    const { client } = createDb(":memory:");
    client.close();
  });
});
