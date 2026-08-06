import { describe, expect, it } from "vitest";
import { addDaysToDateOnly, diffInCalendarDays, isValidDateOnly } from "./date-only";

describe("date-only", () => {
  describe("isValidDateOnly", () => {
    it("YYYY-MM-DD 形式を受理する", () => {
      expect(isValidDateOnly("2026-08-06")).toBe(true);
    });

    it("不正な形式を拒否する", () => {
      expect(isValidDateOnly("2026/08/06")).toBe(false);
      expect(isValidDateOnly("2026-8-6")).toBe(false);
      expect(isValidDateOnly("")).toBe(false);
    });

    it("存在しない日付を拒否する（例: 2月30日）", () => {
      expect(isValidDateOnly("2026-02-30")).toBe(false);
    });
  });

  describe("addDaysToDateOnly", () => {
    it("正の日数を加算する", () => {
      expect(addDaysToDateOnly("2026-08-06", 3)).toBe("2026-08-09");
    });

    it("負の日数（前倒し）を加算する", () => {
      expect(addDaysToDateOnly("2026-08-06", -2)).toBe("2026-08-04");
    });

    it("0 日は変化しない", () => {
      expect(addDaysToDateOnly("2026-08-06", 0)).toBe("2026-08-06");
    });

    it("月をまたぐ加算をタイムゾーンなしで正しく計算する", () => {
      expect(addDaysToDateOnly("2026-08-31", 1)).toBe("2026-09-01");
    });

    it("年をまたぐ加算を正しく計算する", () => {
      expect(addDaysToDateOnly("2026-12-31", 1)).toBe("2027-01-01");
    });

    it("土日を挟んでも暦日のまま加算する（決定 D-09: 稼働日換算はしない）", () => {
      // 2026-08-07 は金曜日
      expect(addDaysToDateOnly("2026-08-07", 3)).toBe("2026-08-10");
    });
  });

  describe("diffInCalendarDays", () => {
    it("2 つの date-only 文字列の差を暦日で返す", () => {
      expect(diffInCalendarDays("2026-08-09", "2026-08-06")).toBe(3);
    });

    it("前の日付が後の場合は負数を返す", () => {
      expect(diffInCalendarDays("2026-08-04", "2026-08-06")).toBe(-2);
    });

    it("同じ日付は 0 を返す", () => {
      expect(diffInCalendarDays("2026-08-06", "2026-08-06")).toBe(0);
    });
  });
});
