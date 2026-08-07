/**
 * プロジェクトの Gantt 画面（M3 #20 / M4 ドラッグ連動）。Server Component として
 * データ取得のみ行い、実際の描画・ドラッグ操作は `GanttLoader`（"use client" +
 * `next/dynamic(..., { ssr: false })`）以下に委ねる（§2.4）。
 */
import { notFound } from "next/navigation";
import { requireLogin } from "../../../../lib/auth/authz";
import { getSession } from "../../../../lib/auth/session";
import { db } from "../../../../lib/db";
import {
  getActiveProject,
  listActiveTasksByProject,
  listDependenciesByProject,
} from "../../../../lib/db/queries";
import { GanttLoader } from "../../../../components/gantt/GanttLoader";

export default async function ProjectGanttPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;

  const session = await getSession();
  requireLogin(session);

  const project = await getActiveProject(db, projectId);
  if (!project) {
    notFound();
  }

  const [tasks, dependencies] = await Promise.all([
    listActiveTasksByProject(db, project.id),
    listDependenciesByProject(db, project.id),
  ]);

  return <GanttLoader projectId={project.id} tasks={tasks} dependencies={dependencies} />;
}
