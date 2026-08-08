/**
 * カンバンボード画面（Phase 2 M8 #42）。
 *
 * `app/projects/[id]/tasks/page.tsx` と同じく、Server Component は認可とデータ取得だけを行い、
 * 描画・D&D は `BoardClient`（Client Component）に委譲する。
 */
import { notFound } from "next/navigation";
import { requireLogin } from "../../../../lib/auth/authz";
import { getSession } from "../../../../lib/auth/session";
import { listBoardTasks } from "../../../../lib/board/service";
import { db } from "../../../../lib/db";
import { getActiveProject } from "../../../../lib/db/queries";
import { NotFoundError } from "../../../../lib/errors";
import { listTaskAssignees } from "../../../../lib/tasks/assignees";
import { BoardClient } from "./BoardClient";

export default async function ProjectBoardPage({ params }: { params: Promise<{ id: string }> }) {
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

  let boardTasks: Awaited<ReturnType<typeof listBoardTasks>>;
  try {
    boardTasks = await listBoardTasks(db, session, projectId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }

  const assigneeLists = await Promise.all(
    boardTasks.map((task) => listTaskAssignees(db, session, task.id)),
  );

  const assigneesByTaskId: Record<string, string[]> = {};
  boardTasks.forEach((task, index) => {
    assigneesByTaskId[task.id] = (assigneeLists[index] ?? []).map((row) => row.userId);
  });

  return (
    <BoardClient projectId={projectId} tasks={boardTasks} assigneesByTaskId={assigneesByTaskId} />
  );
}
