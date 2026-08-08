/**
 * CSV 生成の純粋関数層。
 *
 * 「行の配列 + 列定義 → CSV 文字列」だけを担う。DB・React・DOM のいずれにも依存させない。
 * これは意図的な制約で、こうしておけばタスク一覧とダッシュボードという性質の違う
 * 2 画面から同じ関数を呼べるうえ、node 環境の vitest で表形式のテストを素直に書ける。
 * Blob 生成やダウンロードのトリガーといったブラウザ固有の副作用は、この層ではなく
 * 呼び出し側（クライアントコンポーネント）に置く。
 *
 * 書式は RFC 4180 に従う。
 * - フィールドにカンマ・ダブルクォート・CR・LF のいずれかを含む場合はダブルクォートで囲み、
 *   内側のダブルクォートは 2 つ重ねる。
 * - 行区切りは CRLF。
 */

/**
 * UTF-8 BOM（U+FEFF）。
 *
 * Excel は BOM の無い UTF-8 CSV を環境の既定コードページ（日本語 Windows なら CP932）
 * として読むため、日本語が文字化けする。一方で機械処理（スクリプトや別システムへの取り込み）
 * では BOM が余計な先頭バイトになり、1 列目のヘッダー名の比較を壊すことがある。
 * そのため BOM の付与は `toCsv` に含めず `withUtf8Bom` として分離し、
 * 「Excel で開く用途か、機械処理用途か」を呼び出し側が選べるようにしている。
 *
 * 値をリテラルの不可視文字ではなくエスケープ表記で書いているのは、
 * エディタや整形ツールに落とされても壊れないようにするため。
 */
export const UTF8_BOM = "\uFEFF";

const FIELD_SEPARATOR = ",";
const ROW_SEPARATOR = "\r\n";

/** エスケープが必要になる文字（カンマ / ダブルクォート / CR / LF）。 */
const NEEDS_QUOTING_PATTERN = /[",\r\n]/;

/**
 * 1 列の定義。ヘッダー名と、行から値を取り出す関数の組。
 *
 * `value` の戻り値に `null | undefined` を許すのは、DB のカラムが nullable
 * （`endDate` など）でも呼び出し側で `?? ""` を書かずに済ませるため。
 */
export interface CsvColumn<TRow> {
  header: string;
  value: (row: TRow) => string | number | null | undefined;
}

/**
 * 1 フィールドを RFC 4180 の規則でエスケープする。
 *
 * 値の中身そのものは書き換えない。`=` や `+` で始まる値を Excel が数式として解釈する
 * 問題（CSV インジェクション）は既知だが、ここで先頭に `'` を足すと機械処理側にとっては
 * データの改変になり、「画面に見えている値がそのまま出る」という本機能の前提も崩れる。
 * 対策が必要になった場合は、この層ではなく Excel 向け（BOM 付き）の出力経路に
 * 限定して入れる方が副作用が小さい。
 */
function escapeField(value: string): string {
  if (!NEEDS_QUOTING_PATTERN.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

/** null / undefined は空文字に、数値は 10 進表記の文字列にそろえる。 */
function stringifyValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "number" ? String(value) : value;
}

/**
 * 行の配列を CSV 文字列に変換する。
 *
 * 行が 0 件でもヘッダー行だけは返す。完全な空文字を返すと「取得に失敗した」のか
 * 「該当 0 件だった」のかを受け取った側が区別できないため。
 */
export function toCsv<TRow>(rows: readonly TRow[], columns: readonly CsvColumn<TRow>[]): string {
  const headerLine = columns.map((column) => escapeField(column.header)).join(FIELD_SEPARATOR);
  const bodyLines = rows.map((row) =>
    columns.map((column) => escapeField(stringifyValue(column.value(row)))).join(FIELD_SEPARATOR),
  );

  return [headerLine, ...bodyLines].join(ROW_SEPARATOR);
}

/**
 * CSV 文字列の先頭に UTF-8 BOM を付ける（Excel 向け）。
 * すでに BOM が付いている文字列を渡しても二重に付かない。
 */
export function withUtf8Bom(csv: string): string {
  return csv.startsWith(UTF8_BOM) ? csv : `${UTF8_BOM}${csv}`;
}

/**
 * `tasks-2026-08-08.csv` の形式でファイル名を組み立てる。
 *
 * `dateOnly` は 'YYYY-MM-DD'。呼び出し側は `todayInTimeZone("Asia/Tokyo")` の値を渡す。
 * Vercel のサーバーは UTC で動くため、素朴に日付を取ると JST の 0:00〜9:00 の間だけ
 * ファイル名が 1 日前になる（決定 P2-08 と同じ理由）。
 */
export function buildCsvFileName(prefix: string, dateOnly: string): string {
  return `${prefix}-${dateOnly}.csv`;
}
