import { describe, expect, it } from "vitest";
import {
  UNASSIGNED_ASSIGNEE,
  filterBoardTasks,
  isBoardFilterActive,
  listAssigneeOptions,
  type BoardFilterCriteria,
} from "./filter";

/**
 * カンバンボードの絞り込みの純粋関数（Phase 2 §5 / 未決事項 Q-3 の方針変更）。
 *
 * `lib/board/order.ts` と同じ方針で、DB も React も触らない「配列 → 配列」だけを扱う。
 * 境界条件はすべてここで潰し、`BoardClient.tsx` 側は
 * 「state → この関数を適用 → 描画」の薄い層にする。
 */

/** テスト用の最小タスク。`filterBoardTasks` は id と priority しか見ない。 */
function task(id: string, priority: string) {
  return { id, priority, title: `タスク ${id}` };
}

const ALL_TASKS = [
  task("t1", "low"),
  task("t2", "medium"),
  task("t3", "high"),
  task("t4", "urgent"),
  task("t5", "high"),
];

/** t1=alice, t2=bob, t3=alice+bob, t4=（担当者なし）, t5=（キー自体が無い） */
const ASSIGNEES: Record<string, string[]> = {
  t1: ["alice"],
  t2: ["bob"],
  t3: ["alice", "bob"],
  t4: [],
};

