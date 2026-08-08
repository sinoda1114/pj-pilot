/**
 * Server Actions 共通の入力検証のテスト（公開前セキュリティ監査の指摘）。
 *
 * ここで守りたいのは「型注釈だけでは守れないもの」なので、TypeScript が
 * 通さない値をわざと渡す。`as unknown` で型を外しているのは意図的で、
 * 実際に攻撃者が投げてくるのはまさにこの形。
 */
import { describe, expect, it } from "vitest";
import { ActionInputError, assertValidId, assertValidText } from "./input";

describe("assertValidId", () => {
  it("正常な文字列 ID はそのまま返す", () => {
    expect(assertValidId("ckjh2agb0uj6tkkt0h7790f4", "taskId")).toBe(
      "ckjh2agb0uj6tkkt0h7790f4",
    );
  });

  it.each([
    ["オブジェクト", {}],
    ["配列", ["a"]],
    ["数値", 1],
    ["null", null],
    ["undefined", undefined],
    ["真偽値", true],
  ])("%s は拒否する（drizzle まで到達させない）", (_label, value) => {
    expect(() => assertValidId(value, "taskId")).toThrow(ActionInputError);
  });

  it("空文字は拒否する", () => {
    expect(() => assertValidId("", "taskId")).toThrow(ActionInputError);
  });

  it("64文字を超える ID は拒否する（巨大な値を SQL パラメータに載せない）", () => {
    expect(() => assertValidId("a".repeat(64), "taskId")).not.toThrow();
    expect(() => assertValidId("a".repeat(65), "taskId")).toThrow(ActionInputError);
  });

  it("制御文字を含む ID は拒否する", () => {
    expect(() => assertValidId("abc\u0000def", "taskId")).toThrow(ActionInputError);
  });
});

describe("assertValidText", () => {
  const options = { label: "タイトル", maxLength: 10, required: true };

  it("前後の空白を落として返す", () => {
    expect(assertValidText("  あ  ", options)).toBe("あ");
  });

  /**
   * `trim()` は NUL を空白として扱わないため、素朴な必須チェックは通ってしまう。
   * ところが libSQL/SQLite は C 文字列として扱うので保存時に NUL 以降が切り捨てられ、
   * **DB には空文字列が入る**（監査で実測）。「検証した文字列」と「保存された文字列」が
   * 食い違うため、必須制約が実質無効化される。
   */
  it("NUL だけの文字列を拒否する（素朴な trim では必須チェックを通ってしまう）", () => {
    expect("\u0000".trim().length).toBe(1); // 前提の確認: trim では落ちない
    expect(() => assertValidText("\u0000", options)).toThrow(ActionInputError);
  });

  it("途中に NUL を含む文字列を拒否する（保存時に切り捨てられて別物になる）", () => {
    expect(() => assertValidText("見える\u0000見えない", options)).toThrow(ActionInputError);
  });

  it("タブ・改行は許可する（説明欄で正当に使える）", () => {
    expect(assertValidText("a\tb\nc", { ...options, maxLength: 100 })).toBe("a\tb\nc");
  });

  it("空文字は required のときだけ拒否する", () => {
    expect(() => assertValidText("   ", options)).toThrow(ActionInputError);
    expect(assertValidText("   ", { ...options, required: false })).toBe("");
  });

  it("requiredMessage を指定すると既存の文言を保てる", () => {
    expect(() =>
      assertValidText("", { ...options, requiredMessage: "タイトルは必須です" }),
    ).toThrow("タイトルは必須です");
  });

  it("trim 後の長さで上限を判定する", () => {
    expect(assertValidText(`  ${"a".repeat(10)}  `, options)).toBe("a".repeat(10));
    expect(() => assertValidText("a".repeat(11), options)).toThrow(ActionInputError);
  });

  it("文字列以外は拒否する", () => {
    expect(() => assertValidText(1 as unknown, options)).toThrow(ActionInputError);
    expect(() => assertValidText(null as unknown, options)).toThrow(ActionInputError);
  });
});
