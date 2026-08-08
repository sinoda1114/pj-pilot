/**
 * Server Actions 共通のランタイム入力検証（公開前セキュリティ監査の指摘）。
 *
 * **Server Actions は直接呼び出せる公開エンドポイント**であり、TypeScript の型注釈は
 * 実行時には消える。画面のフォームが送らない値でも、攻撃者は任意の JSON を POST できる。
 *
 * 監査では 14 個の Server Action のうち 13 個で `projectId` が型注釈だけで受けられており、
 * オブジェクトを渡すと drizzle/libSQL の層まで到達して未捕捉例外（500）になることを
 * 実測した。個々の action に検証を書き足すと必ず抜けが出るため、ここに集約して
 * 「ID を受け取る全ての入口で同じ関数を通す」形にする。
 */

/** ランタイム検証に失敗したときのエラー。ドメインエラー（`ActionResult.ok=false`）として扱う。 */
export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

/**
 * ID の最大長。実際に使う cuid2 は 24 文字だが、`scripts/seed.ts` 由来の
 * `"seed-owner"` のような文字列 ID も存在するため、形式ではなく長さだけで縛る。
 * 巨大な文字列をそのまま SQL のパラメータに載せないことが目的。
 */
const MAX_ID_LENGTH = 64;

/**
 * 制御文字（NUL・その他の C0 と DEL）。
 *
 * NUL を弾く理由: `String.prototype.trim()` は NUL を空白として扱わないため
 * `title = "\u0000"` は「必須」検証を通過するが、libSQL/SQLite は C 文字列として
 * 扱うので保存時に NUL 以降が切り捨てられ、**DB には空文字列が入る**（実測で確認）。
 * つまり「検証した文字列」と「保存された文字列」が食い違い、必須制約が無効化される。
 * タブ・改行（`\t` `\n` `\r`）は説明欄で正当に使えるため除外しない。
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * ID として受け取った値を検証して返す。
 *
 * `label` は利用者向けメッセージには使わない（「タスクが見つかりません」等に丸めて
 * ID の存在を推測させないため）。開発時に**どの引数が落ちたか**を追えるようにするための
 * 識別子で、メッセージは一律「不正な入力です」に揃える。
 */
export function assertValidId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ActionInputError(`不正な入力です（${label}）`);
  }
  if (value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new ActionInputError(`不正な入力です（${label}）`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new ActionInputError(`不正な入力です（${label}）`);
  }
  return value;
}

/**
 * 自由入力のテキストを検証して trim して返す。
 *
 * `required` が false のときは空文字を許し、呼び出し側で `null` への丸めを判断する。
 */
export function assertValidText(
  value: unknown,
  options: {
    label: string;
    maxLength: number;
    required: boolean;
    /** 未入力時のメッセージ。既存の文言を変えたくない呼び出し元のための上書き。 */
    requiredMessage?: string;
  },
): string {
  if (typeof value !== "string") {
    throw new ActionInputError(options.requiredMessage ?? `${options.label}の形式が不正です`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new ActionInputError(`${options.label}に使用できない文字が含まれています`);
  }
  const trimmed = value.trim();
  if (options.required && trimmed.length === 0) {
    throw new ActionInputError(options.requiredMessage ?? `${options.label}を入力してください`);
  }
  if (trimmed.length > options.maxLength) {
    throw new ActionInputError(`${options.label}は${options.maxLength}文字以内で入力してください`);
  }
  return trimmed;
}
