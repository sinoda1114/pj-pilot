import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../lib/db/client";
import { getTaskById } from "../lib/db/queries";
import { projects, tasks } from "../lib/db/schema";
import {
  DETAIL_LIMIT,
  formatPlanReport,
  main,
  parseArgs,
  planSummaryTypeChanges,
  runBackfill,
  type TaskTypeRow,
} from "./backfill-summary-type";

function row(overrides: Partial<TaskTypeRow> & { id: string }): TaskTypeRow {
  return {
    title: `タスク ${overrides.id}`,
    type: "task",
    parentId: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("scripts/backfill-summary-type: planSummaryTypeChanges", () => {
  it("生存する子を持つ task を summary に変える", () => {
    const changes = planSummaryTypeChanges([
      row({ id: "parent" }),
      row({ id: "child", parentId: "parent" }),
    ]);

    expect(changes).toEqual([
      { id: "parent", title: "タスク parent", from: "task", to: "summary" },
    ]);
  });

  it("生存する子が0件の summary を task に戻す", () => {
    const changes = planSummaryTypeChanges([row({ id: "lonely", type: "summary" })]);

    expect(changes).toEqual([
      { id: "lonely", title: "タスク lonely", from: "summary", to: "task" },
    ]);
  });

  it("milestone は子の有無にかかわらず変えない（決定 D-12）", () => {
    const changes = planSummaryTypeChanges([
      row({ id: "m-with-child", type: "milestone" }),
      row({ id: "child", parentId: "m-with-child" }),
      row({ id: "m-alone", type: "milestone" }),
    ]);

    expect(changes).toEqual([]);
  });

  it("削除済みの子しか持たない task は summary にしない", () => {
    const changes = planSummaryTypeChanges([
      row({ id: "parent" }),
      row({ id: "child", parentId: "parent", deletedAt: new Date() }),
    ]);

    expect(changes).toEqual([]);
  });

  it("削除済みの行自体は対象にしない（getActiveTask に合わせる）", () => {
    const changes = planSummaryTypeChanges([
      // 削除済みの summary。生存する子は居ないが、行が削除済みなので触らない。
      row({ id: "deleted-summary", type: "summary", deletedAt: new Date() }),
      // 削除済みの task。生存する子は居るが、行が削除済みなので触らない。
      row({ id: "deleted-parent", deletedAt: new Date() }),
      row({ id: "child", parentId: "deleted-parent" }),
    ]);

    expect(changes).toEqual([]);
  });

  it("既に整合している行は対象に含めない", () => {
    const changes = planSummaryTypeChanges([
      row({ id: "summary-with-child", type: "summary" }),
      row({ id: "child", parentId: "summary-with-child" }),
      row({ id: "childless-task" }),
    ]);

    expect(changes).toEqual([]);
  });

  it("id の昇順で返す", () => {
    const changes = planSummaryTypeChanges([
      row({ id: "c", type: "summary" }),
      row({ id: "a", type: "summary" }),
      row({ id: "b", type: "summary" }),
    ]);

    expect(changes.map((change) => change.id)).toEqual(["a", "b", "c"]);
  });
});

describe("scripts/backfill-summary-type: formatPlanReport", () => {
  it("対象が無いときは 0 件と伝える", () => {
    expect(formatPlanReport([])).toContain("更新対象: 0 件");
  });

  it("明細は先頭 DETAIL_LIMIT 件だけを出し、残りは件数のみ表示する", () => {
    const changes = Array.from({ length: DETAIL_LIMIT + 3 }, (_, index) => ({
      // id の桁を揃えて、明細に出る行が先頭 DETAIL_LIMIT 件であることを判定しやすくする。
      id: `t${String(index).padStart(3, "0")}`,
      title: `タスク ${index}`,
      from: "summary" as const,
      to: "task" as const,
    }));

    const report = formatPlanReport(changes);
    const detailLines = report.split("\n").filter((line) => line.includes(" -> "));

    expect(report).toContain(`更新対象: ${DETAIL_LIMIT + 3} 件`);
    expect(detailLines).toHaveLength(DETAIL_LIMIT);
    expect(report).toContain("t000");
    expect(report).not.toContain(`t${String(DETAIL_LIMIT).padStart(3, "0")}`);
    expect(report).toContain("他 3 件");
  });
});

describe("scripts/backfill-summary-type: parseArgs", () => {
  it("既定は dry-run", () => {
    expect(parseArgs([])).toEqual({ apply: false, help: false });
  });

  it("--apply を明示したときだけ apply になる", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
  });

  it("--help / -h を受け付ける", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("知らない引数はエラーにする（打ち間違いを黙って dry-run にしない）", () => {
    expect(() => parseArgs(["--aply"])).toThrow("不明な引数です");
  });
});

describe("scripts/backfill-summary-type: runBackfill", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-backfill-summary-type-test-"));
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

  async function insertTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
    const [task] = await handle.db
      .insert(tasks)
      .values({
        projectId,
        title: "タスク",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        ...overrides,
      })
      .returning();
    if (!task) {
      throw new Error("Failed to create test task");
    }
    return task;
  }

  async function typeOf(taskId: string) {
    const task = await getTaskById(handle.db, taskId);
    return task?.type;
  }

  it("--apply で、生存する子を持つ task が summary になる", async () => {
    const parent = await insertTask({ title: "親" });
    await insertTask({ title: "子", parentId: parent.id });

    const { updated } = await runBackfill(handle.db, { apply: true });

    expect(updated).toBe(1);
    expect(await typeOf(parent.id)).toBe("summary");
  });

  it("--apply で、子0件の summary が task に戻る", async () => {
    const lonely = await insertTask({ title: "子の居ないサマリー", type: "summary" });

    const { updated } = await runBackfill(handle.db, { apply: true });

    expect(updated).toBe(1);
    expect(await typeOf(lonely.id)).toBe("task");
  });

  it("--apply でも milestone は子の有無にかかわらず変わらない", async () => {
    const withChild = await insertTask({ title: "子を持つマイルストーン", type: "milestone" });
    await insertTask({ title: "子", parentId: withChild.id });
    const alone = await insertTask({ title: "単独マイルストーン", type: "milestone" });

    const { updated } = await runBackfill(handle.db, { apply: true });

    expect(updated).toBe(0);
    expect(await typeOf(withChild.id)).toBe("milestone");
    expect(await typeOf(alone.id)).toBe("milestone");
  });

  it("論理削除済みの子しか持たない task は summary にならない", async () => {
    const parent = await insertTask({ title: "親" });
    await insertTask({ title: "削除済みの子", parentId: parent.id, deletedAt: new Date() });

    const { changes, updated } = await runBackfill(handle.db, { apply: true });

    expect(changes).toEqual([]);
    expect(updated).toBe(0);
    expect(await typeOf(parent.id)).toBe("task");
  });

  it("dry-run では対象を報告するだけで DB を変更しない", async () => {
    const parent = await insertTask({ title: "親" });
    await insertTask({ title: "子", parentId: parent.id });
    const lonely = await insertTask({ title: "子の居ないサマリー", type: "summary" });

    const { changes, updated } = await runBackfill(handle.db, { apply: false });

    expect(updated).toBe(0);
    expect(changes).toHaveLength(2);
    expect(changes.map((change) => change.to).sort()).toEqual(["summary", "task"]);
    expect(await typeOf(parent.id)).toBe("task");
    expect(await typeOf(lonely.id)).toBe("summary");
  });

  it("既に正しい行は更新件数に数えない", async () => {
    const summary = await insertTask({ title: "サマリー", type: "summary" });
    await insertTask({ title: "子", parentId: summary.id });
    await insertTask({ title: "単独タスク" });

    const { changes, updated } = await runBackfill(handle.db, { apply: true });

    expect(changes).toEqual([]);
    expect(updated).toBe(0);
    expect(await typeOf(summary.id)).toBe("summary");
  });

  it("整合していない行だけを更新し、既に正しい行には触れない（混在ケース）", async () => {
    const needsSummary = await insertTask({ title: "印の無い親" });
    await insertTask({ title: "子", parentId: needsSummary.id });
    const needsTask = await insertTask({ title: "子の居ないサマリー", type: "summary" });
    const alreadyOk = await insertTask({ title: "単独タスク" });

    const { updated } = await runBackfill(handle.db, { apply: true });

    expect(updated).toBe(2);
    expect(await typeOf(needsSummary.id)).toBe("summary");
    expect(await typeOf(needsTask.id)).toBe("task");
    expect(await typeOf(alreadyOk.id)).toBe("task");
  });

  it("--apply を2回流しても2回目は対象0件（冪等）", async () => {
    const parent = await insertTask({ title: "親" });
    await insertTask({ title: "子", parentId: parent.id });

    await runBackfill(handle.db, { apply: true });
    const second = await runBackfill(handle.db, { apply: true });

    expect(second.changes).toEqual([]);
    expect(second.updated).toBe(0);
  });

  /**
   * CLI の入口（`main`）そのものの検証。
   *
   * 「どの DB に、どのモードで繋いだか」を利用者に伝えるのはここだけで、取り違えると
   * 意図しない DB に `--apply` が走る。`TURSO_DATABASE_URL` をテスト用の一時 DB へ
   * 向けて、接続先とモードの表示・実際に更新が走ったかどうかまで確認する。
   */
  describe("main", () => {
    let logs: string[];

    beforeEach(() => {
      logs = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      // beforeEach で開いた一時 DB を main の接続先にする。
      vi.stubEnv("TURSO_DATABASE_URL", `file:${join(dir, "test.db")}`);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it("--help は使い方だけを表示し、DB に接続しない", async () => {
      const parent = await insertTask({ title: "親" });
      await insertTask({ title: "子", parentId: parent.id });

      await main(["--help"]);

      expect(logs.join("\n")).toContain("使い方:");
      expect(logs.join("\n")).not.toContain("対象DB:");
      // 不整合はそのまま残る。
      expect(await typeOf(parent.id)).toBe("task");
    });

    it("引数なしは dry-run。接続先とモードを表示し、DB を変更しない", async () => {
      const parent = await insertTask({ title: "親" });
      await insertTask({ title: "子", parentId: parent.id });

      await main([]);

      const output = logs.join("\n");
      expect(output).toContain(`対象DB: file:${join(dir, "test.db")}`);
      expect(output).toContain("モード: dry-run");
      expect(output).toContain("更新対象: 1 件");
      expect(output).not.toContain("更新完了:");
      expect(await typeOf(parent.id)).toBe("task");
    });

    it("--apply は実際に更新し、更新件数を表示する", async () => {
      const parent = await insertTask({ title: "親" });
      await insertTask({ title: "子", parentId: parent.id });

      await main(["--apply"]);

      const output = logs.join("\n");
      expect(output).toContain("モード: --apply");
      expect(output).toContain("更新完了: 1 件");
      expect(await typeOf(parent.id)).toBe("summary");
    });

    it("不明な引数はエラーになり、DB を変更しない", async () => {
      const parent = await insertTask({ title: "親" });
      await insertTask({ title: "子", parentId: parent.id });

      await expect(main(["--aply"])).rejects.toThrow("不明な引数です: --aply");
      expect(await typeOf(parent.id)).toBe("task");
    });
  });
});
