import { describe, expect, it } from "vitest";
import { priorityLabel, projectRoleLabel, statusLabel, taskTypeLabel } from "./labels";

describe("priorityLabel（決定 D-18）", () => {
  it.each([
    ["low", "低"],
    ["medium", "中"],
    ["high", "高"],
    ["urgent", "緊急"],
  ] as const)("%s → %s", (value, expected) => {
    expect(priorityLabel(value)).toBe(expected);
  });
});

describe("statusLabel（決定 D-19）", () => {
  it.each([
    ["todo", "未着手"],
    ["in_progress", "対応中"],
    ["review", "確認中"],
    ["done", "完了"],
  ] as const)("%s → %s", (value, expected) => {
    expect(statusLabel(value)).toBe(expected);
  });
});

describe("taskTypeLabel", () => {
  it.each([
    ["task", "タスク"],
    ["summary", "サマリー"],
    ["milestone", "マイルストーン"],
  ] as const)("%s → %s", (value, expected) => {
    expect(taskTypeLabel(value)).toBe(expected);
  });
});

describe("projectRoleLabel", () => {
  it.each([
    ["owner", "オーナー"],
    ["member", "メンバー"],
  ] as const)("%s → %s", (value, expected) => {
    expect(projectRoleLabel(value)).toBe(expected);
  });
});
