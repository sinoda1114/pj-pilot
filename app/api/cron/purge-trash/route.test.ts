import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../../../../lib/db/client";
import { projects, tasks } from "../../../../lib/db/schema";

// `GET`/`POST` は `lib/db` の DB シングルトン（環境変数から接続先を決める）を
// 直接使うため、テスト用の一時ファイル DB に差し替える
// （`app/projects/[id]/tasks/actions.test.ts` と同じ vi.mock パターン）。
const state = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("../../../../lib/db", () => ({
  get db() {
    return state.db;
  },
}));

const { GET, POST, handlePurgeTrashRequest } = await import("./route");

const DAY_MS = 24 * 60 * 60 * 1000;

describe("/api/cron/purge-trash", () => {
  let dir: string;
  let handle: DbHandle;
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-purge-route-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    state.db = handle.db;
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    vi.useRealTimers();
    try {
      handle.client.close();
    } finally {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("CRON_SECRET が未設定なら、正しいヘッダーの有無に関わらず 500 を返す（fail-closed）", async () => {
    delete process.env.CRON_SECRET;
    const request = new Request("http://localhost/api/cron/purge-trash", {
      headers: { authorization: "Bearer anything" },
    });

    const response = await handlePurgeTrashRequest(request, handle.db);

    expect(response.status).toBe(500);
  });

  it("Authorization ヘッダーが無ければ 401 を返す", async () => {
    process.env.CRON_SECRET = "test-secret";
    const request = new Request("http://localhost/api/cron/purge-trash");

    const response = await handlePurgeTrashRequest(request, handle.db);

    expect(response.status).toBe(401);
  });

  it("Authorization ヘッダーの値が誤っていれば 401 を返す", async () => {
    process.env.CRON_SECRET = "test-secret";
    const request = new Request("http://localhost/api/cron/purge-trash", {
      headers: { authorization: "Bearer wrong-secret" },
    });

    const response = await handlePurgeTrashRequest(request, handle.db);

    expect(response.status).toBe(401);
  });

  it("正しい Authorization ヘッダーなら 200 を返し、30日超の削除済みタスクを物理削除する", async () => {
    process.env.CRON_SECRET = "test-secret";

    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    if (!project) {
      throw new Error("Failed to create test project");
    }
    const [expiredTask] = await handle.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "期限切れタスク",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        deletedAt: new Date(Date.now() - 31 * DAY_MS),
      })
      .returning();
    if (!expiredTask) {
      throw new Error("Failed to create test task");
    }

    const request = new Request("http://localhost/api/cron/purge-trash", {
      headers: { authorization: "Bearer test-secret" },
    });

    const response = await handlePurgeTrashRequest(request, handle.db);
    const body = (await response.json()) as { purgedTaskCount: number };

    expect(response.status).toBe(200);
    expect(body.purgedTaskCount).toBe(1);

    const remaining = await handle.db.select().from(tasks);
    expect(remaining.map((t) => t.id)).not.toContain(expiredTask.id);
  });

  /**
   * `GET`/`POST` は「DB シングルトンを渡して `handlePurgeTrashRequest` を呼ぶ」だけの
   * 薄い層だが、Vercel Cron が実際に叩くのはこちら。引数の渡し忘れ（別 DB を見る）や
   * 片方のメソッドの実装漏れは本番でしか露見しないため、両メソッドを直接呼んで
   * 認証と物理削除が同じように効くことを確認する。
   */
  describe.each([
    ["GET", (request: Request) => GET(request)],
    ["POST", (request: Request) => POST(request)],
  ])("%s（Vercel Cron のエントリポイント）", (_method, invoke) => {
    it("認証に失敗すれば 401 を返す", async () => {
      process.env.CRON_SECRET = "test-secret";
      const request = new Request("http://localhost/api/cron/purge-trash", {
        headers: { authorization: "Bearer wrong-secret" },
      });

      const response = await invoke(request);

      expect(response.status).toBe(401);
    });

    it("認証に成功すれば 200 を返し、30日超の削除済みタスクを物理削除する", async () => {
      process.env.CRON_SECRET = "test-secret";
      const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
      if (!project) {
        throw new Error("Failed to create test project");
      }
      const [expiredTask] = await handle.db
        .insert(tasks)
        .values({
          projectId: project.id,
          title: "期限切れタスク",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          deletedAt: new Date(Date.now() - 31 * DAY_MS),
        })
        .returning();
      if (!expiredTask) {
        throw new Error("Failed to create test task");
      }

      const request = new Request("http://localhost/api/cron/purge-trash", {
        headers: { authorization: "Bearer test-secret" },
      });

      const response = await invoke(request);
      const body = (await response.json()) as { purgedTaskCount: number };

      expect(response.status).toBe(200);
      expect(body.purgedTaskCount).toBe(1);
      const remaining = await handle.db.select().from(tasks);
      expect(remaining.map((t) => t.id)).not.toContain(expiredTask.id);
    });
  });
});
