/**
 * 生存レコード（`deleted_at IS NULL`）のみを返す問い合わせを集約する（§3.2 / §4.4(c)）。
 *
 * 論理削除の最大の事故は「絞り込みの書き忘れで削除済みが表示・伝播対象に入る」こと。
 * 画面や Server Action・service 層は素の `db.select()` をここ以外に書かず、必ずこのファイルを通す。
 */

import type { ResultSet } from "@libsql/client";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { projects, taskDependencies, tasks } from "./schema";
import type * as schema from "./schema";

/**
 * `LibSQLDatabase<typeof schema>` ではなくこの共通の基底型を使うのは、
 * `db.transaction(async (tx) => ...)` のコールバック引数 `tx` の型が
 * `LibSQLDatabase` ではなく `SQLiteTransaction`（`batch` を持たない）になるため。
 * ここで使うクエリはどちらの型にも共通する部分だけなので、両方から呼べるようにする。
 */
export type Db = BaseSQLiteDatabase<"async", ResultSet, typeof schema>;

export async function listActiveProjects(db: Db) {
  return db.select().from(projects).where(isNull(projects.deletedAt));
}

export async function getActiveProject(db: Db, projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);

  return project;
}

export async function getActiveTask(db: Db, taskId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    .limit(1);

  return task;
}

/** 復元時の祖先チェーン走査（§4.4(a)）では削除済みの行も見る必要があるため、生存フィルタをかけない。 */
export async function getTaskById(db: Db, taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

  return task;
}

/**
 * 生存・削除済みを問わず、`parentId` の直接の子を全て返す。
 *
 * 復元（`lib/tasks/deletion.ts` の `restoreTask`）が「同じ操作で消した子孫」を
 * 辿るために使う。`listActiveChildren` は生存のみを返すため、削除済みの子孫を
 * 見つけられない。
 */
export async function listChildrenIncludingDeleted(db: Db, parentId: string) {
  return db.select().from(tasks).where(eq(tasks.parentId, parentId));
}

export async function listActiveChildren(db: Db, parentId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.parentId, parentId), isNull(tasks.deletedAt)));
}

/**
 * 指定したプロジェクト内で、指定した `parentId` を持つ生存タスクを返す。
 * `listActiveChildren` と異なり `parentId` に `null` を渡すとルート直下
 * （`parent_id IS NULL`）の生存タスクを返す（SQL の `parent_id = NULL` は
 * 常に false になるため isNull で分岐する）。
 *
 * `projectId` を必須にしているのは、`parentId = null`（ルート直下）のケースだと
 * `parent_id` だけでは他プロジェクトのルートタスクと区別できないため。
 * これを付け忘れると、あるプロジェクトのルートタスクをインデントしたときに
 * 別プロジェクトのルートタスクが「直前の兄弟」として誤って選ばれ、
 * プロジェクトをまたいだ親子関係が生まれてしまう（レビューで発見・修正）。
 * indent/outdent（`lib/tasks/hierarchy.ts`）で「兄弟の特定」と
 * 「新しい親の子一覧取得」の両方に使う汎用ヘルパー。
 */
export async function listActiveTasksByParent(db: Db, projectId: string, parentId: string | null) {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        parentId === null ? isNull(tasks.parentId) : eq(tasks.parentId, parentId),
        isNull(tasks.deletedAt),
      ),
    );
}

export async function listActiveTasksByProject(db: Db, projectId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
}

/**
 * カンバンボード用（Phase 2 §5.2）。`type = 'task'` の生存タスクのみを、
 * 列内の表示順（`board_order` 昇順）で返す。
 *
 * `summary` は子の集計行なので二重計上になり、`milestone` は決定 D-12 により
 * Phase 1 の UI から作成できず実データが存在しないため、どちらも除外する（決定 P2-02）。
 *
 * 第2ソートキーに `id` を置くのは、`board_order` が同値になった場合
 * （並行更新の隙間や、バックフィル前のデータが紛れた場合）でも描画順が揺れないようにするため。
 * React の `key` の並びが安定し、ドラッグ中のちらつきを防ぐ。
 */
export async function listActiveBoardTasksByProject(db: Db, projectId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.type, "task"), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.boardOrder), asc(tasks.id));
}

/**
 * ダッシュボード用（Phase 2 §6.4）。**全プロジェクト横断**で `type = 'task'` の
 * 生存タスクを返す。
 *
 * 閲覧は全ログインユーザーに開いている（決定 D-08）ため、ユーザーによる絞り込みは
 * 行わない。ただし**削除済みプロジェクトのタスクは除く**。プロジェクトを論理削除しても
 * 配下のタスクの `deleted_at` が必ず立つとは限らず、タスク側だけを見ると
 * 「消したはずの PJ のタスクがダッシュボードに出続ける」ことになるため、
 * `projects` と結合して生存プロジェクトのものだけに絞る。
 */
export async function listAllActiveTaskTypeTasks(db: Db) {
  return db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      status: tasks.status,
      type: tasks.type,
      endDate: tasks.endDate,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.type, "task"), isNull(tasks.deletedAt), isNull(projects.deletedAt)));
}

