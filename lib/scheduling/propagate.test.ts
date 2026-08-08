import { describe, expect, it } from "vitest";
import {
  aggregateSummaryValues,
  moveTask,
  resizeTaskEnd,
  wouldCreateCycle,
} from "./propagate";
import type { Dependency, ScheduleTask } from "./types";

/** テスト用のタスクを簡潔に組み立てるヘルパー。指定しない項目は無害な既定値にする。 */
function task(overrides: Partial<ScheduleTask> & Pick<ScheduleTask, "id">): ScheduleTask {
  return {
    parentId: null,
    type: "task",
    startDate: "2026-08-03",
    endDate: "2026-08-05",
    progress: 0,
    estimatedHours: null,
    actualHours: null,
    isPinned: false,
    isDeleted: false,
    ...overrides,
  };
}

function dep(predecessorId: string, successorId: string): Dependency {
  return { predecessorId, successorId };
}

describe("moveTask", () => {
  it("T-1: 依存なしのタスクを +3 すると本人のみ動く", () => {
    const tasks = [task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" })];
    const result = moveTask({
      taskId: "A",
      deltaDays: 3,
      tasks,
      dependencies: [],
      dependencySyncEnabled: true,
    });

    expect(result.changes).toEqual([
      {
        id: "A",
        before: { startDate: "2026-08-03", endDate: "2026-08-05" },
        after: { startDate: "2026-08-06", endDate: "2026-08-08" },
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("T-2: 直列 A→B→C、A を +3 すると B, C も +3 動きギャップは不変", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-06", endDate: "2026-08-08" }),
      task({ id: "C", startDate: "2026-08-10", endDate: "2026-08-12" }),
    ];
    const dependencies = [dep("A", "B"), dep("B", "C")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 3,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    const byId = Object.fromEntries(result.changes.map((c) => [c.id, c]));
    expect(byId.A?.after).toEqual({ startDate: "2026-08-06", endDate: "2026-08-08" });
    expect(byId.B?.after).toEqual({ startDate: "2026-08-09", endDate: "2026-08-11" });
    expect(byId.C?.after).toEqual({ startDate: "2026-08-13", endDate: "2026-08-15" });

    // ギャップ（A終了→B開始、B終了→C開始）が保たれていること
    expect(byId.B?.before.startDate).not.toBe(byId.B?.after.startDate); // 動いたことの前提確認
  });

  it("T-3: 直列 A→B→C、A を -2（前倒し）すると B, C も -2 動く", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-06", endDate: "2026-08-08" }),
      task({ id: "C", startDate: "2026-08-10", endDate: "2026-08-12" }),
    ];
    const dependencies = [dep("A", "B"), dep("B", "C")];

    const result = moveTask({
      taskId: "A",
      deltaDays: -2,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    const byId = Object.fromEntries(result.changes.map((c) => [c.id, c]));
    expect(byId.A?.after).toEqual({ startDate: "2026-08-01", endDate: "2026-08-03" });
    expect(byId.B?.after).toEqual({ startDate: "2026-08-04", endDate: "2026-08-06" });
    expect(byId.C?.after).toEqual({ startDate: "2026-08-08", endDate: "2026-08-10" });
  });

  it("T-4: 分岐 A→B, A→C、A を +5 すると B, C ともに +5 動く", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-06", endDate: "2026-08-08" }),
      task({ id: "C", startDate: "2026-08-06", endDate: "2026-08-09" }),
    ];
    const dependencies = [dep("A", "B"), dep("A", "C")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 5,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    const byId = Object.fromEntries(result.changes.map((c) => [c.id, c]));
    expect(byId.B?.after).toEqual({ startDate: "2026-08-11", endDate: "2026-08-13" });
    expect(byId.C?.after).toEqual({ startDate: "2026-08-11", endDate: "2026-08-14" });
  });

  it("T-5: 合流 A→C, B→C、A を +4 すると C は +4 が一度だけ適用される", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "C", startDate: "2026-08-06", endDate: "2026-08-08" }),
    ];
    const dependencies = [dep("A", "C"), dep("B", "C")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 4,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    const cChanges = result.changes.filter((c) => c.id === "C");
    expect(cChanges).toHaveLength(1);
    expect(cChanges[0]?.after).toEqual({ startDate: "2026-08-10", endDate: "2026-08-12" });
  });

  it("T-6: 直列 A→B→C、B が pinned のとき A を +3 しても B, C は不動", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-06", endDate: "2026-08-08", isPinned: true }),
      task({ id: "C", startDate: "2026-08-10", endDate: "2026-08-12" }),
    ];
    const dependencies = [dep("A", "B"), dep("B", "C")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 3,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    expect(result.changes.map((c) => c.id)).toEqual(["A"]);
    expect(result.skipped).toEqual([{ id: "B", reason: "pinned" }]);
  });

  it("T-7: PJ トグル OFF なら A を +3 しても A のみ動く", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-06", endDate: "2026-08-08" }),
    ];
    const dependencies = [dep("A", "B")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 3,
      tasks,
      dependencies,
      dependencySyncEnabled: false,
    });

    expect(result.changes.map((c) => c.id)).toEqual(["A"]);
    expect(result.skipped).toEqual([]);
  });

  it("T-8: 修飾キー押下なら A を +3 しても A のみ動く", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-06", endDate: "2026-08-08" }),
    ];
    const dependencies = [dep("A", "B")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 3,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
      bypassSync: true,
    });

    expect(result.changes.map((c) => c.id)).toEqual(["A"]);
    expect(result.skipped).toEqual([]);
  });

  it("T-9: 子タスクが動いた結果、親 summary の期間が再計算される", () => {
    const tasks = [
      task({ id: "P", type: "summary", startDate: "2026-08-03", endDate: "2026-08-08" }),
      task({ id: "A", parentId: "P", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", parentId: "P", startDate: "2026-08-06", endDate: "2026-08-08" }),
    ];
    const dependencies = [dep("A", "B")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 5,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    const byId = Object.fromEntries(result.changes.map((c) => [c.id, c]));
    // A: 08-08 〜 08-10, B(後続): 08-11 〜 08-13 のはず
    expect(byId.A?.after).toEqual({ startDate: "2026-08-08", endDate: "2026-08-10" });
    expect(byId.B?.after).toEqual({ startDate: "2026-08-11", endDate: "2026-08-13" });
    // 親 summary は子の min(start)/max(end) で再計算される
    expect(byId.P?.after).toEqual({ startDate: "2026-08-08", endDate: "2026-08-13" });
  });

  it("T-13: 直列 A→B→C、B が削除済みのとき A を +3 しても C は不動", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-06", endDate: "2026-08-08", isDeleted: true }),
      task({ id: "C", startDate: "2026-08-10", endDate: "2026-08-12" }),
    ];
    const dependencies = [dep("A", "B"), dep("B", "C")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 3,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    expect(result.changes.map((c) => c.id)).toEqual(["A"]);
    expect(result.skipped).toEqual([{ id: "B", reason: "deleted" }]);
  });

  it("T-14: 土日を跨ぐ移動でも暦日でそのまま +3 する（決定 D-09）", () => {
    // 2026-08-07 は金曜日。+3 すると土日を挟んで 2026-08-10（月曜）
    const tasks = [task({ id: "A", startDate: "2026-08-07", endDate: "2026-08-07" })];

    const result = moveTask({
      taskId: "A",
      deltaDays: 3,
      tasks,
      dependencies: [],
      dependencySyncEnabled: true,
    });

    expect(result.changes[0]?.after).toEqual({ startDate: "2026-08-10", endDate: "2026-08-10" });
  });

  it("T-15: 伝播結果には変更前の日付が含まれる", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-06", endDate: "2026-08-08" }),
    ];
    const dependencies = [dep("A", "B")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 2,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    const byId = Object.fromEntries(result.changes.map((c) => [c.id, c]));
    expect(byId.A?.before).toEqual({ startDate: "2026-08-03", endDate: "2026-08-05" });
    expect(byId.B?.before).toEqual({ startDate: "2026-08-06", endDate: "2026-08-08" });
  });

  it("T-16: 親の進捗・工数が子から集計される（工数は合計、進捗は見積工数で加重平均）", () => {
    const tasks = [
      task({ id: "P", type: "summary", startDate: "2026-08-03", endDate: "2026-08-10" }),
      task({
        id: "A",
        parentId: "P",
        startDate: "2026-08-03",
        endDate: "2026-08-05",
        progress: 100,
        estimatedHours: 10,
        actualHours: 12,
      }),
      task({
        id: "B",
        parentId: "P",
        startDate: "2026-08-08",
        endDate: "2026-08-10",
        progress: 0,
        estimatedHours: 30,
        actualHours: 0,
      }),
    ];

    // B 自身を動かし、親 P の再集計をトリガーする
    const result = moveTask({
      taskId: "B",
      deltaDays: 1,
      tasks,
      dependencies: [],
      dependencySyncEnabled: true,
    });

    const summaryDateChange = result.changes.find((c) => c.id === "P");
    expect(summaryDateChange?.after).toEqual({ startDate: "2026-08-03", endDate: "2026-08-11" });

    const summaryUpdate = result.summaryUpdates.find((s) => s.id === "P");
    // 工数は単純合計: 10 + 30 = 40, 12 + 0 = 12
    expect(summaryUpdate?.estimatedHours).toBe(40);
    expect(summaryUpdate?.actualHours).toBe(12);
    // 進捗は見積工数による加重平均: (100*10 + 0*30) / (10+30) = 25
    expect(summaryUpdate?.progress).toBe(25);
  });

  it("T-16b: 見積が無い子は均等重み（1）として進捗の加重平均に混ざる", () => {
    const tasks = [
      task({ id: "P", type: "summary", startDate: "2026-08-03", endDate: "2026-08-10" }),
      task({
        id: "A",
        parentId: "P",
        startDate: "2026-08-03",
        endDate: "2026-08-05",
        progress: 100,
        estimatedHours: null,
        actualHours: null,
      }),
      task({
        id: "B",
        parentId: "P",
        startDate: "2026-08-08",
        endDate: "2026-08-10",
        progress: 0,
        estimatedHours: null,
        actualHours: null,
      }),
    ];

    const result = moveTask({
      taskId: "B",
      deltaDays: 1,
      tasks,
      dependencies: [],
      dependencySyncEnabled: true,
    });

    const summaryUpdate = result.summaryUpdates.find((s) => s.id === "P");
    // 見積工数が無い子同士は均等重みなので単純平均: (100 + 0) / 2 = 50
    expect(summaryUpdate?.progress).toBe(50);
    expect(summaryUpdate?.estimatedHours).toBe(0);
    expect(summaryUpdate?.actualHours).toBe(0);
  });
});

