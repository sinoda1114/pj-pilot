import { afterEach, describe, expect, it } from "vitest";
import { fromGanttEndDate, fromGanttStartDate, toGanttLinks, toGanttTasks } from "./transform";

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

describe("toGanttTasks", () => {
  it("§9 S-1: end は排他のため、DB の end_date（終了日を含む）に+1日して渡す", () => {
    const [result] = toGanttTasks([
      {
        id: "t1",
        parentId: null,
        title: "設計",
        startDate: "2026-08-01",
        endDate: "2026-08-03",
        progress: 50,
        type: "task",
      },
    ]);

    expect(result?.start).toEqual(new Date(2026, 7, 1));
    // DB の end_date=08-03（終了日を含む）→ SVAR には 08-04（排他）を渡す
    expect(result?.end).toEqual(new Date(2026, 7, 4));
  });

  it("1日タスク（start=end）でも SVAR 側ではゼロ幅にならない（+1日により排他境界が翌日になる）", () => {
    const [result] = toGanttTasks([
      {
        id: "t1",
        parentId: null,
        title: "1日タスク",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
        progress: 0,
        type: "task",
      },
    ]);

    expect(result?.start).toEqual(new Date(2026, 7, 1));
    expect(result?.end).toEqual(new Date(2026, 7, 2));
  });

  it("parentId が null ならルート扱いの sentinel 0 になる", () => {
    const [result] = toGanttTasks([
      {
        id: "t1",
        parentId: null,
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
        progress: 0,
        type: "task",
      },
    ]);

    expect(result?.parent).toBe(0);
  });

  it("parentId があればそのまま parent に渡す", () => {
    const [result] = toGanttTasks([
      {
        id: "t1",
        parentId: "parent-id",
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
        progress: 0,
        type: "task",
      },
    ]);

    expect(result?.parent).toBe("parent-id");
  });

  it("title/progress/type/id をそのまま text/progress/type/id に写す", () => {
    const [result] = toGanttTasks([
      {
        id: "t1",
        parentId: null,
        title: "要件定義",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        progress: 30,
        type: "summary",
      },
    ]);

    expect(result).toMatchObject({ id: "t1", text: "要件定義", progress: 30, type: "summary" });
  });

  it("§9 S-1: UTCより西のタイムゾーンでも日付がずれない（実測で見つかった回帰の防止）", () => {
    process.env.TZ = "America/Los_Angeles";

    const [result] = toGanttTasks([
      {
        id: "t1",
        parentId: null,
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
        progress: 0,
        type: "task",
      },
    ]);

    // ローカルタイムゾーンの日付コンポーネントで見て 8/1 と 8/2 になっていること
    // （new Date("2026-08-01") のような UTC 解釈だと LA では 7/31 になってしまう）。
    expect(result?.start.getFullYear()).toBe(2026);
    expect(result?.start.getMonth()).toBe(7);
    expect(result?.start.getDate()).toBe(1);
    expect(result?.end.getDate()).toBe(2);
  });
});

describe("toGanttLinks", () => {
  it("predecessorId/successorId を source/target に写し、type は e2s 固定", () => {
    const [result] = toGanttLinks([{ id: "d1", predecessorId: "a", successorId: "b" }]);

    expect(result).toEqual({ id: "d1", source: "a", target: "b", type: "e2s" });
  });
});

describe("fromGanttStartDate / fromGanttEndDate", () => {
  it("SVAR の Date を date-only 文字列に戻す", () => {
    expect(fromGanttStartDate(new Date(2026, 7, 1))).toBe("2026-08-01");
  });

  it("§9 S-1: SVAR の end（排他）を DB の end_date（終了日を含む）に戻すには-1日する", () => {
    expect(fromGanttEndDate(new Date(2026, 7, 4))).toBe("2026-08-03");
  });

  it("toGanttTasks との往復で元の日付に戻る", () => {
    const [ganttTask] = toGanttTasks([
      {
        id: "t1",
        parentId: null,
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        progress: 0,
        type: "task",
      },
    ]);

    expect(fromGanttStartDate(ganttTask!.start)).toBe("2026-08-01");
    expect(fromGanttEndDate(ganttTask!.end)).toBe("2026-08-05");
  });

  it("§9 S-1: UTCより西のタイムゾーンでも往復で元の日付に戻る", () => {
    process.env.TZ = "America/Los_Angeles";

    const [ganttTask] = toGanttTasks([
      {
        id: "t1",
        parentId: null,
        title: "T",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        progress: 0,
        type: "task",
      },
    ]);

    expect(fromGanttStartDate(ganttTask!.start)).toBe("2026-08-01");
    expect(fromGanttEndDate(ganttTask!.end)).toBe("2026-08-05");
  });
});
