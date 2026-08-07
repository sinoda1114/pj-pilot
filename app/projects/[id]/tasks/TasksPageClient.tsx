"use client";

/**
 * タスク一覧画面のクライアント側（M2 #14〜#17）。
 *
 * URL は変えず、Drawer の開閉・選択中タスクはこのコンポーネントのローカル state で
 * 管理する（intercepting routes 等は使わない簡易な方式でよいという指示に従う）。
 * フィルター・ソートも同様にローカル state で完結させ、`tasks`/`assigneesByTaskId` は
 * サーバーコンポーネント（`page.tsx`）から渡された最新データをそのまま使う。
 * 保存・削除の成功後は `router.refresh()` でサーバーコンポーネントを再実行し、
 * 最新の一覧を取り直す。
 */
import { Badge, Button, Group, Progress, Select, Stack, Text } from "@mantine/core";
import { DataTable, type DataTableColumn, type DataTableSortStatus } from "mantine-datatable";
import type { InferSelectModel } from "drizzle-orm";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { tasks } from "../../../../lib/db/schema";
import { priorityLabel, statusLabel } from "../../../../lib/labels";
import { TaskDrawer } from "../../../../components/tasks/TaskDrawer";

type Task = InferSelectModel<typeof tasks>;
type Priority = Task["priority"];
type Status = Task["status"];

const PRIORITY_VALUES = ["low", "medium", "high", "urgent"] as const;
const STATUS_VALUES = ["todo", "in_progress", "review", "done"] as const;

const STATUS_COLORS: Record<Status, string> = {
  todo: "gray",
  in_progress: "blue",
  review: "yellow",
  done: "green",
};

const PRIORITY_COLORS: Record<Priority, string> = {
  low: "gray",
  medium: "blue",
  high: "orange",
  urgent: "red",
};

type DrawerState = { mode: "create" } | { mode: "edit"; task: Task };

export interface TasksPageClientProps {
  projectId: string;
  tasks: Task[];
  assigneesByTaskId: Record<string, string[]>;
}

