/**
 * プロジェクトの Gantt 画面（M3 #20）。Server Component としてデータ取得のみ行い、
 * 実際の描画は `GanttLoader`（"use client" + `next/dynamic(..., { ssr: false })`）に委ねる
 * （§2.4「Next.js App Router での組み込み」）。
 *
 * 依存線のドラッグ連動（M4 のスコープ）はここでは扱わない。既存タスクの階層・日付・
 * 依存線を描画するだけの読み取り専用ビュー。
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

  return <GanttLoader tasks={tasks} dependencies={dependencies} />;
}
