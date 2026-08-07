import { describe, expect, it } from "vitest";
import { toDependencies, toScheduleTasks } from "./adapter";

describe("toScheduleTasks", () => {
  it("DBの行をScheduleTaskへ変換し、deletedAtの有無をisDeletedに変換する", () => {
    const result = toScheduleTasks([
      {
        id: "A",
        parentId: null,
        type: "task",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        progress: 50,
        estimatedHours: 10,
        actualHours: 5,
        isPinned: false,
        deletedAt: null,
      },
      {
        id: "B",
        parentId: "A",
        type: "summary",
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        progress: 0,
        estimatedHours: null,
        actualHours: null,
        isPinned: true,
        deletedAt: new Date("2026-08-01T00:00:00Z"),
      },
    ]);

    expect(result).toEqual([
      {
        id: "A",
        parentId: null,
        type: "task",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        progress: 50,
        estimatedHours: 10,
        actualHours: 5,
        isPinned: false,
        isDeleted: false,
      },
      {
        id: "B",
        parentId: "A",
        type: "summary",
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        progress: 0,
        estimatedHours: null,
        actualHours: null,
        isPinned: true,
        isDeleted: true,
      },
    ]);
  });
});

describe("toDependencies", () => {
  it("predecessorId/successorIdをそのまま取り出す", () => {
    const result = toDependencies([{ predecessorId: "A", successorId: "B" }]);

    expect(result).toEqual([{ predecessorId: "A", successorId: "B" }]);
  });
});
