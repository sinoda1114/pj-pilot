"use client";

/**
 * ゴミ箱一覧テーブル（Client Component）。
 *
 * 注意: Next.js 16 + Turbopack のこのリポジトリでは、Mantine のコンパウンドコンポーネント
 * （ドット記法 `Component.Sub`）の静的プロパティが実描画時に `undefined` になり
 * "Element type is invalid" で 500 になる不具合を実機確認済み。そのため `DataTable` を含め
 * ここで使う全コンポーネントはドット記法を使わないフラットな named export のみを使う。
 */
import { useState, useTransition } from "react";
import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { DataTable, type DataTableColumn } from "mantine-datatable";
import type { InferSelectModel } from "drizzle-orm";
import { priorityLabel, statusLabel } from "../../../../lib/labels";
import type { tasks } from "../../../../lib/db/schema";
import { restoreTaskAction } from "./actions";

type Priority = InferSelectModel<typeof tasks>["priority"];
type Status = InferSelectModel<typeof tasks>["status"];

export interface TrashTaskRow {
  id: string;
  title: string;
  priority: Priority;
  status: Status;
  /** 表示用に整形済みの文字列（page.tsx 側でフォーマットして渡す）。 */
  deletedAtLabel: string;
}

export function TrashTable({ projectId, rows }: { projectId: string; rows: TrashTaskRow[] }) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Server Action の revalidatePath によりサーバから最新の一覧が再取得されるが、
  // それを待たずに即座に一覧から消すため、復元済みIDをここでも保持する
  // （e2e で「復元ボタンで一覧から消える」ことを待ち時間なしに検証できるようにするため）。
  const [restoredIds, setRestoredIds] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  const visibleRows = rows.filter((row) => !restoredIds.has(row.id));

  function handleRestore(taskId: string) {
    setPendingId(taskId);
    startTransition(async () => {
      try {
        const result = await restoreTaskAction(projectId, taskId);
        if (result.ok) {
          setRestoredIds((prev) => new Set(prev).add(taskId));
          notifications.show({ color: "green", message: "タスクを復元しました" });
        } else {
          notifications.show({
            color: "red",
            title: "復元に失敗しました",
            message: result.message,
          });
        }
      } finally {
        setPendingId(null);
      }
    });
  }

  const columns: DataTableColumn<TrashTaskRow>[] = [
    { accessor: "title", title: "タスク名" },
    {
      accessor: "status",
      title: "ステータス",
      render: (record) => statusLabel(record.status),
    },
    {
      accessor: "priority",
      title: "優先度",
      render: (record) => priorityLabel(record.priority),
    },
    { accessor: "deletedAtLabel", title: "削除日時" },
    {
      accessor: "actions",
      title: "",
      textAlign: "right",
      render: (record) => (
        <Button
          size="xs"
          variant="light"
          loading={isPending && pendingId === record.id}
          onClick={() => handleRestore(record.id)}
        >
          復元
        </Button>
      ),
    },
  ];

  return (
    // `TasksPageClient.tsx` と同じ理由（列に `width` を指定していないため、
    // 狭い画面幅で見出し文字が縦積みになる、M6 #35）で `minWidth` を与える。
    <DataTable<TrashTaskRow>
      withTableBorder
      withColumnBorders
      minHeight={160}
      style={{ minWidth: 600 }}
      idAccessor="id"
      records={visibleRows}
      noRecordsText="ゴミ箱は空です"
      columns={columns}
    />
  );
}
