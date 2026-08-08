/**
 * ダッシュボードのデータ取得（Phase 2 §6 / M9 #46〜#48）。
 *
 * 集計の計算そのものは `lib/dashboard/metrics.ts`（純粋関数）にある。
 * ここは「取得 → 純粋関数を適用 → 画面が使う形に整える」層に徹する。
 *
 * 決定 D-08 のとおり閲覧は全ログインユーザーに開いているため、
 * `requireLogin` のみでプロジェクトの絞り込みは行わない。
 */

import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import type { BoardStatus } from "../board/service";
import { listActiveProjects, listAllActiveTaskTypeTasks } from "../db/queries";
import type * as schema from "../db/schema";
import {
  computeProjectProgress,
  countByStatus,
  findOverdueTasks,
  type DashboardTask,
  type ProjectProgress,
} from "./metrics";

/** 期限超過の一覧に出す1行。どのプロジェクトのタスクか分かるように PJ 名を持たせる。 */
export interface OverdueTaskRow {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: BoardStatus;
  endDate: string;
}

export interface DashboardData {
  statusCounts: Record<BoardStatus, number>;
  overdueTasks: OverdueTaskRow[];
  projectProgress: ProjectProgress[];
}

/**
 * ダッシュボードに必要な集計を一度にまとめて返す。
 *
 * `today` は date-only 文字列（'YYYY-MM-DD'）。呼び出し側が
 * `todayInTimeZone("Asia/Tokyo")` で求めて渡す。ここで `new Date()` を呼ばないのは、
 * Vercel が UTC で動くため（§6.3 / 決定 P2-08）と、テストで日付を固定できるようにするため。
 */
export async function getDashboardData(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  today: string,
): Promise<DashboardData> {
  requireLogin(session);

  const [projectRows, taskRows] = await Promise.all([
    listActiveProjects(db),
    listAllActiveTaskTypeTasks(db),
  ]);

  const projectNameById = new Map(projectRows.map((project) => [project.id, project.name]));

  // クエリ側で type='task' と生存フィルタは済んでいるが、純粋関数は
  // 「渡された配列だけを見る」契約なので、型を合わせてそのまま渡す。
  const dashboardTasks: DashboardTask[] = taskRows.map((task) => ({
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    type: task.type,
    endDate: task.endDate,
  }));

  return {
    statusCounts: countByStatus(dashboardTasks),
    // プロジェクト名を付けるだけ。同名タスクがあっても取り違えないよう、
    // 突き合わせではなく id をそのまま持ち回る。
    overdueTasks: findOverdueTasks(dashboardTasks, today).map((task) => ({
      id: task.id,
      projectId: task.projectId,
      projectName: projectNameById.get(task.projectId) ?? "",
      title: task.title,
      status: task.status,
      endDate: task.endDate,
    })),
    projectProgress: computeProjectProgress(
      projectRows.map((project) => ({ id: project.id, name: project.name })),
      dashboardTasks,
    ),
  };
}
