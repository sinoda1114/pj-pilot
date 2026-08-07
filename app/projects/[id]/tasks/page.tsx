/**
 * タスク一覧画面（M2 #14〜#17）。Server Component としてデータ取得のみを行い、
 * 描画・インタラクションは `TasksPageClient`（Client Component）に委譲する。
 */
import { notFound } from "next/navigation";
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
