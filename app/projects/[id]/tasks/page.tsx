/**
 * タスク一覧画面（M2 #14〜#17）。Server Component としてデータ取得のみを行い、
 * 描画・インタラクションは `TasksPageClient`（Client Component）に委譲する。
 */
import { notFound } from "next/navigation";
import { requireLogin } from "../../../../lib/auth/authz";
import { getSession } from "../../../../lib/auth/session";
import { db } from "../../../../lib/db";
import { getActiveProject } from "../../../../lib/db/queries";
import { NotFoundError } from "../../../../lib/errors";
import { listTaskAssignees } from "../../../../lib/tasks/assignees";
import { listTasks } from "../../../../lib/tasks/service";
import { TasksPageClient } from "./TasksPageClient";

export default async function ProjectTasksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;
  const session = await getSession();
  // 認可を最初に通す。`getActiveProject` が先だと、未ログインでも DB 照会が走り、
  // `notFound()` になるかどうかの差から「その PJ ID が実在してアクティブか」を
  // 判別できてしまう（監査で実測）。gantt / trash / settings の各ページと揃える。
  requireLogin(session);

  const project = await getActiveProject(db, projectId);
  if (!project) {
    notFound();
  }

  let taskList: Awaited<ReturnType<typeof listTasks>>;
  try {
    taskList = await listTasks(db, session, projectId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }

  const assigneeLists = await Promise.all(
    taskList.map((task) => listTaskAssignees(db, session, task.id)),
  );

  const assigneesByTaskId: Record<string, string[]> = {};
  taskList.forEach((task, index) => {
    assigneesByTaskId[task.id] = (assigneeLists[index] ?? []).map((row) => row.userId);
  });

  return (
    <TasksPageClient projectId={projectId} tasks={taskList} assigneesByTaskId={assigneesByTaskId} />
  );
}
