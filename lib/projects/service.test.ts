import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnauthorizedError, ForbiddenError } from "../auth/errors";
import { createDb, type DbHandle } from "../db/client";
import { projectMembers, projects, tasks } from "../db/schema";
import { insertTestUsers } from "../db/testHelpers";
import { NotFoundError } from "../errors";
import {
  createProject,
  deleteProject,
  listDeletedProjects,
  listProjects,
  restoreProject,
  updateProject,
} from "./service";

const OWNER = { userId: "owner-1" };
const OTHER_MEMBER = { userId: "other-1" };

describe("projects/service", () => {
  let dir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-projects-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    await insertTestUsers(handle.db, [OWNER.userId, OTHER_MEMBER.userId]);
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

  describe("createProject", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      await expect(createProject(handle.db, null, { name: "P" })).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it("作成者を role='owner' として project_members に登録する", async () => {
      const project = await createProject(handle.db, OWNER, {
        name: "新規PJ",
        description: "説明",
      });

      expect(project.name).toBe("新規PJ");
      expect(project.deletedAt).toBeNull();

      const members = await handle.db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.projectId, project.id));
      expect(members).toEqual([{ projectId: project.id, userId: OWNER.userId, role: "owner" }]);
    });

    it("トランザクション: 途中で失敗したら INSERT 済みの行もロールバックされる（Amazon Q レビュー指摘の検証）", async () => {
      // createProject 自体を壊さずに、使っている db.transaction の仕組みが
      // このテスト環境（file DB の @libsql/client）で実際にロールバックすることを検証する。
      await expect(
        handle.db.transaction(async (tx) => {
          await tx.insert(projects).values({ name: "ロールバックされるはず" });
          throw new Error("simulated failure");
        }),
      ).rejects.toThrow("simulated failure");

      const remaining = await handle.db.select().from(projects);
      expect(remaining).toEqual([]);
    });
  });

  describe("listProjects", () => {
    it("ログインしていなければ UnauthorizedError を投げる", async () => {
      await expect(listProjects(handle.db, null)).rejects.toThrow(UnauthorizedError);
    });

    it("決定 D-08: 所属していないPJも含め、全ての生存PJを返す", async () => {
      const p1 = await createProject(handle.db, OWNER, { name: "P1" });
      await createProject(handle.db, OTHER_MEMBER, { name: "P2" });

      const result = await listProjects(handle.db, OWNER);

      expect(result.map((p) => p.name).sort()).toEqual(["P1", "P2"]);
      expect(result.some((p) => p.id === p1.id)).toBe(true);
    });

    it("論理削除済みのPJは含めない", async () => {
      const project = await createProject(handle.db, OWNER, { name: "削除予定" });
      await deleteProject(handle.db, OWNER, project.id);

      const result = await listProjects(handle.db, OWNER);

      expect(result).toEqual([]);
    });
  });

  describe("updateProject", () => {
    it("決定 D-08/§6: owner でないメンバーでも編集できる（削除だけがownerのみ）", async () => {
      const project = await createProject(handle.db, OWNER, { name: "元の名前" });

      const updated = await updateProject(handle.db, OTHER_MEMBER, project.id, {
        name: "変更後の名前",
      });

      expect(updated.name).toBe("変更後の名前");
    });

    it("存在しないPJは NotFoundError を投げる", async () => {
      await expect(
        updateProject(handle.db, OWNER, "nonexistent-project", { name: "x" }),
      ).rejects.toThrow(NotFoundError);
    });

    it("更新項目が空でも例外にならず既存の状態をそのまま返す（Drizzle の 'No values to set' 対策）", async () => {
      const project = await createProject(handle.db, OWNER, { name: "変更なし" });

      const result = await updateProject(handle.db, OWNER, project.id, {});

      expect(result).toEqual(project);
    });

    it("全キーが undefined でも例外にならない（Amazon Q レビュー指摘: Object.keys だけでは検出できない）", async () => {
      const project = await createProject(handle.db, OWNER, { name: "変更なし" });

      const result = await updateProject(handle.db, OWNER, project.id, {
        name: undefined,
        description: undefined,
      });

      expect(result).toEqual(project);
    });

    it("一部が undefined でも、値が指定されたフィールドだけ更新する", async () => {
      const project = await createProject(handle.db, OWNER, {
        name: "元の名前",
        description: "元の説明",
      });

      const result = await updateProject(handle.db, OWNER, project.id, {
        name: "新しい名前",
        description: undefined,
      });

      expect(result.name).toBe("新しい名前");
      expect(result.description).toBe("元の説明");
    });

    it("説明だけを更新でき、名前は変わらない", async () => {
      const project = await createProject(handle.db, OWNER, {
        name: "元の名前",
        description: "元の説明",
      });

      const updated = await updateProject(handle.db, OWNER, project.id, {
        description: "新しい説明",
      });

      expect(updated.description).toBe("新しい説明");
      expect(updated.name).toBe("元の名前");
    });

    it("説明に null を渡すと説明をクリアできる（未指定の undefined とは区別する）", async () => {
      const project = await createProject(handle.db, OWNER, {
        name: "説明クリア",
        description: "消される説明",
      });

      const updated = await updateProject(handle.db, OWNER, project.id, { description: null });

      expect(updated.description).toBeNull();
      expect(updated.name).toBe("説明クリア");
    });

    it("dependencySyncEnabledを更新できる（M5 #29: 連動ON/OFFトグル）", async () => {
      const project = await createProject(handle.db, OWNER, { name: "連動設定確認用" });
      expect(project.dependencySyncEnabled).toBe(true);

      const updated = await updateProject(handle.db, OWNER, project.id, {
        dependencySyncEnabled: false,
      });

      expect(updated.dependencySyncEnabled).toBe(false);
    });

    it("論理削除済みのPJは NotFoundError を投げる", async () => {
      const project = await createProject(handle.db, OWNER, { name: "削除予定" });
      await deleteProject(handle.db, OWNER, project.id);

      await expect(updateProject(handle.db, OWNER, project.id, { name: "x" })).rejects.toThrow(
        NotFoundError,
      );
    });

    it("マスアサインメント対策: 型に無いキー（deletedAt/createdAt）が混入しても無視する（セキュリティレビュー指摘）", async () => {
      const project = await createProject(handle.db, OWNER, { name: "元の名前" });
      // UpdateProjectInput はコンパイル時の型でしかなく、将来 Server Action が
      // ランタイム検証を省略して生の入力をそのまま渡した場合を想定した攻撃シナリオ:
      // owner でないメンバーが deletedAt を smuggle して、owner 限定のはずの
      // 削除操作を updateProject 経由でバイパスしようとするケース。
      const maliciousInput = {
        name: "更新後の名前",
        deletedAt: new Date(),
        createdAt: new Date(0),
      } as unknown as Parameters<typeof updateProject>[3];

      const updated = await updateProject(handle.db, OTHER_MEMBER, project.id, maliciousInput);

      expect(updated.name).toBe("更新後の名前");
      expect(updated.deletedAt).toBeNull();
      expect(updated.createdAt.getTime()).toBe(project.createdAt.getTime());
    });
  });

  describe("deleteProject", () => {
    it("決定 D-15: role='owner' は削除できる（論理削除）", async () => {
      const project = await createProject(handle.db, OWNER, { name: "削除対象" });

      await deleteProject(handle.db, OWNER, project.id);

      const result = await listProjects(handle.db, OWNER);
      expect(result).toEqual([]);
    });

    it("決定 D-15: owner でないメンバーは ForbiddenError を投げる", async () => {
      const project = await createProject(handle.db, OWNER, { name: "P" });

      await expect(deleteProject(handle.db, OTHER_MEMBER, project.id)).rejects.toThrow(
        ForbiddenError,
      );
    });

    it("存在しないPJは NotFoundError を投げる", async () => {
      await expect(deleteProject(handle.db, OWNER, "nonexistent-project")).rejects.toThrow(
        NotFoundError,
      );
    });
  });
  /**
   * Issue #65: 論理削除した PJ を戻す手段が無く、30日後に配下タスクごと物理削除されていた。
   */
  describe("listDeletedProjects / restoreProject", () => {
    it("削除済みの PJ だけを一覧に返し、生存中の PJ は返さない", async () => {
      const alive = await createProject(handle.db, OWNER, { name: "生存中" });
      const deleted = await createProject(handle.db, OWNER, { name: "削除済み" });
      await deleteProject(handle.db, OWNER, deleted.id);

      const trash = await listDeletedProjects(handle.db, OWNER);

      expect(trash.map((p) => p.id)).toEqual([deleted.id]);
      expect((await listProjects(handle.db, OWNER)).map((p) => p.id)).toEqual([alive.id]);
    });

    it("一覧は owner でなくても見える（決定 D-08。誤削除に気づけるようにするため）", async () => {
      const project = await createProject(handle.db, OWNER, { name: "P" });
      await deleteProject(handle.db, OWNER, project.id);

      const trash = await listDeletedProjects(handle.db, OTHER_MEMBER);

      expect(trash.map((p) => p.id)).toEqual([project.id]);
    });

    it("一覧は未ログインなら UnauthorizedError を投げる", async () => {
      await expect(listDeletedProjects(handle.db, null)).rejects.toThrow(UnauthorizedError);
    });

    it("owner は復元でき、一覧に戻る", async () => {
      const project = await createProject(handle.db, OWNER, { name: "戻したい" });
      await deleteProject(handle.db, OWNER, project.id);

      await restoreProject(handle.db, OWNER, project.id);

      expect((await listProjects(handle.db, OWNER)).map((p) => p.id)).toEqual([project.id]);
      expect(await listDeletedProjects(handle.db, OWNER)).toEqual([]);
    });

    it("決定 D-15: owner でないメンバーは復元できない", async () => {
      const project = await createProject(handle.db, OWNER, { name: "P" });
      await deleteProject(handle.db, OWNER, project.id);

      await expect(restoreProject(handle.db, OTHER_MEMBER, project.id)).rejects.toThrow(
        ForbiddenError,
      );

      // 拒否されたら DB は変わっていないこと（トランザクションが巻き戻ること）。
      expect((await listDeletedProjects(handle.db, OWNER)).map((p) => p.id)).toEqual([project.id]);
    });

    it("未ログインなら UnauthorizedError を投げる", async () => {
      const project = await createProject(handle.db, OWNER, { name: "P" });
      await deleteProject(handle.db, OWNER, project.id);

      await expect(restoreProject(handle.db, null, project.id)).rejects.toThrow(UnauthorizedError);
    });

    it("生存中の PJ を復元しようとすると NotFoundError を投げる", async () => {
      const project = await createProject(handle.db, OWNER, { name: "生きている" });

      await expect(restoreProject(handle.db, OWNER, project.id)).rejects.toThrow(NotFoundError);
    });

    it("存在しない PJ は NotFoundError を投げる", async () => {
      await expect(restoreProject(handle.db, OWNER, "nonexistent-project")).rejects.toThrow(
        NotFoundError,
      );
    });

    /**
     * PJ の削除は配下タスクの `deleted_at` を立てない（§4.4）。したがって PJ を戻せば
     * 配下タスクもそのまま戻り、PJ 削除とは別に個別削除されたタスクは削除済みのまま残る。
     */
    it("復元しても配下タスクの削除状態は変えない", async () => {
      const project = await createProject(handle.db, OWNER, { name: "P" });
      const [alive] = await handle.db
        .insert(tasks)
        .values({
          projectId: project.id,
          title: "生存タスク",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
        })
        .returning();
      const [individuallyDeleted] = await handle.db
        .insert(tasks)
        .values({
          projectId: project.id,
          title: "個別に削除したタスク",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          deletedAt: new Date(),
        })
        .returning();

      await deleteProject(handle.db, OWNER, project.id);
      await restoreProject(handle.db, OWNER, project.id);

      const [aliveAfter] = await handle.db.select().from(tasks).where(eq(tasks.id, alive!.id));
      const [deletedAfter] = await handle.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, individuallyDeleted!.id));
      expect(aliveAfter?.deletedAt).toBeNull();
      expect(deletedAfter?.deletedAt).not.toBeNull();
    });
  });
});
