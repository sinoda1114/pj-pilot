import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../db/client";
import { projects, tasks } from "../db/schema";
import { persistPropagateResult } from "./persist";

describe("persistPropagateResult", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-persist-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });

    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    if (!project) {
      throw new Error("Failed to create test project");
    }
    projectId = project.id;
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

  it("changesの日付とsummaryUpdatesの集計値をDBに反映する", async () => {
    const [a] = await handle.db
      .insert(tasks)
      .values({ projectId, title: "A", startDate: "2026-08-01", endDate: "2026-08-05" })
      .returning();
    const [summary] = await handle.db
      .insert(tasks)
      .values({
        projectId,
        title: "サマリー",
        type: "summary",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      })
      .returning();
    if (!a || !summary) {
      throw new Error("Failed to create test tasks");
    }

    await persistPropagateResult(handle.db, {
      changes: [
        {
          id: a.id,
          before: { startDate: "2026-08-01", endDate: "2026-08-05" },
          after: { startDate: "2026-08-04", endDate: "2026-08-08" },
        },
        {
          id: summary.id,
          before: { startDate: "2026-08-01", endDate: "2026-08-05" },
          after: { startDate: "2026-08-04", endDate: "2026-08-08" },
        },
      ],
      skipped: [],
      summaryUpdates: [{ id: summary.id, progress: 42, estimatedHours: 10, actualHours: 3 }],
    });

    const [updatedA] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
    const [updatedSummary] = await handle.db.select().from(tasks).where(eq(tasks.id, summary.id));

    expect(updatedA).toMatchObject({ startDate: "2026-08-04", endDate: "2026-08-08" });
    expect(updatedSummary).toMatchObject({
      startDate: "2026-08-04",
      endDate: "2026-08-08",
      progress: 42,
      estimatedHours: 10,
      actualHours: 3,
    });
  });

  it("changesが空でも例外にならない", async () => {
    await expect(
      persistPropagateResult(handle.db, { changes: [], skipped: [], summaryUpdates: [] }),
    ).resolves.toBeUndefined();
  });
});
