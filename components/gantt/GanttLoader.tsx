"use client";

/**
 * SVAR Gantt をクライアント専用で組み込むための二段構え（M3 #20 / §2.4）。
 *
 * SVAR Gantt は DOM の実寸を測ってレイアウトを決めるため SSR できない。
 * App Router の Server Component から `next/dynamic(..., { ssr: false })` を
 * 直接使えないため、`"use client"` のこのファイルで一段挟んでから
 * `GanttView`（実体）を動的 import する。
 */
import { Center, Loader } from "@mantine/core";
import dynamic from "next/dynamic";
import type { DbDependencyLike, DbTaskLike } from "../../lib/gantt/transform";

const GanttView = dynamic(() => import("./GanttView").then((mod) => mod.GanttView), {
  ssr: false,
  loading: () => (
    <Center h={400}>
      <Loader />
    </Center>
  ),
});

export interface GanttLoaderProps {
  projectId: string;
  tasks: DbTaskLike[];
  dependencies: DbDependencyLike[];
}

export function GanttLoader({ projectId, tasks, dependencies }: GanttLoaderProps) {
  return <GanttView projectId={projectId} tasks={tasks} dependencies={dependencies} />;
}
