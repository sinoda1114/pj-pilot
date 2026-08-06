import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnauthorizedError, ForbiddenError } from "../auth/errors";
import { createDb, type DbHandle } from "../db/client";
import { projectMembers } from "../db/schema";
import { NotFoundError } from "../errors";
import { createProject, deleteProject, listProjects, updateProject } from "./service";

const OWNER = { userId: "owner-1" };
const OTHER_MEMBER = { userId: "other-1" };

describe("projects/service", () => {
  let dir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-projects-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
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
      await expect(createProject(handle.db, null, { name: "P" })).rejects.toThrow(UnauthorizedError);
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

    it("論理削除済みのPJは NotFoundError を投げる", async () => {
      const project = await createProject(handle.db, OWNER, { name: "削除予定" });
      await deleteProject(handle.db, OWNER, project.id);

      await expect(updateProject(handle.db, OWNER, project.id, { name: "x" })).rejects.toThrow(
        NotFoundError,
      );
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
});
