"use client";

/**
 * プロジェクト配下（タスク / Gantt / ゴミ箱）のタブナビゲーション（M2 #13）。
 * 各タブは実体としては別ルートなので、`usePathname` で現在地を判定して
 * アクティブ表示だけ切り替える（Mantine 内部の選択状態には頼らない）。
 * タスク/Gantt/ゴミ箱の各画面は他エージェントが並行実装中のため、
 * リンク先が未実装（404）でも実害はない。
 */
import { TabsList, TabsTab, Tabs } from "@mantine/core";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { segment: "tasks", label: "タスク" },
  { segment: "gantt", label: "Gantt" },
  { segment: "trash", label: "ゴミ箱" },
] as const;

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const active =
    TABS.find((tab) => pathname.startsWith(`/projects/${projectId}/${tab.segment}`))?.segment ??
    "tasks";

  return (
    <Tabs value={active}>
      <TabsList>
        {TABS.map((tab) => (
          <TabsTab
            key={tab.segment}
            value={tab.segment}
            renderRoot={(rootProps) => (
              <Link href={`/projects/${projectId}/${tab.segment}`} {...rootProps} />
            )}
          >
            {tab.label}
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
  );
}
