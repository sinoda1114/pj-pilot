import { describe, expect, it } from "vitest";
import {
  computeProjectProgress,
  countByStatus,
  findOverdueTasks,
  type DashboardTask,
} from "./metrics";

/**
 * ダッシュボードの集計（Phase 2 §6.2 / M9 #46）。
 *
 * 「タスク配列 → 集計結果」の純粋関数だけを扱う。DB を使わずに書けるので、
 * 境界条件（0件・分母0・除外対象・日付の境界）はすべてここで潰す。
 */

function task(overrides: Partial<DashboardTask> & { id: string }): DashboardTask {
  return {
    projectId: "p1",
    status: "todo",
    type: "task",
    endDate: "2026-08-31",
    title: overrides.id,
    ...overrides,
  };
}

describe("dashboard/metrics", () => {
  describe("countByStatus", () => {
    it("ステータスごとの件数を返す", () => {
      const result = countByStatus([
        task({ id: "a", status: "todo" }),
        task({ id: "b", status: "todo" }),
        task({ id: "c", status: "in_progress" }),
        task({ id: "d", status: "done" }),
      ]);

      expect(result).toEqual({ todo: 2, in_progress: 1, review: 0, done: 1 });
    });

    it("該当が0件のステータスも 0 として必ず含める（グラフの列が消えないように）", () => {
      expect(countByStatus([])).toEqual({ todo: 0, in_progress: 0, review: 0, done: 0 });
    });

    it("type='task' 以外は数えない（summary は二重計上、milestone は決定 D-12 で UI 非公開）", () => {
      const result = countByStatus([
        task({ id: "a", status: "todo" }),
        task({ id: "s", status: "todo", type: "summary" }),
        task({ id: "m", status: "todo", type: "milestone" }),
      ]);

      expect(result.todo).toBe(1);
    });
  });

  describe("findOverdueTasks", () => {
    const today = "2026-08-08";

    it("終了日が今日より前で、かつ未完了のタスクを返す", () => {
      const result = findOverdueTasks(
        [
          task({ id: "遅延", endDate: "2026-08-07", status: "in_progress" }),
          task({ id: "今日", endDate: "2026-08-08", status: "in_progress" }),
          task({ id: "未来", endDate: "2026-08-09", status: "in_progress" }),
        ],
        today,
      );

      expect(result.map((row) => row.id)).toEqual(["遅延"]);
    });

    it("終了日が今日ちょうどは超過ではない（期限当日はまだ猶予がある）", () => {
      expect(findOverdueTasks([task({ id: "a", endDate: today })], today)).toEqual([]);
    });

    it("完了済みは期限を過ぎていても超過に含めない", () => {
      const result = findOverdueTasks(
        [
          task({ id: "完了", endDate: "2026-08-01", status: "done" }),
          task({ id: "確認中", endDate: "2026-08-01", status: "review" }),
        ],
        today,
      );

      expect(result.map((row) => row.id)).toEqual(["確認中"]);
    });

    it("type='task' 以外は含めない", () => {
      const result = findOverdueTasks(
        [
          task({ id: "a", endDate: "2026-08-01" }),
          task({ id: "s", endDate: "2026-08-01", type: "summary" }),
          task({ id: "m", endDate: "2026-08-01", type: "milestone" }),
        ],
        today,
      );

      expect(result.map((row) => row.id)).toEqual(["a"]);
    });

    it("期限の古い順に並べる（最も遅れているものが先頭）", () => {
      const result = findOverdueTasks(
        [
          task({ id: "3日前", endDate: "2026-08-05" }),
          task({ id: "7日前", endDate: "2026-08-01" }),
          task({ id: "1日前", endDate: "2026-08-07" }),
        ],
        today,
      );

      expect(result.map((row) => row.id)).toEqual(["7日前", "3日前", "1日前"]);
    });

    it("同じ期限のタスクは id で安定した順序になる（描画順が揺れないように）", () => {
      const result = findOverdueTasks(
        [task({ id: "z", endDate: "2026-08-01" }), task({ id: "a", endDate: "2026-08-01" })],
        today,
      );

      expect(result.map((row) => row.id)).toEqual(["a", "z"]);
    });

    it("該当なしなら空配列", () => {
      expect(findOverdueTasks([], today)).toEqual([]);
    });
  });

  describe("computeProjectProgress", () => {
    const projects = [
      { id: "p1", name: "PJ1" },
      { id: "p2", name: "PJ2" },
    ];

    it("完了タスクの割合（件数ベース）を返す（決定 P2-07）", () => {
      const result = computeProjectProgress(projects, [
        task({ id: "a", projectId: "p1", status: "done" }),
        task({ id: "b", projectId: "p1", status: "done" }),
        task({ id: "c", projectId: "p1", status: "todo" }),
        task({ id: "d", projectId: "p1", status: "in_progress" }),
        task({ id: "e", projectId: "p2", status: "done" }),
      ]);

      expect(result).toEqual([
        { projectId: "p1", name: "PJ1", total: 4, done: 2, percent: 50 },
        { projectId: "p2", name: "PJ2", total: 1, done: 1, percent: 100 },
      ]);
    });

    it("タスクが0件のプロジェクトは percent を null にする（0% と区別する）", () => {
      const result = computeProjectProgress(projects, [
        task({ id: "a", projectId: "p1", status: "done" }),
      ]);

      expect(result[1]).toEqual({ projectId: "p2", name: "PJ2", total: 0, done: 0, percent: null });
    });

    it("割り切れない場合は整数に丸める", () => {
      const result = computeProjectProgress(
        [{ id: "p1", name: "PJ1" }],
        [
          task({ id: "a", projectId: "p1", status: "done" }),
          task({ id: "b", projectId: "p1", status: "todo" }),
          task({ id: "c", projectId: "p1", status: "todo" }),
        ],
      );

      // 1/3 = 33.33... → 33
      expect(result[0]?.percent).toBe(33);
    });

    it("type='task' 以外は分母にも分子にも含めない", () => {
      const result = computeProjectProgress(
        [{ id: "p1", name: "PJ1" }],
        [
          task({ id: "a", projectId: "p1", status: "done" }),
          task({ id: "s", projectId: "p1", status: "todo", type: "summary" }),
        ],
      );

      expect(result[0]).toEqual({ projectId: "p1", name: "PJ1", total: 1, done: 1, percent: 100 });
    });

    it("プロジェクトが0件なら空配列", () => {
      expect(computeProjectProgress([], [])).toEqual([]);
    });

    it("どのプロジェクトにも属さないタスクは無視する（他PJのデータが紛れても壊れない）", () => {
      const result = computeProjectProgress(
        [{ id: "p1", name: "PJ1" }],
        [
          task({ id: "a", projectId: "p1", status: "done" }),
          task({ id: "x", projectId: "unknown", status: "todo" }),
        ],
      );

      expect(result[0]?.total).toBe(1);
    });
  });
});
