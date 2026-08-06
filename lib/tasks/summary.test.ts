import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../db/client";
import { getTaskById } from "../db/queries";
import { projects, tasks } from "../db/schema";
import { aggregateSummaryValues } from "../scheduling/propagate";
import { recomputeAndPersistAncestorSummaries } from "./summary";

describe("tasks/summary", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-task-summary-test-"));
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

  it("1階層: 見積工数ありの子2件から progress/estimatedHours/actualHours が D-11 の数式どおりに再計算される", async () => {
    const parent = await insertTask({ title: "親", type: "summary" });
    const childA = await insertTask({
      title: "子A",
      parentId: parent.id,
      progress: 100,
      estimatedHours: 10,
      actualHours: 12,
    });
    await insertTask({
      title: "子B",
      parentId: parent.id,
      progress: 0,
      estimatedHours: 30,
      actualHours: 0,
    });

    await recomputeAndPersistAncestorSummaries(handle.db, childA.id);

    const updated = await getTaskById(handle.db, parent.id);
    // 工数は単純合計: 10 + 30 = 40, 12 + 0 = 12
    expect(updated?.estimatedHours).toBe(40);
    expect(updated?.actualHours).toBe(12);
    // 進捗は見積工数による加重平均: (100*10 + 0*30) / (10+30) = 25
    expect(updated?.progress).toBe(25);
  });

  it("見積工数が未設定の子は重み1として計算に含まれる（D-11）", async () => {
    const parent = await insertTask({ title: "親", type: "summary" });
    const childA = await insertTask({
      title: "子A",
      parentId: parent.id,
      progress: 100,
      estimatedHours: null,
      actualHours: null,
    });
    await insertTask({
      title: "子B",
      parentId: parent.id,
      progress: 0,
      estimatedHours: null,
      actualHours: null,
    });

    await recomputeAndPersistAncestorSummaries(handle.db, childA.id);

    const updated = await getTaskById(handle.db, parent.id);
    // 見積が無い子同士は均等重みなので単純平均: (100 + 0) / 2 = 50
    expect(updated?.progress).toBe(50);
    expect(updated?.estimatedHours).toBe(0);
    expect(updated?.actualHours).toBe(0);
  });

  it("見積工数ありの子と未設定の子が混在する場合、未設定側は重み1として加重平均に混ざる", async () => {
    const parent = await insertTask({ title: "親", type: "summary" });
    const childA = await insertTask({
      title: "子A（見積あり）",
      parentId: parent.id,
      progress: 100,
      estimatedHours: 9,
      actualHours: 5,
    });
    await insertTask({
      title: "子B（見積なし）",
      parentId: parent.id,
      progress: 0,
      estimatedHours: null,
      actualHours: null,
    });

    await recomputeAndPersistAncestorSummaries(handle.db, childA.id);

    const updated = await getTaskById(handle.db, parent.id);
    // 工数合計: 9 + 0 = 9, 5 + 0 = 5
    expect(updated?.estimatedHours).toBe(9);
    expect(updated?.actualHours).toBe(5);
    // 進捗: (100*9 + 0*1) / (9+1) = 90
    expect(updated?.progress).toBe(90);
  });

  it("多階層: 祖父母も summary の場合、両方の階層が正しく更新される", async () => {
    const grandparent = await insertTask({ title: "祖父", type: "summary" });
    const parent = await insertTask({
      title: "親",
      type: "summary",
      parentId: grandparent.id,
    });
    const child = await insertTask({
      title: "子",
      parentId: parent.id,
      progress: 40,
      estimatedHours: 20,
      actualHours: 8,
    });
    // 親と同階層の兄弟（祖父の子でもある summary の一部）
    await insertTask({
      title: "叔父（親の兄弟。祖父の直接の子）",
      parentId: grandparent.id,
      progress: 60,
      estimatedHours: 10,
      actualHours: 6,
    });

    await recomputeAndPersistAncestorSummaries(handle.db, child.id);

    const updatedParent = await getTaskById(handle.db, parent.id);
    // 親の直接の子は child のみ: そのままコピーされる
    expect(updatedParent?.progress).toBe(40);
    expect(updatedParent?.estimatedHours).toBe(20);
    expect(updatedParent?.actualHours).toBe(8);

    const updatedGrandparent = await getTaskById(handle.db, grandparent.id);
    // 祖父の直接の子は 更新後の親（progress40, est20） と uncle（progress60, est10）
    // 工数合計: 20 + 10 = 30, 8 + 6 = 14
    expect(updatedGrandparent?.estimatedHours).toBe(30);
    expect(updatedGrandparent?.actualHours).toBe(14);
    // 進捗: (40*20 + 60*10) / (20+10) = (800+600)/30 = 46.67 → Math.round = 47
    expect(updatedGrandparent?.progress).toBe(47);
  });

  it("type が summary でない祖先（'task'）は progress/hours を書き換えない", async () => {
    const parent = await insertTask({
      title: "親（type=task）",
      type: "task",
      progress: 10,
      estimatedHours: 1,
      actualHours: 1,
    });
    const child = await insertTask({
      title: "子",
      parentId: parent.id,
      progress: 100,
      estimatedHours: 10,
      actualHours: 10,
    });

    await recomputeAndPersistAncestorSummaries(handle.db, child.id);

    const updated = await getTaskById(handle.db, parent.id);
    expect(updated?.progress).toBe(10);
    expect(updated?.estimatedHours).toBe(1);
    expect(updated?.actualHours).toBe(1);
  });

  it("type が summary でない祖先（'milestone'）は progress/hours を書き換えない", async () => {
    const parent = await insertTask({
      title: "親（type=milestone）",
      type: "milestone",
      progress: 5,
      estimatedHours: 2,
      actualHours: 2,
    });
    const child = await insertTask({
      title: "子",
      parentId: parent.id,
      progress: 100,
      estimatedHours: 10,
      actualHours: 10,
    });

    await recomputeAndPersistAncestorSummaries(handle.db, child.id);

    const updated = await getTaskById(handle.db, parent.id);
    expect(updated?.progress).toBe(5);
    expect(updated?.estimatedHours).toBe(2);
    expect(updated?.actualHours).toBe(2);
  });

  it("論理削除済みの summary 祖先は progress/hours を書き換えない（防御的ガード。code review 指摘対応）", async () => {
    const parent = await insertTask({
      title: "親（削除済みだが、不変条件違反で生存子を持つケースを想定）",
      type: "summary",
      progress: 33,
      estimatedHours: 5,
      actualHours: 5,
    });
    await handle.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, parent.id));
    const child = await insertTask({
      title: "子",
      parentId: parent.id,
      progress: 100,
      estimatedHours: 10,
      actualHours: 10,
    });

    await recomputeAndPersistAncestorSummaries(handle.db, child.id);

    const updated = await getTaskById(handle.db, parent.id);
    expect(updated?.progress).toBe(33);
    expect(updated?.estimatedHours).toBe(5);
    expect(updated?.actualHours).toBe(5);
  });

  it("論理削除済みの子は集計から除外される", async () => {
    const parent = await insertTask({ title: "親", type: "summary" });
    const child = await insertTask({
      title: "生きている子",
      parentId: parent.id,
      progress: 50,
      estimatedHours: 10,
      actualHours: 5,
    });
    const deletedChild = await insertTask({
      title: "削除済みの子",
      parentId: parent.id,
      progress: 100,
      estimatedHours: 1000,
      actualHours: 1000,
    });
    await handle.db
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(eq(tasks.id, deletedChild.id));

    await recomputeAndPersistAncestorSummaries(handle.db, child.id);

    const updated = await getTaskById(handle.db, parent.id);
    // 削除済みの子（見積1000等）が混ざっていれば数値が大きく外れるはずだが、
    // 生きている子だけの値になっていること
    expect(updated?.estimatedHours).toBe(10);
    expect(updated?.actualHours).toBe(5);
    expect(updated?.progress).toBe(50);
  });

  it("直接の子が全員削除済みの summary は、既存の progress/hours を変更しない", async () => {
    const parent = await insertTask({
      title: "親",
      type: "summary",
      progress: 77,
      estimatedHours: 99,
      actualHours: 88,
    });
    const child = await insertTask({
      title: "唯一の子（後で削除）",
      parentId: parent.id,
      progress: 0,
      estimatedHours: 1,
      actualHours: 1,
    });
    await handle.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, child.id));

    await recomputeAndPersistAncestorSummaries(handle.db, child.id);

    const updated = await getTaskById(handle.db, parent.id);
    expect(updated?.progress).toBe(77);
    expect(updated?.estimatedHours).toBe(99);
    expect(updated?.actualHours).toBe(88);
  });

  it("循環した parent_id があっても無限ループしない（防御的ガード）", async () => {
    const a = await insertTask({ title: "A", type: "summary" });
    const b = await insertTask({ title: "B", type: "summary", parentId: a.id });
    const c = await insertTask({ title: "C", parentId: b.id, progress: 20, estimatedHours: 4 });
    // 本来 CHECK 制約では防げない多段循環（A→B→A）を直接 SQL で作る。
    await handle.db.update(tasks).set({ parentId: b.id }).where(eq(tasks.id, a.id));

    await expect(recomputeAndPersistAncestorSummaries(handle.db, c.id)).resolves.toBeUndefined();
  });

  it("存在しないタスク ID を渡しても例外を投げずに何もしない", async () => {
    await expect(
      recomputeAndPersistAncestorSummaries(handle.db, "nonexistent"),
    ).resolves.toBeUndefined();
  });

  it("propagate.ts の集計関数（aggregateSummaryValues）と同じ数式であることの裏付け: " +
    "lib/scheduling/propagate.test.ts T-16 と同一の入力から同一の結果が得られる", async () => {
    // lib/scheduling/propagate.test.ts の T-16 と全く同じ数値を用意する。
    const parent = await insertTask({ title: "P", type: "summary" });
    const childA = await insertTask({
      title: "A",
      parentId: parent.id,
      progress: 100,
      estimatedHours: 10,
      actualHours: 12,
    });
    const childB = await insertTask({
      title: "B",
      parentId: parent.id,
      progress: 0,
      estimatedHours: 30,
      actualHours: 0,
    });

    await recomputeAndPersistAncestorSummaries(handle.db, childB.id);
    const persisted = await getTaskById(handle.db, parent.id);

    // 同じ子データを propagate.ts の純粋関数に直接渡した結果と一致するはず
    // （同じ関数を呼んでいるので当然一致するが、DB 経由の変換層が数値を
    // 壊していないことの回帰確認として比較する）。
    const direct = aggregateSummaryValues([
      { progress: childA.progress, estimatedHours: childA.estimatedHours, actualHours: childA.actualHours },
      { progress: childB.progress, estimatedHours: childB.estimatedHours, actualHours: childB.actualHours },
    ]);

    expect(persisted?.progress).toBe(direct.progress);
    expect(persisted?.estimatedHours).toBe(direct.estimatedHours);
    expect(persisted?.actualHours).toBe(direct.actualHours);

    // propagate.test.ts T-16 が期待する具体的な数値とも一致することを確認する
    expect(persisted?.estimatedHours).toBe(40);
    expect(persisted?.actualHours).toBe(12);
    expect(persisted?.progress).toBe(25);
  });
});
