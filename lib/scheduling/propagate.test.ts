import { describe, expect, it } from "vitest";
import { aggregateSummaryValues, moveTask, resizeTaskEnd, wouldCreateCycle } from "./propagate";
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

  it("親 summary の期間が子の再計算後も変わらない場合、changes に親を含めない（不要な UPDATE を出さない）", () => {
    // P の期間は C2 が決めており、C1 を動かしても min(start)/max(end) は変わらない。
    // この場合に親を changes へ入れてしまうと、永続化層が毎回無意味な UPDATE を
    // 発行し、伝播結果のトーストにも動いていないタスクが並んでしまう。
    // 併せて、子が3件あるときの min/max の畳み込み（新しい値を採用する側と
    // 既存値を保つ側の両方）が正しいことも確認する。
    const tasks = [
      task({ id: "P", type: "summary", startDate: "2026-08-01", endDate: "2026-08-31" }),
      task({ id: "C1", parentId: "P", startDate: "2026-08-10", endDate: "2026-08-20" }),
      task({ id: "C2", parentId: "P", startDate: "2026-08-01", endDate: "2026-08-31" }),
      task({ id: "C3", parentId: "P", startDate: "2026-08-05", endDate: "2026-08-25" }),
    ];

    const result = moveTask({
      taskId: "C1",
      deltaDays: 2,
      tasks,
      dependencies: [],
      dependencySyncEnabled: true,
    });

    expect(result.changes.map((c) => c.id)).toEqual(["C1"]);
    // 日付は変わらないが、進捗・工数の再集計対象としては親を返す。
    expect(result.summaryUpdates.map((s) => s.id)).toEqual(["P"]);
  });

  it("依存先のタスクがタスク一覧に含まれていなくても落ちず、他の後続への伝播は続く", () => {
    // 依存レコードはタスクを論理削除しても残る（決定 D-06）。ここでは
    // 参照先が一覧に無い（別PJへ移動済み等の不整合）ケースでも
    // 例外にせず読み飛ばすことを確認する。
    const tasks = [
      task({ id: "A", startDate: "2026-08-03", endDate: "2026-08-05" }),
      task({ id: "C", startDate: "2026-08-10", endDate: "2026-08-12" }),
    ];
    const dependencies = [dep("A", "存在しないタスク"), dep("A", "C")];

    const result = moveTask({
      taskId: "A",
      deltaDays: 3,
      tasks,
      dependencies,
      dependencySyncEnabled: true,
    });

    expect(result.changes.map((c) => c.id)).toEqual(["A", "C"]);
    // 一覧に無いタスクは「スキップした理由」としても報告しない（表示できないため）。
    expect(result.skipped).toEqual([]);
  });

  it("parentId が一覧に無いタスクを指していても落ちず、summary 再計算をスキップする", () => {
    // 親 summary が別PJに移動した等でタスク一覧から欠けている不整合データ。
    const tasks = [
      task({ id: "A", parentId: "存在しない親", startDate: "2026-08-03", endDate: "2026-08-05" }),
    ];

    const result = moveTask({
      taskId: "A",
      deltaDays: 1,
      tasks,
      dependencies: [],
      dependencySyncEnabled: true,
    });

    expect(result.changes.map((c) => c.id)).toEqual(["A"]);
    expect(result.summaryUpdates).toEqual([]);
  });

  it("一覧に存在しないタスク ID を動かそうとするとエラーになる（黙って何もしない結果を返さない）", () => {
    expect(() =>
      moveTask({
        taskId: "存在しないタスク",
        deltaDays: 1,
        tasks: [task({ id: "A" })],
        dependencies: [],
        dependencySyncEnabled: true,
      }),
    ).toThrow("task not found: 存在しないタスク");
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

describe("resizeTaskEnd: 異常系", () => {
  it("一覧に存在しないタスク ID をリサイズしようとするとエラーになる", () => {
    expect(() =>
      resizeTaskEnd({
        taskId: "存在しないタスク",
        deltaDays: 1,
        tasks: [task({ id: "A" })],
        dependencies: [],
        dependencySyncEnabled: true,
      }),
    ).toThrow("task not found: 存在しないタスク");
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

  it("合流（ダイヤモンド）があっても同じノードを二度辿らずに探索を終える", () => {
    // A→B, A→C, B→D, C→D。D は B 経由と C 経由の2回スタックに積まれる。
    // 訪問済み判定が無いと、合流の多いグラフで探索が指数的に膨らむ。
    const dependencies = [dep("A", "B"), dep("A", "C"), dep("B", "D"), dep("C", "D")];

    // Z→A は既存の依存グラフのどこにも戻らないためサイクルにならない。
    expect(wouldCreateCycle(dependencies, "Z", "A")).toBe(false);
    // 一方 D→A はサイクル（A→B→D→A）になる。
    expect(wouldCreateCycle(dependencies, "D", "A")).toBe(true);
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

describe("aggregateSummaryValues: 境界値（Devin Review指摘の反映）", () => {
  it("estimatedHours が 0 の子は加重 0 となり進捗集計から除外される", () => {
    // 0 は `?? 1` のフォールバックに掛からない（null/undefined のみ）。
    // 見積 0h のタスクは進捗の加重平均に寄与しない、を仕様として固定する
    const result = aggregateSummaryValues([
      { progress: 100, estimatedHours: 0, actualHours: null },
      { progress: 50, estimatedHours: 2, actualHours: null },
    ]);
    expect(result).toEqual({ progress: 50, estimatedHours: 2, actualHours: 0 });
  });

  it("加重平均がちょうど .5 のときは正方向に丸める（Math.round準拠）", () => {
    // (0*1 + 1*1) / 2 = 0.5 → 1
    const result = aggregateSummaryValues([
      { progress: 0, estimatedHours: 1, actualHours: null },
      { progress: 1, estimatedHours: 1, actualHours: null },
    ]);
    expect(result.progress).toBe(1);
  });
});

describe("moveTask: 同一タスクが「Δシフト対象」と「変更された子の祖先」を兼ねる場合", () => {
  /**
   * サマリー P（子 C1・C2）と、P・C1 の両方に依存を張った X を用意する。
   * X を動かすと P は「依存の後続」として Δ シフトされ、同時に「動いた C1 の祖先」
   * としても再集計対象になる。この二役が重なるケースを固定する。
   *
   * 依存の作成側（`lib/dependencies/service.ts`）は自己参照・別プロジェクト・重複・
   * 循環しか弾かないため、「サマリーとその子の両方に依存を張る」構成は実際に作れる。
   */
  function buildOverlapCase() {
    const tasks = [
      task({ id: "X", startDate: "2026-01-01", endDate: "2026-01-05" }),
      task({
        id: "P",
        type: "summary",
        startDate: "2026-02-01",
        endDate: "2026-02-20",
      }),
      task({ id: "C1", parentId: "P", startDate: "2026-02-01", endDate: "2026-02-10" }),
      task({ id: "C2", parentId: "P", startDate: "2026-02-11", endDate: "2026-02-20" }),
    ];
    return moveTask({
      taskId: "X",
      deltaDays: 3,
      tasks,
      dependencies: [dep("X", "P"), dep("X", "C1")],
      dependencySyncEnabled: true,
    });
  }

  it("changes に同じタスクが二重に現れない", () => {
    // 二重に入ると `persistPropagateResult` が同じ行を2回 UPDATE し（後勝ち）、
    // トーストの「N件のタスクを移動しました」も水増しされる。
    // 動くのは X（操作対象）・C1（依存の後続）・P（C1 の親サマリー）の3件。
    // C2 は依存も無く親でもないので変わらない。
    const result = buildOverlapCase();

    expect(result.changes.map((c) => c.id).sort()).toEqual(["C1", "P", "X"]);
  });

  it("before は「操作前の値」のまま保たれる（Undo が元の日付に戻せる）", () => {
    // ここが崩れると Undo が壊れる。`GanttView` は `changes[].before` をそのまま
    // Undo の payload にし、`persistPropagateResult` が配列順に UPDATE を流すため、
    // 同一 id の2件目（before にシフト後の値が入ったもの）が後勝ちして、
    // 「元に戻す」を押しても元の日付に戻らなくなる。
    const result = buildOverlapCase();
    const p = result.changes.find((c) => c.id === "P");

    expect(p?.before).toEqual({ startDate: "2026-02-01", endDate: "2026-02-20" });
  });

  it("再集計で元の位置に戻る場合でも、操作対象は changes に残る", () => {
    // P（summary）を +3 ドラッグすると、依存の後続 C1 が動き、その結果 P は
    // 子から再集計されて**元の範囲に戻る**（C2 が動かないため min/max が変わらない）。
    // このとき `before === after` になるが、ここで changes から落としてはいけない。
    // `GanttView` は changes をループして SVAR の楽観更新をリコンサイルしているため、
    // 落とすとバーは +3 された位置に残り、DB は元の位置、という不整合になる。
    const tasks = [
      task({ id: "P", type: "summary", startDate: "2026-02-01", endDate: "2026-02-20" }),
      task({ id: "C1", parentId: "P", startDate: "2026-02-05", endDate: "2026-02-08" }),
      task({ id: "C2", parentId: "P", startDate: "2026-02-01", endDate: "2026-02-20" }),
    ];
    const result = moveTask({
      taskId: "P",
      deltaDays: 3,
      tasks,
      dependencies: [dep("P", "C1")],
      dependencySyncEnabled: true,
    });

    expect(result.changes.find((c) => c.id === "P")).toEqual({
      id: "P",
      before: { startDate: "2026-02-01", endDate: "2026-02-20" },
      after: { startDate: "2026-02-01", endDate: "2026-02-20" },
    });
  });

  it("after は子から再集計した結果になる（サマリーの日付は子が正）", () => {
    // C1 は Δ シフトされて 02-04〜02-13、C2 は動かないので 02-11〜02-20。
    // サマリー P は min(start)/max(end) = 02-04〜02-20 でなければならない。
    // Δ を素朴に足した 02-04〜02-23 だと、子より後ろに伸びた状態になる。
    const result = buildOverlapCase();
    const p = result.changes.find((c) => c.id === "P");

    expect(p?.after).toEqual({ startDate: "2026-02-04", endDate: "2026-02-20" });
  });
});