function ids(rows: { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

describe("board/filter", () => {
  describe("filterBoardTasks", () => {
    it("条件が空のときは全件返す", () => {
      expect(ids(filterBoardTasks(ALL_TASKS, {}, ASSIGNEES))).toEqual([
        "t1",
        "t2",
        "t3",
        "t4",
        "t5",
      ]);
    });

    it("空配列の条件も「絞り込まない」として扱う", () => {
      expect(
        ids(filterBoardTasks(ALL_TASKS, { priorities: [], assignees: [] }, ASSIGNEES)),
      ).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    });

    it("空のタスク配列を渡しても空配列を返す", () => {
      expect(filterBoardTasks([], { priorities: ["high"] }, {})).toEqual([]);
    });

    it("優先度が1つ指定されたときはそれだけを残す", () => {
      expect(ids(filterBoardTasks(ALL_TASKS, { priorities: ["high"] }, ASSIGNEES))).toEqual([
        "t3",
        "t5",
      ]);
    });

    it("優先度を複数指定したときは OR で残す", () => {
      expect(
        ids(filterBoardTasks(ALL_TASKS, { priorities: ["high", "urgent"] }, ASSIGNEES)),
      ).toEqual(["t3", "t4", "t5"]);
    });

    it("どのタスクにも存在しない優先度を指定すると0件になる", () => {
      expect(filterBoardTasks(ALL_TASKS, { priorities: ["bogus"] }, ASSIGNEES)).toEqual([]);
    });

    it("担当者を1人指定したときはその人が割り当てられたタスクだけを残す", () => {
      expect(ids(filterBoardTasks(ALL_TASKS, { assignees: ["alice"] }, ASSIGNEES))).toEqual([
        "t1",
        "t3",
      ]);
    });

    it("担当者を複数指定したときは OR（いずれか1人でも割り当てられていれば一致）", () => {
      expect(ids(filterBoardTasks(ALL_TASKS, { assignees: ["alice", "bob"] }, ASSIGNEES))).toEqual([
        "t1",
        "t2",
        "t3",
      ]);
    });

    it("「担当者なし」で未割り当てのタスクだけを絞り込める", () => {
      // t4 は空配列、t5 は assigneesByTaskId にキー自体が無い。どちらも未割り当て扱い。
      expect(
        ids(filterBoardTasks(ALL_TASKS, { assignees: [UNASSIGNED_ASSIGNEE] }, ASSIGNEES)),
      ).toEqual(["t4", "t5"]);
    });

    it("「担当者なし」と実在の担当者は OR で組み合わせられる", () => {
      expect(
        ids(filterBoardTasks(ALL_TASKS, { assignees: [UNASSIGNED_ASSIGNEE, "bob"] }, ASSIGNEES)),
      ).toEqual(["t2", "t3", "t4", "t5"]);
    });

    it("優先度と担当者は AND で効く", () => {
      // high は t3・t5。そのうち alice が担当なのは t3 だけ。
      expect(
        ids(filterBoardTasks(ALL_TASKS, { priorities: ["high"], assignees: ["alice"] }, ASSIGNEES)),
      ).toEqual(["t3"]);
    });

    it("AND の結果として0件になることもある", () => {
      // urgent は t4 のみ。t4 は未割り当てなので alice では一致しない。
      expect(
        filterBoardTasks(ALL_TASKS, { priorities: ["urgent"], assignees: ["alice"] }, ASSIGNEES),
      ).toEqual([]);
    });

    it("全条件（優先度・担当者・担当者なし）を同時に指定しても AND / OR の組み合わせが崩れない", () => {
      expect(
        ids(
          filterBoardTasks(
            ALL_TASKS,
            { priorities: ["high", "urgent"], assignees: [UNASSIGNED_ASSIGNEE, "alice"] },
            ASSIGNEES,
          ),
        ),
      ).toEqual(["t3", "t4", "t5"]);
    });

    it("assigneesByTaskId を省略した場合、全タスクが未割り当てとして扱われる", () => {
      expect(ids(filterBoardTasks(ALL_TASKS, { assignees: [UNASSIGNED_ASSIGNEE] }))).toEqual([
        "t1",
        "t2",
        "t3",
        "t4",
        "t5",
      ]);
      expect(filterBoardTasks(ALL_TASKS, { assignees: ["alice"] })).toEqual([]);
    });

    it("元の並び順を保つ（board_order 昇順のまま返す）", () => {
      const shuffled = [task("z", "high"), task("a", "high"), task("m", "high")];
      expect(ids(filterBoardTasks(shuffled, { priorities: ["high"] }, {}))).toEqual([
        "z",
        "a",
        "m",
      ]);
    });

    it("入力配列を破壊しない（呼び出し元の state をそのまま渡せる）", () => {
      const input = [...ALL_TASKS];
      const result = filterBoardTasks(input, { priorities: ["high"] }, ASSIGNEES);
      expect(input).toEqual(ALL_TASKS);
      expect(result).not.toBe(input);
    });

    it("条件が空でも入力配列そのものではなくコピーを返す", () => {
      const input = [...ALL_TASKS];
      expect(filterBoardTasks(input, {})).not.toBe(input);
    });
  });

  describe("isBoardFilterActive", () => {
    it("条件が無いときは false", () => {
      expect(isBoardFilterActive({})).toBe(false);
      expect(isBoardFilterActive({ priorities: [], assignees: [] })).toBe(false);
    });

    it("優先度だけ指定されていても true", () => {
      expect(isBoardFilterActive({ priorities: ["high"] })).toBe(true);
    });

    it("担当者だけ指定されていても true", () => {
      expect(isBoardFilterActive({ assignees: [UNASSIGNED_ASSIGNEE] })).toBe(true);
    });

    it("BoardFilterCriteria 型の値をそのまま渡せる", () => {
      const criteria: BoardFilterCriteria = { priorities: ["low"], assignees: ["alice"] };
      expect(isBoardFilterActive(criteria)).toBe(true);
    });
  });

  describe("listAssigneeOptions", () => {
    it("実際に割り当てられている担当者を重複なく昇順で返す", () => {
      expect(listAssigneeOptions(ALL_TASKS, ASSIGNEES)).toEqual(["alice", "bob"]);
    });

    it("渡されたタスクに紐づかない担当者は含めない", () => {
      expect(listAssigneeOptions([task("t2", "medium")], ASSIGNEES)).toEqual(["bob"]);
    });

    it("誰も割り当てられていなければ空配列", () => {
      expect(listAssigneeOptions(ALL_TASKS, {})).toEqual([]);
      expect(listAssigneeOptions([], ASSIGNEES)).toEqual([]);
    });
  });
});
