/**
 * プロジェクト一覧画面の Server Actions のテスト（M2 #13 / M5 #29）。
 *
 * 既存の `app/projects/[id]/tasks/actions.test.ts` と同じ「db シングルトン +
 * getSession() を vi.mock で差し替える」パターンを使う。これまで作成/削除は
 * e2e（`e2e/project-crud.spec.ts`）でカバーしていたが、M5 #29 で追加した
 * `dependencySyncEnabled` のランタイム型検証（Server Actionは直接呼び出し可能な
 * 公開エンドポイントであり、TypeScriptの型注釈は実行時には効かないため）は
 * ここで単体テストする。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../../lib/db/client";
import { projects } from "../../lib/db/schema";
import type { AuthSession } from "../../lib/auth/types";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  session: null as AuthSession | null,
}));

vi.mock("../../lib/db", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("../../lib/auth/session", () => ({
  getSession: async () => state.session,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { updateProjectAction } = await import("./actions");

const SESSION: AuthSession = { userId: "u1" };

describe("app/projects/actions", () => {
  let dir: string;
  let handle: DbHandle;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-projects-actions-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    state.db = handle.db;
  });

  afterAll(() => {
    try {
      handle.client.close();
    } finally {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  afterEach(() => {
    state.session = null;
  });

  describe("updateProjectAction", () => {
    it("M5 #29: dependencySyncEnabledをfalseに更新できる", async () => {
      state.session = SESSION;
      const [project] = await handle.db
        .insert(projects)
        .values({ name: "設定確認用" })
        .returning();
      if (!project) {
        throw new Error("Failed to create test project");
      }

      const result = await updateProjectAction(project.id, { dependencySyncEnabled: false });

      expect(result).toEqual({ ok: true });
      const [updated] = await handle.db.select().from(projects).where(eq(projects.id, project.id));
      expect(updated?.dependencySyncEnabled).toBe(false);
    });

    it("M5 #29: dependencySyncEnabledに真偽値以外を渡すと失敗し、DBを変更しない（Server Actionは直接呼び出し可能なため）", async () => {
      state.session = SESSION;
      const [project] = await handle.db
        .insert(projects)
        .values({ name: "検証確認用" })
        .returning();
      if (!project) {
        throw new Error("Failed to create test project");
      }

      const maliciousInput = { dependencySyncEnabled: "yes" } as unknown as Parameters<
        typeof updateProjectAction
      >[1];
      const result = await updateProjectAction(project.id, maliciousInput);

      expect(result).toEqual({ ok: false, message: "依存連動の指定が不正です" });
      const [unchanged] = await handle.db.select().from(projects).where(eq(projects.id, project.id));
      expect(unchanged?.dependencySyncEnabled).toBe(true);
    });
  });
});
