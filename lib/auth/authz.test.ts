import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../db/client";
import { projectMembers, projects } from "../db/schema";
import { requireLogin, requireProjectOwner } from "./authz";
import { ForbiddenError, UnauthorizedError } from "./errors";

describe("requireLogin", () => {
  it("セッションがあればそのまま返す", () => {
    const session = { userId: "u1" };

    expect(requireLogin(session)).toBe(session);
  });

  it("セッションが null なら UnauthorizedError を投げる", () => {
    expect(() => requireLogin(null)).toThrow(UnauthorizedError);
  });
});

describe("requireProjectOwner", () => {
  let dir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-authz-test-"));
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

  it("role='owner' のメンバーは許可される（例外を投げない）", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    await handle.db
      .insert(projectMembers)
      .values({ projectId: project!.id, userId: "owner-1", role: "owner" });

    await expect(
      requireProjectOwner(handle.db, { userId: "owner-1" }, project!.id),
    ).resolves.toBeUndefined();
  });

  it("role='member' は ForbiddenError を投げる（決定 D-15: PJ削除等はownerのみ）", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    await handle.db
      .insert(projectMembers)
      .values({ projectId: project!.id, userId: "member-1", role: "member" });

    await expect(
      requireProjectOwner(handle.db, { userId: "member-1" }, project!.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("PJ に所属していないユーザーは ForbiddenError を投げる", async () => {
    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();

    await expect(
      requireProjectOwner(handle.db, { userId: "outsider" }, project!.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("存在しない projectId でも（該当メンバーが無いので）ForbiddenError を投げる", async () => {
    await expect(
      requireProjectOwner(handle.db, { userId: "u1" }, "nonexistent-project"),
    ).rejects.toThrow(ForbiddenError);
  });
});