describe("resizeTaskEnd", () => {
  it("T-12: バーのリサイズ（end のみ変更）で Δ が後続へ伝播する（決定 D-01）", () => {
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", startDate: "2026-08-06", endDate: "2026-08-08" }),
    ];
    const dependencies = [dep("A", "B")];

    const result = resizeTaskEnd({
      taskId: "A",
      deltaDays: 3,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    const byId = Object.fromEntries(result.changes.map((c) => [c.id, c]));
    // A は start はそのまま、end だけ +3
    expect(byId.A?.after).toEqual({ startDate: "2026-08-03", endDate: "2026-08-08" });
    // B は後続としてまるごと +3 平行移動
    expect(byId.B?.after).toEqual({ startDate: "2026-08-09", endDate: "2026-08-11" });
  });
});

describe("wouldCreateCycle", () => {
  it("T-10: 追加するとサイクルになる依存は検出される", () => {
    // 既存: A→B→C。ここに C→A を足すとサイクルになる
    const dependencies = [dep("A", "B"), dep("B", "C")];
    expect(wouldCreateCycle(dependencies, "C", "A")).toBe(true);
  });

  it("サイクルにならない依存の追加は許可される", () => {
    const dependencies = [dep("A", "B")];
    expect(wouldCreateCycle(dependencies, "A", "C")).toBe(false);
  });

  it("自己参照はサイクルとして拒否される", () => {
    expect(wouldCreateCycle([], "A", "A")).toBe(true);
  });
});

describe("moveTask: 性能回帰検知", () => {
  it("T-11: 100 タスク / 200 依存の直列＋分岐で 1 回の伝播が 50ms 未満", () => {
    const tasks: ScheduleTask[] = [];
    const dependencies: Dependency[] = [];

    for (let i = 0; i < 100; i++) {
      tasks.push(
        task({
          id: `T${i}`,
          startDate: "2026-08-03",
          endDate: "2026-08-04",
        }),
      );
    }
    // 直列の鎖
    for (let i = 0; i < 99; i++) {
      dependencies.push(dep(`T${i}`, `T${i + 1}`));
    }
    // さらに分岐を追加して 200 本弱にする
    for (let i = 0; i < 99; i++) {
      const branchTarget = (i + 2) % 100;
      dependencies.push(dep(`T${i}`, `T${branchTarget}`));
    }

    const start = performance.now();
    const result = moveTask({
      taskId: "T0",
      deltaDays: 1,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });
    const elapsed = performance.now() - start;

    expect(result.changes.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });
});

describe("moveTask: 不整合データへの防御", () => {
  it("parentId が循環していてもスタックオーバーフローせず完了する", () => {
    // データ不整合（本来はアプリ層で作れないはずの循環）を想定した回帰テスト。
    const tasks = [
      task({ id: "A", parentId: "B", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "B", parentId: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
    ];

    expect(() =>
      moveTask({
        taskId: "A",
        deltaDays: 1,
        tasks,
        dependencies: [],
        dependencySyncEnabled: true,
      }),
    ).not.toThrow();
  });

  it("循環の外側にあるタスクを動かしても、祖先を辿って循環に入った時点で打ち切る", () => {
    // X → 親 A、A/B は循環。X 自身は循環に含まれないが、祖先探索が循環に踏み込む経路。
    const tasks = [
      task({
        id: "A",
        parentId: "B",
        type: "summary",
        startDate: "2026-08-03",
        endDate: "2026-08-05",
      }),
      task({
        id: "B",
        parentId: "A",
        type: "summary",
        startDate: "2026-08-03",
        endDate: "2026-08-05",
      }),
      task({ id: "X", parentId: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
    ];

    expect(() =>
      moveTask({
        taskId: "X",
        deltaDays: 1,
        tasks,
        dependencies: [],
        dependencySyncEnabled: true,
      }),
    ).not.toThrow();
  });
});

describe("aggregateSummaryValues", () => {
  it("子が空なら progress 0・工数 0 を返す", () => {
    expect(aggregateSummaryValues([])).toEqual({
      progress: 0,
      estimatedHours: 0,
      actualHours: 0,
    });
  });

  it("estimatedHours が null の子は集計 0・加重 1 として扱う", () => {
    // 見積無し(null)の子2件: 工数合計には入らないが、進捗は均等加重で平均される
    const result = aggregateSummaryValues([
      { progress: 100, estimatedHours: null, actualHours: null },
      { progress: 0, estimatedHours: null, actualHours: null },
    ]);
    expect(result).toEqual({ progress: 50, estimatedHours: 0, actualHours: 0 });
  });

  it("進捗は見積工数による加重平均を四捨五入する", () => {
    // (100*3 + 0*1) / (3+1) = 75
    const result = aggregateSummaryValues([
      { progress: 100, estimatedHours: 3, actualHours: 2 },
      { progress: 0, estimatedHours: 1, actualHours: null },
    ]);
    expect(result).toEqual({ progress: 75, estimatedHours: 4, actualHours: 2 });
  });

  it("小数になる加重平均は Math.round で丸める", () => {
    // (50*1 + 100*2) / 3 = 83.33... → 83
    const result = aggregateSummaryValues([
      { progress: 50, estimatedHours: 1, actualHours: null },
      { progress: 100, estimatedHours: 2, actualHours: null },
    ]);
    expect(result.progress).toBe(83);
  });
});
