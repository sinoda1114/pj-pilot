import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_BUSY_TIMEOUT_MS,
  createDb,
  enableForeignKeysForLocalDev,
  type DbHandle,
} from "./client";
import { projectMembers, projects, tasks, user } from "./schema";

/** ロック保持プロセスが書き込みロックを握っている時間。busy timeout より十分短くする。 */
const HOLD_MS = 300;

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

  it("project_members.userId は存在しないユーザーIDへの参照を外部キー制約で拒否する（フォローアップ課題）", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();

    await expect(
      handle.client.execute({
        sql: "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)",
        args: [project!.id, "no-such-user", "owner"],
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    const [created] = await handle.db
      .insert(user)
      .values({ id: "u1", name: "U", email: "u1@example.com" })
      .returning();

    const [member] = await handle.db
      .insert(projectMembers)
      .values({ projectId: project!.id, userId: created!.id, role: "owner" })
      .returning();

    expect(member?.userId).toBe("u1");
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

describe("createDb: ローカル/テストの busy timeout（E2Eの SQLITE_BUSY 対策）", () => {
  /**
   * Playwright のテストプロセスと Next.js サーバープロセスが同じ `file:local.db` に
   * 書き込むため、SQLite の busy timeout（既定 0 = 即エラー）のままだと
   * `SQLITE_BUSY: database is locked` で CI が非決定的に落ちる。
   * `playwright.config.ts` の `workers: 1` はスペック間の並列を止めるだけで、
   * プロセス間の競合には効かない。
   */
  it("ローカルのファイル DB では busy_timeout が設定される", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pj-pilot-busy-test-"));
    const { client } = createDb(`file:${join(dir, "t.db")}`);
    try {
      const result = await client.execute("PRAGMA busy_timeout");
      expect(Number(result.rows[0]?.timeout)).toBe(LOCAL_BUSY_TIMEOUT_MS);
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("別プロセスが書き込みロックを保持していても、解放を待って書き込める", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pj-pilot-busy-e2e-test-"));
    const dbPath = join(dir, "t.db");
    const url = `file:${dbPath}`;

    const setup = createDb(url);
    await setup.client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    setup.client.close();

    // 別プロセスで BEGIN IMMEDIATE を張り、HOLD_MS 後に解放する。
    // 同一プロセスの2接続では、同期ドライバが待機中にイベントループを止めてしまい
    // 解放側の COMMIT が走れないため、この競合は再現できない（実測で確認済み）。
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createClient } from "@libsql/client";
         const c = createClient({ url: ${JSON.stringify(url)} });
         await c.execute("BEGIN IMMEDIATE");
         await c.execute("INSERT INTO t (v) VALUES ('holder')");
         console.log("LOCKED");
         await new Promise((r) => setTimeout(r, ${HOLD_MS}));
         await c.execute("COMMIT");
         c.close();`,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );

    const holderExited = new Promise<void>((resolve) => holder.on("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("LOCKED")) {
            resolve();
          }
        });
        holder.on("exit", (code) =>
          reject(new Error(`ロック保持プロセスが早期終了しました: ${code}`)),
        );
      });

      const writer = createDb(url);
      try {
        // busy_timeout が無いと、ここが 1ms ほどで SQLITE_BUSY を投げる（実測）。
        await writer.client.execute("INSERT INTO t (v) VALUES ('writer')");
        const rows = await writer.client.execute("SELECT v FROM t ORDER BY id");
        expect(rows.rows.map((row) => row.v)).toEqual(["holder", "writer"]);
      } finally {
        writer.client.close();
      }
    } finally {
      await holderExited;
      rmSync(dir, { recursive: true, force: true });
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
