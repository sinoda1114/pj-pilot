import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";
import { getActiveProject, listActiveProjects } from "./queries";
import { projects } from "./schema";

describe("queries: 生存レコードのみを返す（§3.2 / §4.4(c)）", () => {
  let dir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-queries-test-"));
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

  it("listActiveProjects は論理削除済みのプロジェクトを除外する", async () => {
    const [alive] = await handle.db.insert(projects).values({ name: "生存中" }).returning();
    const [deleted] = await handle.db.insert(projects).values({ name: "削除済み" }).returning();
    if (!alive || !deleted) {
      throw new Error("Failed to create test projects");
    }
    await handle.db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(eq(projects.id, deleted.id));

    const result = await listActiveProjects(handle.db);

    expect(result.map((p) => p.id)).toEqual([alive.id]);
  });

  it("getActiveProject は論理削除済みのプロジェクトには undefined を返す", async () => {
    const [deleted] = await handle.db.insert(projects).values({ name: "削除済み" }).returning();
    if (!deleted) {
      throw new Error("Failed to create test project");
    }
    await handle.db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(eq(projects.id, deleted.id));

    const result = await getActiveProject(handle.db, deleted.id);

    expect(result).toBeUndefined();
  });

  it("getActiveProject は生存中のプロジェクトを返す", async () => {
    const [alive] = await handle.db.insert(projects).values({ name: "生存中" }).returning();
    if (!alive) {
      throw new Error("Failed to create test project");
    }

    const result = await getActiveProject(handle.db, alive.id);

    expect(result?.id).toBe(alive.id);
  });
});
