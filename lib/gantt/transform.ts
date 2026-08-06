/**
 * DB ↔ SVAR Gantt（@svar-ui/gantt-store@2.7.1）のデータ変換層（M3 #21）。
 *
 * §9 S-1（スパイクで実測・確定。2026-08-06）:
 * - SVAR の `end` は**排他**（終了日を含まない）。`@svar-ui/gantt-store` の
 *   `parseTaskDates` を実際に呼び出して確認した: `start=2026-08-01, end=2026-08-03`
 *   を渡すと `duration: 2` になり、`start=2026-08-01, duration=3` を渡すと
 *   `end: 2026-08-04` になった。`start === end`（同日）は `duration: 0`
 *   （ゼロ幅。1日タスクにはならない）。
 *   DB の `end_date` は**終了日を含む**方式（§3.2）のため、DB→SVAR 変換では
 *   終了日に +1日し、SVAR→DB 変換では -1日する。
 * - SVAR は `Date` オブジェクトをローカルタイムゾーンの日付コンポーネント
 *   （`getFullYear`/`getMonth`/`getDate`）で解釈する。`new Date(dateOnly文字列)`
 *   （UTC解釈）で組み立てると、UTCより西のタイムゾーン（米国等）では
 *   ブラウザ側で前日として描画されることを実測で確認した。そのため
 *   `new Date(year, month - 1, day)` のローカルコンストラクタで組み立てる。
 * - `parent` の未指定（ルート）は dhtmlx/svar 系ツリーの慣例に合わせて `0` を使う
 *   （このタスクIDは cuid2 文字列のため `0` と衝突しない）。
 */

import { addDaysToDateOnly } from "../dates/date-only";

export type GanttTaskType = "task" | "summary" | "milestone";

export interface DbTaskLike {
  id: string;
  parentId: string | null;
  title: string;
  /** 'YYYY-MM-DD'。終了日を含む方式（§3.2）。 */
  startDate: string;
  endDate: string;
  progress: number;
  type: GanttTaskType;
}

export interface DbDependencyLike {
  id: string;
  predecessorId: string;
  successorId: string;
}

export interface GanttTaskInput {
  id: string;
  parent: string | number;
  text: string;
  start: Date;
  end: Date;
  progress: number;
  type: GanttTaskType;
}

export interface GanttLinkInput {
  id: string;
  source: string;
  target: string;
  type: "e2s";
}

/** SVAR がルート扱いする sentinel（dhtmlx/svar 系ツリーの慣例）。 */
const GANTT_ROOT_PARENT = 0;

/** DB のタスク一覧を SVAR Gantt が受け取れる形へ変換する。 */
export function toGanttTasks(tasks: DbTaskLike[]): GanttTaskInput[] {
  return tasks.map((task) => ({
    id: task.id,
    parent: task.parentId ?? GANTT_ROOT_PARENT,
    text: task.title,
    start: dateOnlyToLocalDate(task.startDate),
    end: dateOnlyToLocalDate(addDaysToDateOnly(task.endDate, 1)),
    progress: task.progress,
    type: task.type,
  }));
}

/** DB の依存関係一覧を SVAR Gantt が受け取れる形へ変換する（初版は FS 固定＝"e2s"）。 */
export function toGanttLinks(dependencies: DbDependencyLike[]): GanttLinkInput[] {
  return dependencies.map((dep) => ({
    id: dep.id,
    source: dep.predecessorId,
    target: dep.successorId,
    type: "e2s",
  }));
}

/**
 * SVAR Gantt から受け取った開始日（`Date`）を DB の `start_date`（'YYYY-MM-DD'）へ戻す。
 * ドラッグ確定等で SVAR 側の `Date` を取り込む際に使う。
 */
export function fromGanttStartDate(start: Date): string {
  return localDateToDateOnly(start);
}

/**
 * SVAR Gantt から受け取った終了日（`Date`、排他）を DB の `end_date`
 * （'YYYY-MM-DD'、終了日を含む）へ戻す。
 */
export function fromGanttEndDate(end: Date): string {
  return addDaysToDateOnly(localDateToDateOnly(end), -1);
}

function dateOnlyToLocalDate(dateOnly: string): Date {
  // isValidDateOnly 済みの文字列を渡す前提のため、ここで非 null アサーションをまとめる
  // （lib/dates/date-only.ts の parseDateOnlyParts と同じ方針）。
  const parts = dateOnly.split("-").map(Number);
  const [year, month, day] = [parts[0]!, parts[1]!, parts[2]!];
  return new Date(year, month - 1, day);
}

function localDateToDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