/**
 * 依存連動の伝播（`lib/scheduling/propagate.ts`）用。生存/削除済みを問わず
 * プロジェクトの全タスクを返す。伝播ロジックは「削除済みタスクに到達したら
 * 枝を打ち切り、その理由をトーストで通知する」（決定D-06 / §5.4）ため、
 * 削除済みタスクも `isDeleted: true` として伝播対象のグラフに含めておく
 * 必要がある。生存タスクだけを渡すと、削除済みタスクがグラフから単に
 * 存在しなくなるだけで、`skipped` に理由付きで記録できなくなる。
 */
export async function listAllTasksByProject(db: Db, projectId: string) {
  return db.select().from(tasks).where(eq(tasks.projectId, projectId));
}

/**
 * `taskId` が「生存しているプロジェクト `projectId` に属する」ことを確認して返す。
 * 満たさなければ `undefined`。
 *
 * Server Action は URL 由来の `projectId` とクライアントから来た `taskId` を別々に
 * 受け取るため、両者の整合を明示的に確かめないと次の2つが起きる。
 *
 *   - **他プロジェクトのタスクを操作できる**（`projectId` を検証していないと
 *     `taskId` だけで到達できてしまう）。
 *   - **論理削除済みプロジェクトのタスクを操作できる**。PJ の削除は owner 限定だが
 *     （決定 D-15）、`deleteProject` は `projects.deleted_at` を立てるだけで配下の
 *     タスクには触れない。タスク側のヘルパー（`getActiveTask`）は `tasks.deleted_at`
 *     しか見ないため、owner が消して画面から見えなくなった PJ のタスクを、
 *     誰でも編集・削除・復元し続けられてしまう。
 *
 * **タスク自身の生存は見ない**（`tasks.deleted_at` でフィルタしない）。ゴミ箱からの
 * 復元（`restoreTaskAction`）が削除済みタスクを対象にするため。生存が必要な呼び出し側は
 * 従来どおり `getActiveTask` / service 層のチェックを併用すること（多層防御、§4.4(c)）。
 */
export async function getProjectScopedTask(db: Db, projectId: string, taskId: string) {
  const [row] = await db
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), isNull(projects.deletedAt)))
    .limit(1);

  return row?.task;
}

/**
 * `task_dependencies` に `deleted_at` は無い（決定 D-06: タスク削除時も依存レコード自体は残す）。
 * そのため生存フィルタは不要で、単純にプロジェクト単位で全件返す。
 *
 * **表示用には使わないこと。** 削除済みタスクを指す依存も返るため、画面へ渡すと
 * ゴミ箱の中のタスク ID がクライアントに露出する（`listActiveDependenciesByProject`
 * を使う）。伝播（削除済みの後続を「スキップした」と判定するために必要）と、
 * `deleteDependencyAction` の所属チェックだけがこちらを使う。
 */
export async function listDependenciesByProject(db: Db, projectId: string) {
  return db.select().from(taskDependencies).where(eq(taskDependencies.projectId, projectId));
}

/**
 * 表示用。**両端のタスクがどちらも生存している**依存だけを返す。
 *
 * Gantt ページはタスクを `listActiveTasksByProject`（生存のみ）で取るのに、依存だけ
 * 全件取っていた。そのため論理削除済みタスクを指すリンクがそのまま Client Component
 * へ渡り、①ゴミ箱の中のタスク ID が画面ソースに露出する、②SVAR に「存在しない
 * ノードを指すリンク」が渡る、の2つが起きていた（監査で実測）。SVAR 2.7.1 は
 * 宙吊りリンクを許容するので即座には壊れないが、リスク R-9 が想定する
 * 「絞り込みの書き忘れ」そのものなので、表示経路だけをここで絞る。
 */
export async function listActiveDependenciesByProject(db: Db, projectId: string) {
  const predecessor = alias(tasks, "predecessor");
  const successor = alias(tasks, "successor");

  const rows = await db
    .select({ dependency: taskDependencies })
    .from(taskDependencies)
    .innerJoin(predecessor, eq(taskDependencies.predecessorId, predecessor.id))
    .innerJoin(successor, eq(taskDependencies.successorId, successor.id))
    .where(
      and(
        eq(taskDependencies.projectId, projectId),
        isNull(predecessor.deletedAt),
        isNull(successor.deletedAt),
      ),
    );

  return rows.map((row) => row.dependency);
}

/**
 * ゴミ箱画面（M1 #9c）用。指定したプロジェクトの論理削除済み（`deleted_at IS NOT NULL`）
 * タスクのみを返す。生存タスクのみを返す他のヘルパーとは逆に、ここでは意図的に
 * 削除済みのものだけを絞り込む（§3.2 の「絞り込みの書き忘れ防止」の考え方を、
 * ゴミ箱という「削除済みだけを見せたい」画面にもそのまま適用する）。
 */
export async function listDeletedTasksByProject(db: Db, projectId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNotNull(tasks.deletedAt)));
}
