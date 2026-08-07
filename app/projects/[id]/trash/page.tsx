/**
 * ゴミ箱画面（M1 #9c）。論理削除済み（`deleted_at IS NOT NULL`）タスクの一覧と復元。
 *
 * 決定 D-08: 閲覧は全ログインユーザーに開く。タスクの復元も全員可（決定 D-15、
 * PJ削除のような owner 限定ではない）ため、ここでは requireLogin のみを通す。
 */
import { notFound } from "next/navigation";
import { Stack, Title } from "@mantine/core";
import { requireLogin } from "../../../../lib/auth/authz";
import { getSession } from "../../../../lib/auth/session";
import { db } from "../../../../lib/db";
import { getActiveProject, listDeletedTasksByProject } from "../../../../lib/db/queries";
import { TrashTable, type TrashTaskRow } from "./TrashTable";

function formatDeletedAt(deletedAt: Date | null): string {
  if (!deletedAt) {
    return "-";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(deletedAt);
}

export default async function TrashPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;

  const session = await getSession();
  requireLogin(session);

  const project = await getActiveProject(db, projectId);
  if (!project) {
    notFound();
  }

  const deletedTasks = await listDeletedTasksByProject(db, projectId);
  const rows: TrashTaskRow[] = deletedTasks.map((task) => ({
    id: task.id,
    title: task.title,
    priority: task.priority,
    status: task.status,
    deletedAtLabel: formatDeletedAt(task.deletedAt),
  }));

  return (
    <Stack gap="md">
      <Title order={2}>{project.name} のゴミ箱</Title>
      <TrashTable projectId={projectId} rows={rows} />
    </Stack>
  );
}
