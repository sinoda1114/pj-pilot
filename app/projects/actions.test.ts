/**
 * プロジェクト一覧画面の Server Actions のテスト（M2 #13 / M5 #29）。
 *
 * 既存の `app/projects/[id]/tasks/actions.test.ts` と同じ「db シングルトン +
 * getSession() を vi.mock で差し替える」パターンを使う。作成/削除の正常系は
 * e2e（`e2e/project-crud.spec.ts`）でもカバーしているが、Server Action は
 * 直接呼び出し可能な公開エンドポイントであり、e2e のフォーム経由では通らない
 *
 *   - 入力の正規化（trim）と長さ上限の拒否
 *   - 型注釈だけでは守れないランタイム型検証（`dependencySyncEnabled`）
 *   - 認可の拒否（未ログイン / owner でないユーザーによる削除）
 *   - ドメインエラーの `{ ok:false, message }` 変換と、未知のエラーの再 throw
 *
 * といった分岐をここで単体テストする。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../../lib/db/client";
import { projectMembers, projects } from "../../lib/db/schema";
import { insertTestUsers } from "../../lib/db/testHelpers";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "../../lib/projects/constants";
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

const { createProjectAction, updateProjectAction, deleteProjectAction, restoreProjectAction } =
  await import("./actions");

const SESSION: AuthSession = { userId: "u1" };
/** owner ではない別ユーザー。削除が owner 限定であること（決定 D-15）の検証に使う。 */
const OTHER_SESSION: AuthSession = { userId: "u2" };

