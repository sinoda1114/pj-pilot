import { describe, expect, it } from "vitest";
import { moveAcrossColumns, reorderWithinColumn } from "./order";

/**
 * カンバンの並び替えの純粋関数（Phase 2 §5.3 / M8 #39）。
 *
 * 「配列 → 配列」だけを扱い、DB も React も触らない。境界条件はすべてここで潰し、
 * lib/board/service.ts 側は「取得 → この関数を適用 → 永続化」の薄い層にする。
 *
 * 要素は「id の配列」で表す。呼び出し側は board_order 昇順で並べた id 配列を渡し、
 * 戻り値の配列の添字がそのまま新しい board_order（0 始まり）になる。
 */

describe("board/order", () => {
  describe("reorderWithinColumn", () => {
    it("後ろへ移動できる", () => {
      expect(reorderWithinColumn(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    });

    it("前へ移動できる", () => {
      expect(reorderWithinColumn(["a", "b", "c", "d"], "d", 1)).toEqual(["a", "d", "b", "c"]);
    });

    it("先頭へ移動できる", () => {
      expect(reorderWithinColumn(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    });

    it("末尾へ移動できる", () => {
      expect(reorderWithinColumn(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    });

    it("同じ位置への移動は元の並びのままにする", () => {
      expect(reorderWithinColumn(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    });

    it("要素数を超える index は末尾に丸める", () => {
      expect(reorderWithinColumn(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    });

    it("負の index は先頭に丸める", () => {
      expect(reorderWithinColumn(["a", "b", "c"], "c", -5)).toEqual(["c", "a", "b"]);
    });

    it("1件しかない列では何も変わらない", () => {
      expect(reorderWithinColumn(["a"], "a", 0)).toEqual(["a"]);
    });

    it("列に存在しない id を渡しても列を壊さない", () => {
      expect(reorderWithinColumn(["a", "b"], "zzz", 0)).toEqual(["a", "b"]);
    });

    it("入力配列を破壊しない（呼び出し元の state をそのまま渡せる）", () => {
      const input = ["a", "b", "c"];
      reorderWithinColumn(input, "a", 2);
      expect(input).toEqual(["a", "b", "c"]);
    });
  });

  describe("moveAcrossColumns", () => {
    it("移動元から取り除き、移動先の指定位置へ挿入する", () => {
      expect(moveAcrossColumns(["a", "b", "c"], ["x", "y"], "b", 1)).toEqual({
        from: ["a", "c"],
        to: ["x", "b", "y"],
      });
    });

    it("空の列へも移動できる（空の列がドロップ先になる要件）", () => {
      expect(moveAcrossColumns(["a"], [], "a", 0)).toEqual({ from: [], to: ["a"] });
    });

    it("移動先の先頭へ挿入できる", () => {
      expect(moveAcrossColumns(["a"], ["x", "y"], "a", 0)).toEqual({
        from: [],
        to: ["a", "x", "y"],
      });
    });

    it("移動先の末尾へ挿入できる", () => {
      expect(moveAcrossColumns(["a"], ["x", "y"], "a", 2)).toEqual({
        from: [],
        to: ["x", "y", "a"],
      });
    });

    it("要素数を超える index は末尾に丸める", () => {
      expect(moveAcrossColumns(["a"], ["x"], "a", 99)).toEqual({ from: [], to: ["x", "a"] });
    });

    it("負の index は先頭に丸める", () => {
      expect(moveAcrossColumns(["a"], ["x"], "a", -3)).toEqual({ from: [], to: ["a", "x"] });
    });

    it("移動元に存在しない id を渡しても、どちらの列も壊さない", () => {
      expect(moveAcrossColumns(["a"], ["x"], "zzz", 0)).toEqual({ from: ["a"], to: ["x"] });
    });

    it("移動先に既に同じ id がある場合は重複させない（二重ドロップ等の防御）", () => {
      expect(moveAcrossColumns(["a", "b"], ["a", "x"], "a", 1)).toEqual({
        from: ["b"],
        to: ["x", "a"],
      });
    });

    it("入力配列を破壊しない", () => {
      const from = ["a", "b"];
      const to = ["x"];
      moveAcrossColumns(from, to, "a", 0);
      expect(from).toEqual(["a", "b"]);
      expect(to).toEqual(["x"]);
    });
  });
});