export function TasksPageClient({ projectId, tasks, assigneesByTaskId }: TasksPageClientProps) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [sortStatus, setSortStatus] = useState<DataTableSortStatus<Task>>({
    columnAccessor: "startDate",
    direction: "asc",
  });
  const [drawerState, setDrawerState] = useState<DrawerState | null>(null);

  const records = useMemo(() => {
    let rows = tasks;
    if (statusFilter !== "all") {
      rows = rows.filter((task) => task.status === statusFilter);
    }
    if (priorityFilter !== "all") {
      rows = rows.filter((task) => task.priority === priorityFilter);
    }

    const accessor = sortStatus.columnAccessor as keyof Task;
    const sorted = [...rows].sort((a, b) => {
      const aValue = a[accessor];
      const bValue = b[accessor];
      let comparison = 0;
      if (typeof aValue === "number" && typeof bValue === "number") {
        comparison = aValue - bValue;
      } else {
        comparison = String(aValue ?? "").localeCompare(String(bValue ?? ""));
      }
      return sortStatus.direction === "asc" ? comparison : -comparison;
    });

    return sorted;
  }, [tasks, statusFilter, priorityFilter, sortStatus]);

  const columns: DataTableColumn<Task>[] = [
    {
      accessor: "title",
      title: "タイトル",
      sortable: true,
    },
    {
      accessor: "status",
      title: "ステータス",
      sortable: true,
      render: (task) => (
        <Badge color={STATUS_COLORS[task.status]} variant="light">
          {statusLabel(task.status)}
        </Badge>
      ),
    },
    {
      accessor: "priority",
      title: "優先度",
      sortable: true,
      render: (task) => (
        <Badge color={PRIORITY_COLORS[task.priority]} variant="light">
          {priorityLabel(task.priority)}
        </Badge>
      ),
    },
    {
      accessor: "assignees",
      title: "担当者",
      render: (task) => {
        const userIds = assigneesByTaskId[task.id] ?? [];
        if (userIds.length === 0) {
          return (
            <Text size="sm" c="dimmed">
              未割当
            </Text>
          );
        }
        return (
          <Group gap={4} wrap="wrap">
            {userIds.map((userId) => (
              <Badge key={userId} variant="outline" color="gray">
                {userId}
              </Badge>
            ))}
          </Group>
        );
      },
    },
    {
      accessor: "startDate",
      title: "開始日",
      sortable: true,
    },
    {
      accessor: "endDate",
      title: "終了日",
      sortable: true,
    },
    {
      accessor: "progress",
      title: "進捗",
      sortable: true,
      render: (task) => (
        <Group gap="xs" wrap="nowrap">
          <Progress value={task.progress} size="sm" w={80} aria-label="進捗" />
          <Text size="sm">{task.progress}%</Text>
        </Group>
      ),
    },
  ];

  function handleDrawerClose() {
    setDrawerState(null);
  }

  function handleSaved() {
    setDrawerState(null);
    router.refresh();
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end">
        <Group>
          <Select
            label="ステータス"
            data={[
              { value: "all", label: "すべて" },
              ...STATUS_VALUES.map((value) => ({ value, label: statusLabel(value) })),
            ]}
            value={statusFilter}
            onChange={(value) => setStatusFilter(value ?? "all")}
            allowDeselect={false}
            w={180}
          />
          <Select
            label="優先度"
            data={[
              { value: "all", label: "すべて" },
              ...PRIORITY_VALUES.map((value) => ({ value, label: priorityLabel(value) })),
            ]}
            value={priorityFilter}
            onChange={(value) => setPriorityFilter(value ?? "all")}
            allowDeselect={false}
            w={180}
          />
        </Group>
        <Button onClick={() => setDrawerState({ mode: "create" })}>新規タスク作成</Button>
      </Group>

      {/*
        列数が多く（タイトル/ステータス/優先度/担当者/開始日/終了日/進捗の7列）、
        `width` を指定していないため、狭い画面幅では各列が個別に縮んで見出しの
        文字が1文字ずつ縦積みになり読めなくなる（実機のスクリーンショットで確認済み、
        M6 #35）。`mantine-datatable` の `style` は内部の `<table>` ではなく
        最外殻のルート要素（`ScrollArea` を含む）に適用されるため、そこに
        `minWidth` を与えるとルート自体が幅を持ってしまい、内部の
        `ScrollArea` ではなくページ全体が横スクロールしてしまう
        （Devin Reviewの指摘どおり、実機で `document.body.scrollWidth` が
        375→716 になることを確認済み）。`styles={{ table: {...} }}` で
        `<table>` 要素自体に `minWidth` を与えることで、`ScrollArea` の
        ビューポート幅（=ルート要素の幅、親に収まる）はそのままに、内部の
        テーブルだけが横に広がり、`ScrollArea` が正しく横スクロールを担う。
      */}
      <DataTable<Task>
        withTableBorder
        borderRadius="sm"
        highlightOnHover
        minHeight={200}
        styles={{ table: { minWidth: 700 } }}
        records={records}
        columns={columns}
        sortStatus={sortStatus}
        onSortStatusChange={setSortStatus}
        onRowClick={({ record }) => setDrawerState({ mode: "edit", task: record })}
        noRecordsText="タスクがありません"
      />

      <TaskDrawer
        key={drawerState?.mode === "edit" ? drawerState.task.id : drawerState?.mode ?? "closed"}
        opened={drawerState !== null}
        mode={drawerState?.mode ?? "create"}
        projectId={projectId}
        task={drawerState?.mode === "edit" ? drawerState.task : null}
        initialAssignees={
          drawerState?.mode === "edit" ? (assigneesByTaskId[drawerState.task.id] ?? []) : []
        }
        onClose={handleDrawerClose}
        onSaved={handleSaved}
      />
    </Stack>
  );
}