describe("app/projects/actions", () => {
  let dir: string;
  let handle: DbHandle;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-projects-actions-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    // createProject は project_members にも INSERT する。userId は user.id への
    // 外部キーを持つため、対応する user 行を先に用意しておく（lib/db/testHelpers.ts）。
    await insertTestUsers(handle.db, [SESSION.userId, OTHER_SESSION.userId]);
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

  /** テスト対象の Server Action を通さず、直接 DB に PJ を1件用意する。 */
  async function insertProject(values: Partial<typeof projects.$inferInsert> = {}) {
    const [project] = await handle.db
      .insert(projects)
      .values({ name: "テスト用PJ", ...values })
      .returning();
    if (!project) {
      throw new Error("Failed to create test project");
    }
    return project;
  }

  async function findProject(projectId: string) {
    const [project] = await handle.db.select().from(projects).where(eq(projects.id, projectId));
    return project;
  }

  describe("createProjectAction", () => {
    it("名前が空文字・空白のみなら、DB に触れずに ok:false を返す（必須入力の担保）", async () => {
      state.session = SESSION;
      const before = await handle.db.select().from(projects);

      const result = await createProjectAction({ name: "   " });

      expect(result).toEqual({ ok: false, message: "プロジェクト名を入力してください" });
      const after = await handle.db.select().from(projects);
      expect(after).toHaveLength(before.length);
    });

    it("名前が上限ちょうど（200文字）なら作成でき、1文字超えると拒否される（境界値）", async () => {
      state.session = SESSION;

      const okResult = await createProjectAction({ name: "あ".repeat(PROJECT_NAME_MAX_LENGTH) });
      expect(okResult).toEqual({ ok: true });

      const ngResult = await createProjectAction({
        name: "あ".repeat(PROJECT_NAME_MAX_LENGTH + 1),
      });
      expect(ngResult).toEqual({
        ok: false,
        message: `プロジェクト名は${PROJECT_NAME_MAX_LENGTH}文字以内で入力してください`,
      });
    });

    it("説明が上限ちょうど（2000文字）なら作成でき、1文字超えると拒否される（境界値）", async () => {
      state.session = SESSION;

      const okResult = await createProjectAction({
        name: "説明の境界値",
        description: "あ".repeat(PROJECT_DESCRIPTION_MAX_LENGTH),
      });
      expect(okResult).toEqual({ ok: true });

      const ngResult = await createProjectAction({
        name: "説明の境界値",
        description: "あ".repeat(PROJECT_DESCRIPTION_MAX_LENGTH + 1),
      });
      expect(ngResult).toEqual({
        ok: false,
        message: `説明は${PROJECT_DESCRIPTION_MAX_LENGTH}文字以内で入力してください`,
      });
    });

    it("名前・説明の前後の空白は落として保存する", async () => {
      state.session = SESSION;

      const result = await createProjectAction({ name: "  空白付きPJ  ", description: "  説明  " });

      expect(result).toEqual({ ok: true });
      const [created] = await handle.db
        .select()
        .from(projects)
        .where(eq(projects.name, "空白付きPJ"));
      expect(created?.description).toBe("説明");
    });

    it("説明が空白のみなら null として保存する（空文字が残らない）", async () => {
      state.session = SESSION;

      const result = await createProjectAction({ name: "説明が空白のPJ", description: "   " });

      expect(result).toEqual({ ok: true });
      const [created] = await handle.db
        .select()
        .from(projects)
        .where(eq(projects.name, "説明が空白のPJ"));
      expect(created?.description).toBeNull();
    });

    it("作成者は role='owner' として project_members に登録される（削除権限の起点）", async () => {
      state.session = SESSION;

      const result = await createProjectAction({ name: "owner登録の確認" });

      expect(result).toEqual({ ok: true });
      const [created] = await handle.db
        .select()
        .from(projects)
        .where(eq(projects.name, "owner登録の確認"));
      if (!created) {
        throw new Error("Failed to find created project");
      }
      const members = await handle.db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.projectId, created.id));
      expect(members).toEqual([{ projectId: created.id, userId: SESSION.userId, role: "owner" }]);
    });

    it("未ログインなら ok:false を返し、PJ を作成しない", async () => {
      state.session = null;
      const before = await handle.db.select().from(projects);

      const result = await createProjectAction({ name: "未ログインで作成" });

      expect(result).toEqual({ ok: false, message: "ログインが必要です" });
      const after = await handle.db.select().from(projects);
      expect(after).toHaveLength(before.length);
    });

    it("既知のドメインエラー以外は握り潰さず再 throw する（障害を ok:false で隠さない）", async () => {
      // user 行が存在しない userId のセッション。createProject の
      // project_members INSERT が外部キー違反になり、ドメインエラーではない
      // 未知の例外（LibsqlError）が飛ぶ。toActionResult はこれを再 throw する。
      state.session = { userId: "存在しないユーザー" };

      await expect(createProjectAction({ name: "FK違反で失敗するPJ" })).rejects.toThrow();

      // createProject はトランザクションなので、projects への INSERT も巻き戻る。
      const rows = await handle.db
        .select()
        .from(projects)
        .where(eq(projects.name, "FK違反で失敗するPJ"));
      expect(rows).toEqual([]);
    });
  });

  describe("updateProjectAction", () => {
    it("M5 #29: dependencySyncEnabledをfalseに更新できる", async () => {
      state.session = SESSION;
      const project = await insertProject({ name: "設定確認用" });

      const result = await updateProjectAction(project.id, { dependencySyncEnabled: false });

      expect(result).toEqual({ ok: true });
      expect((await findProject(project.id))?.dependencySyncEnabled).toBe(false);
    });

    it("M5 #29: dependencySyncEnabledに真偽値以外を渡すと失敗し、DBを変更しない（Server Actionは直接呼び出し可能なため）", async () => {
      state.session = SESSION;
      const project = await insertProject({ name: "検証確認用" });

      const maliciousInput = { dependencySyncEnabled: "yes" } as unknown as Parameters<
        typeof updateProjectAction
      >[1];
      const result = await updateProjectAction(project.id, maliciousInput);

      expect(result).toEqual({ ok: false, message: "依存連動の指定が不正です" });
      expect((await findProject(project.id))?.dependencySyncEnabled).toBe(true);
    });

    it("名前を空白のみに書き換えようとすると拒否し、既存の名前を保つ", async () => {
      state.session = SESSION;
      const project = await insertProject({ name: "元の名前" });

      const result = await updateProjectAction(project.id, { name: "  " });

      expect(result).toEqual({ ok: false, message: "プロジェクト名を入力してください" });
      expect((await findProject(project.id))?.name).toBe("元の名前");
    });

    it("名前が上限（200文字）を超えると拒否し、既存の名前を保つ（境界値）", async () => {
      state.session = SESSION;
      const project = await insertProject({ name: "元の名前" });

      const result = await updateProjectAction(project.id, {
        name: "あ".repeat(PROJECT_NAME_MAX_LENGTH + 1),
      });

      expect(result).toEqual({
        ok: false,
        message: `プロジェクト名は${PROJECT_NAME_MAX_LENGTH}文字以内で入力してください`,
      });
      expect((await findProject(project.id))?.name).toBe("元の名前");
    });

    it("説明が上限（2000文字）を超えると拒否し、既存の説明を保つ（境界値）", async () => {
      state.session = SESSION;
      const project = await insertProject({ name: "説明更新", description: "元の説明" });

      const result = await updateProjectAction(project.id, {
        description: "あ".repeat(PROJECT_DESCRIPTION_MAX_LENGTH + 1),
      });

      expect(result).toEqual({
        ok: false,
        message: `説明は${PROJECT_DESCRIPTION_MAX_LENGTH}文字以内で入力してください`,
      });
      expect((await findProject(project.id))?.description).toBe("元の説明");
    });

    it("名前と説明を更新でき、前後の空白は落とす", async () => {
      state.session = SESSION;
      const project = await insertProject({ name: "更新前", description: "更新前の説明" });

      const result = await updateProjectAction(project.id, {
        name: "  更新後  ",
        description: "  更新後の説明  ",
      });

      expect(result).toEqual({ ok: true });
      const updated = await findProject(project.id);
      expect(updated?.name).toBe("更新後");
      expect(updated?.description).toBe("更新後の説明");
    });

    it.each([
      ["null", null],
      ["空白のみ", "   "],
    ])("説明に %s を渡すと null に戻せる（説明のクリア）", async (_label, description) => {
      state.session = SESSION;
      const project = await insertProject({ name: "説明クリア", description: "消される説明" });

      const result = await updateProjectAction(project.id, { description });

      expect(result).toEqual({ ok: true });
      expect((await findProject(project.id))?.description).toBeNull();
    });

    it("存在しないPJの更新は ok:false を返す", async () => {
      state.session = SESSION;

      const result = await updateProjectAction("nonexistent-project", { name: "x" });

      expect(result).toEqual({ ok: false, message: "プロジェクトが見つかりません" });
    });

    it("未ログインなら ok:false を返し、PJ を変更しない", async () => {
      state.session = null;
      const project = await insertProject({ name: "未ログインでは変わらない" });

      const result = await updateProjectAction(project.id, { name: "変更後" });

      expect(result).toEqual({ ok: false, message: "ログインが必要です" });
      expect((await findProject(project.id))?.name).toBe("未ログインでは変わらない");
    });
  });

  describe("deleteProjectAction", () => {
    it("決定 D-15: owner は削除できる（論理削除）", async () => {
      state.session = SESSION;
      const createResult = await createProjectAction({ name: "owner が削除するPJ" });
      expect(createResult).toEqual({ ok: true });
      const [project] = await handle.db
        .select()
        .from(projects)
        .where(eq(projects.name, "owner が削除するPJ"));
      if (!project) {
        throw new Error("Failed to find created project");
      }

      const result = await deleteProjectAction(project.id);

      expect(result).toEqual({ ok: true });
      expect((await findProject(project.id))?.deletedAt).not.toBeNull();
    });

    it("決定 D-15: owner でないユーザーの削除は ok:false で拒否され、PJ は残る", async () => {
      state.session = SESSION;
      const createResult = await createProjectAction({ name: "他人は消せないPJ" });
      expect(createResult).toEqual({ ok: true });
      const [project] = await handle.db
        .select()
        .from(projects)
        .where(eq(projects.name, "他人は消せないPJ"));
      if (!project) {
        throw new Error("Failed to find created project");
      }

      state.session = OTHER_SESSION;
      const result = await deleteProjectAction(project.id);

      expect(result).toEqual({ ok: false, message: "この操作を行う権限がありません" });
      expect((await findProject(project.id))?.deletedAt).toBeNull();
    });

    it("存在しないPJの削除は ok:false を返す", async () => {
      state.session = SESSION;

      const result = await deleteProjectAction("nonexistent-project");

      expect(result).toEqual({ ok: false, message: "プロジェクトが見つかりません" });
    });

    it("未ログインなら ok:false を返し、PJ を削除しない", async () => {
      state.session = null;
      const project = await insertProject({ name: "未ログインでは消えない" });

      const result = await deleteProjectAction(project.id);

      expect(result).toEqual({ ok: false, message: "ログインが必要です" });
      expect((await findProject(project.id))?.deletedAt).toBeNull();
    });
  });
  /**
   * 公開前セキュリティ監査の指摘（未認証で 500）に対する回帰テスト。
   *
   * 以前はこのファイルだけ `input` を型注釈のまま信頼し、`input.name.trim()` を
   * `getSession()` **より前**・`try` の外で呼んでいた。そのため未ログインの相手でも
   * 型を詐称した JSON を1回 POST するだけで未捕捉の `TypeError` を起こせ、
   * `{ok:false}` にならず 500 になっていた。
   */
  describe("ランタイム入力検証（Server Action は公開エンドポイント）", () => {
    it.each([
      ["null", null],
      ["数値の name", { name: 1 }],
      ["配列の name", { name: [] }],
      ["数値の description", { name: "x", description: 1 }],
      ["文字列そのもの", "name=x"],
    ])("未ログイン + %s でも throw せず ok:false を返す", async (_label, input) => {
      state.session = null;

      const result = await createProjectAction(input);

      expect(result.ok).toBe(false);
    });

    it.each([
      ["オブジェクト", {}],
      ["配列", ["x"]],
      ["数値", 1],
      ["null", null],
    ])("projectId が %s でも throw せず ok:false を返す", async (_label, projectId) => {
      state.session = SESSION;

      await expect(updateProjectAction(projectId, { name: "x" })).resolves.toMatchObject({
        ok: false,
      });
      await expect(deleteProjectAction(projectId)).resolves.toMatchObject({ ok: false });
    });

    it("PJ 名に NUL を含むと拒否する（trim をすり抜けて空名になるのを防ぐ）", async () => {
      state.session = SESSION;

      const result = await createProjectAction({ name: "\u0000" });

      expect(result.ok).toBe(false);
      const rows = await handle.db.select().from(projects);
      expect(rows.some((row) => row.name === "")).toBe(false);
    });

    it("未ログインなら PJ を作成しない", async () => {
      state.session = null;

      const result = await createProjectAction({ name: "未ログインでは作れない" });

      expect(result).toEqual({ ok: false, message: "ログインが必要です" });
      const rows = await handle.db.select().from(projects);
      expect(rows.some((row) => row.name === "未ログインでは作れない")).toBe(false);
    });
  });
  /** Issue #65: 削除済み PJ の復元。決定 D-15 に合わせて owner 限定。 */
  describe("restoreProjectAction", () => {
    it("owner なら復元でき、一覧に戻る", async () => {
      state.session = SESSION;
      const project = await insertProject({ name: "戻したい" });
      // `insertProject` は project_members を作らない（素の insert）。
      // 復元は owner 限定なので、ここで owner を明示的に登録する。
      await handle.db
        .insert(projectMembers)
        .values({ projectId: project.id, userId: SESSION.userId, role: "owner" });
      await handle.db
        .update(projects)
        .set({ deletedAt: new Date() })
        .where(eq(projects.id, project.id));

      const result = await restoreProjectAction(project.id);

      expect(result).toEqual({ ok: true });
      expect((await findProject(project.id))?.deletedAt).toBeNull();
    });

    it("owner でないユーザーは復元できず、削除済みのまま残る", async () => {
      state.session = SESSION;
      const project = await insertProject({ name: "他人のPJ" });
      await handle.db
        .insert(projectMembers)
        .values({ projectId: project.id, userId: SESSION.userId, role: "owner" });
      await handle.db
        .update(projects)
        .set({ deletedAt: new Date() })
        .where(eq(projects.id, project.id));

      state.session = OTHER_SESSION;
      const result = await restoreProjectAction(project.id);

      expect(result).toEqual({ ok: false, message: "この操作を行う権限がありません" });
      expect((await findProject(project.id))?.deletedAt).not.toBeNull();
    });

    it("未ログインなら ok:false を返す", async () => {
      state.session = null;

      const result = await restoreProjectAction("some-project-id");

      expect(result).toEqual({ ok: false, message: "ログインが必要です" });
    });

    it("生存中の PJ には ok:false を返す", async () => {
      state.session = SESSION;
      const project = await insertProject({ name: "生きている" });

      const result = await restoreProjectAction(project.id);

      expect(result.ok).toBe(false);
    });

    it.each([
      ["オブジェクト", {}],
      ["配列", ["x"]],
      ["数値", 1],
      ["null", null],
    ])("projectId が %s でも throw せず ok:false を返す", async (_label, projectId) => {
      state.session = SESSION;

      await expect(restoreProjectAction(projectId)).resolves.toMatchObject({ ok: false });
    });
  });
});
