import { describe, expect, it } from "vitest";
import {
  addDaysToDateOnly,
  diffInCalendarDays,
  isValidDateOnly,
  todayInTimeZone,
} from "./date-only";

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

  /**
   * Phase 2 §6.3。Vercel のサーバーは UTC で動くため、素朴に日付を取ると
   * JST の 0:00〜9:00 の間はサーバー側の日付が1日前になり、
   * ダッシュボードの「期限超過」判定が丸1日ずれる。
   */
  describe("todayInTimeZone", () => {
    it("JST の 0:00 直後は、UTC ではまだ前日でも当日の日付を返す", () => {
      // 2026-08-08 00:30 JST = 2026-08-07 15:30 UTC
      const now = new Date("2026-08-07T15:30:00Z");

      expect(todayInTimeZone("Asia/Tokyo", now)).toBe("2026-08-08");
      // 取り違えていないことを示すため、UTC 側も併せて確認する
      expect(todayInTimeZone("UTC", now)).toBe("2026-08-07");
    });

    it("JST の 23:59 は、UTC では翌日でも当日の日付を返す", () => {
      // 2026-08-08 23:59 JST = 2026-08-08 14:59 UTC（UTC 側はまだ同日）
      expect(todayInTimeZone("Asia/Tokyo", new Date("2026-08-08T14:59:00Z"))).toBe("2026-08-08");
      // 2026-08-09 08:00 JST = 2026-08-08 23:00 UTC
      expect(todayInTimeZone("Asia/Tokyo", new Date("2026-08-08T23:00:00Z"))).toBe("2026-08-09");
    });

    it("ゼロ埋めされた YYYY-MM-DD を返す（date-only 文字列の辞書順比較が成立する形）", () => {
      const result = todayInTimeZone("Asia/Tokyo", new Date("2026-01-05T00:00:00Z"));

      expect(result).toBe("2026-01-05");
      expect(isValidDateOnly(result)).toBe(true);
    });

    it("月末・年末をまたぐ境界でも正しい日付を返す", () => {
      // 2027-01-01 00:00 JST = 2026-12-31 15:00 UTC
      expect(todayInTimeZone("Asia/Tokyo", new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
      expect(todayInTimeZone("UTC", new Date("2026-12-31T15:00:00Z"))).toBe("2026-12-31");
    });
  });
});
