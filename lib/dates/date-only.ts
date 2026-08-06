/**
 * date-only（'YYYY-MM-DD'）文字列を扱う純粋関数群。
 *
 * 実装計画 §3.2 の規約により、日付は date-only の文字列として DB ↔ アプリ境界を横断させ、
 * タイムゾーン変換を一切行わない。ここでの加減算・差分計算も UTC 正午に固定した Date を
 * 経由することで、ローカルタイムゾーンの影響（DST や UTC オフセット）を受けないようにする。
 */

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' 形式かつ実在する日付かを検証する。 */
export function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = parseDateOnlyParts(value);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * 'YYYY-MM-DD' を [year, month, day] の数値タプルへ分解する。
 * 呼び出し側は事前に `isValidDateOnly` で検証済みの文字列を渡す前提だが、
 * `noUncheckedIndexedAccess` 下で `split` の要素は `number | undefined` になるため、
 * ここで一箇所だけ非 null アサーションをまとめて行う。
 */
function parseDateOnlyParts(dateOnly: string): [number, number, number] {
  const parts = dateOnly.split("-").map(Number);
  return [parts[0]!, parts[1]!, parts[2]!];
}

function toUtcNoon(dateOnly: string): Date {
  const [year, month, day] = parseDateOnlyParts(dateOnly);
  // 正午に固定するのは、日付境界付近の丸め誤差を避けるための保険（本来 UTC 固定なら不要だが、
  // 将来 Date 変換を挟むコードが紛れ込んでも 1 日ずれにくくする）。
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function toDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 暦日で `days` 日を加算する（決定 D-09: 稼働日換算はしない。土日もそのまま日数に含める）。
 * `days` に負数を渡すと前倒しになる。
 */
export function addDaysToDateOnly(dateOnly: string, days: number): string {
  const date = toUtcNoon(dateOnly);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateOnly(date);
}

/** `a` から `b` を引いた暦日の差分を返す（a - b）。 */
export function diffInCalendarDays(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((toUtcNoon(a).getTime() - toUtcNoon(b).getTime()) / msPerDay);
}
