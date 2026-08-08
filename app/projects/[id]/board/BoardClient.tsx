"use client";

/**
 * カンバンボードのクライアント側（Phase 2 M8 #42・#43）。
 *
 * dnd-kit（`@dnd-kit/core` + `@dnd-kit/sortable`）で列間の移動と列内の並び替えを行う。
 * ドロップ確定でローカル state を先に更新（楽観更新）し、Server Action が失敗したら
 * 元に戻して通知する。
 *
 * 並び替えの計算は `lib/board/order.ts` の純粋関数を使い、ここでは再実装しない。
 * サーバー側（`lib/board/service.ts`）と同じ関数を通すことで、楽観更新の結果と
 * サーバーの確定結果がずれないようにする。
 */

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Badge, Card, Group, Paper, Progress, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { InferSelectModel } from "drizzle-orm";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { TaskDrawer } from "../../../../components/tasks/TaskDrawer";
import { moveAcrossColumns, reorderWithinColumn } from "../../../../lib/board/order";
import {
  BOARD_COLUMN_ORDER,
  BOARD_STATUSES,
  type BoardStatus,
} from "../../../../lib/board/service";
import type { tasks } from "../../../../lib/db/schema";
import { priorityLabel, statusLabel } from "../../../../lib/labels";
import { moveTaskOnBoardAction } from "./actions";

type Task = InferSelectModel<typeof tasks>;
type Priority = Task["priority"];

const STATUS_COLORS: Record<BoardStatus, string> = {
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

/** 列の最小幅。4列が入りきらない画面幅では、この幅を保ったまま横スクロールさせる。 */
const COLUMN_WIDTH = 280;

export interface BoardClientProps {
  projectId: string;
  tasks: Task[];
  assigneesByTaskId: Record<string, string[]>;
}

export function BoardClient({
  projectId,
  tasks: initialTasks,
  assigneesByTaskId,
}: BoardClientProps) {
  const router = useRouter();
  // 楽観更新のためにサーバーから渡された一覧をローカルに持つ。
  // 保存が成功したら router.refresh() でサーバー側を取り直し、失敗したらここを巻き戻す。
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  // `router.refresh()` で Server Component が再実行されると新しい `initialTasks` が
  // props で降ってくる。ローカル state をそれに追随させないと、DB は更新済みなのに
  // カードが古い内容（Drawer で変更する前のタイトル等）のまま残る
  // （Cursor Bugbot の指摘。E2E で実際に再現してから修正した）。
  //
  // useEffect ではなく描画中に調整するのは React 公式が推奨する形
  // （"You Might Not Need an Effect" の「props が変わったときに state を調整する」）。
  // useEffect だと一度古い内容で描画してから上書きすることになり、ちらつく。
  // Server Component は再実行のたびに新しい配列を返すため、参照比較で判定できる。
  const [syncedTasks, setSyncedTasks] = useState<Task[]>(initialTasks);
  if (syncedTasks !== initialTasks) {
    setSyncedTasks(initialTasks);
    setTasks(initialTasks);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // クリック（カードを開く操作）とドラッグを区別する。この距離を超えて初めて
      // ドラッグ開始とみなす。0 のままだと Drawer が開けなくなる。
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  /** 列ごとの id 配列。board_order 昇順（サーバーの並びをそのまま保持している）。 */
  const columns = useMemo(() => {
    const result = {} as Record<BoardStatus, string[]>;
    for (const status of BOARD_STATUSES) {
      result[status] = tasks.filter((task) => task.status === status).map((task) => task.id);
    }
    return result;
  }, [tasks]);

  /** ドロップ先の列を求める。カードの上に落ちた場合はそのカードが属する列を使う。 */
  function resolveTargetColumn(overId: string): BoardStatus | null {
    if ((BOARD_STATUSES as readonly string[]).includes(overId)) {
      return overId as BoardStatus;
    }
    return tasksById.get(overId)?.status ?? null;
  }

  /** ローカル state を、指定した列の並びで作り直す。 */
  function applyColumnOrder(
    current: Task[],
    updates: { status: BoardStatus; ids: string[] }[],
  ): Task[] {
    const patched = new Map<string, Task>();
    for (const { status, ids } of updates) {
      ids.forEach((id, index) => {
        const task = current.find((row) => row.id === id);
        if (task) {
          patched.set(id, { ...task, status, boardOrder: index });
        }
      });
    }
    return current
      .map((task) => patched.get(task.id) ?? task)
      .sort(
        (a, b) =>
          BOARD_COLUMN_ORDER[a.status] - BOARD_COLUMN_ORDER[b.status] ||
          a.boardOrder - b.boardOrder ||
          a.id.localeCompare(b.id),
      );
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveTaskId(null);

    const { active, over } = event;
    if (!over) {
      return;
    }

    const taskId = String(active.id);
    const task = tasksById.get(taskId);
    const toStatus = resolveTargetColumn(String(over.id));
    if (!task || !toStatus) {
      return;
    }

    const fromStatus = task.status as BoardStatus;
    const overId = String(over.id);
    // 列そのものに落ちた場合は末尾へ、カードの上に落ちた場合はそのカードの位置へ。
    const toIndex = (BOARD_STATUSES as readonly string[]).includes(overId)
      ? columns[toStatus].length
      : columns[toStatus].indexOf(overId);

    const snapshot = tasks;
    let optimistic: Task[];

    if (fromStatus === toStatus) {
      const after = reorderWithinColumn(columns[fromStatus], taskId, toIndex);
      if (after.join() === columns[fromStatus].join()) {
        return;
      }
      optimistic = applyColumnOrder(tasks, [{ status: fromStatus, ids: after }]);
    } else {
      const { from, to } = moveAcrossColumns(
        columns[fromStatus],
        columns[toStatus],
        taskId,
        toIndex,
      );
      optimistic = applyColumnOrder(tasks, [
        { status: fromStatus, ids: from },
        { status: toStatus, ids: to },
      ]);
    }

    setTasks(optimistic);

    const normalizedIndex = optimistic
      .filter((row) => row.status === toStatus)
      .findIndex((row) => row.id === taskId);
    const result = await moveTaskOnBoardAction(projectId, taskId, toStatus, normalizedIndex);

    if (!result.ok) {
      // 失敗したら楽観更新を巻き戻す。サーバー側は何も変わっていない。
      setTasks(snapshot);
      notifications.show({ color: "red", title: "移動できませんでした", message: result.message });
      return;
    }

    router.refresh();
  }

  const activeTask = activeTaskId ? tasksById.get(activeTaskId) : null;

  return (
    <Stack gap="md">
      <DndContext
        // 明示的な id を渡す。省略すると内部の useId 由来の識別子が SSR と
        // クライアントでずれ、ハイドレーション警告の原因になる。
        id="project-board"
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(event: DragStartEvent) => setActiveTaskId(String(event.active.id))}
        onDragCancel={() => setActiveTaskId(null)}
        onDragEnd={handleDragEnd}
      >
        <Group align="flex-start" gap="md" wrap="nowrap" style={{ overflowX: "auto" }}>
          {BOARD_STATUSES.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              taskIds={columns[status]}
              tasksById={tasksById}
              assigneesByTaskId={assigneesByTaskId}
              onCardClick={setEditingTask}
            />
          ))}
        </Group>

        <DragOverlay>
          {activeTask ? (
            <TaskCardBody
              task={activeTask}
              assignees={assigneesByTaskId[activeTask.id] ?? []}
              dragging
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <TaskDrawer
        key={editingTask?.id ?? "closed"}
        opened={editingTask !== null}
        mode="edit"
        projectId={projectId}
        task={editingTask}
        initialAssignees={editingTask ? (assigneesByTaskId[editingTask.id] ?? []) : []}
        onClose={() => setEditingTask(null)}
        onSaved={() => {
          setEditingTask(null);
          router.refresh();
        }}
      />
    </Stack>
  );
}

function BoardColumn({
  status,
  taskIds,
  tasksById,
  assigneesByTaskId,
  onCardClick,
}: {
  status: BoardStatus;
  taskIds: string[];
  tasksById: Map<string, Task>;
  assigneesByTaskId: Record<string, string[]>;
  onCardClick: (task: Task) => void;
}) {
  // 列そのものを droppable にする。SortableContext は items が空だとドロップ判定を
  // 持たないため、これが無いと「空の列へは移動できない」という不具合になる。
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <Paper
      ref={setNodeRef}
      withBorder
      p="sm"
      data-testid={`board-column-${status}`}
      style={{
        width: COLUMN_WIDTH,
        minWidth: COLUMN_WIDTH,
        alignSelf: "stretch",
        backgroundColor: isOver ? "var(--mantine-color-default-hover)" : undefined,
      }}
    >
      <Group justify="space-between" mb="sm">
        <Title order={4} size="h6">
          {statusLabel(status)}
        </Title>
        <Badge color={STATUS_COLORS[status]} variant="light">
          {taskIds.length}
        </Badge>
      </Group>

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <Stack gap="xs" mih={80}>
          {taskIds.length === 0 ? (
            <Text size="sm" c="dimmed">
              タスクがありません
            </Text>
          ) : (
            taskIds.map((id) => {
              const task = tasksById.get(id);
              return task ? (
                <SortableTaskCard
                  key={id}
                  task={task}
                  assignees={assigneesByTaskId[id] ?? []}
                  onClick={() => onCardClick(task)}
                />
              ) : null;
            })
          )}
        </Stack>
      </SortableContext>
    </Paper>
  );
}

function SortableTaskCard({
  task,
  assignees,
  onClick,
}: {
  task: Task;
  assignees: string[];
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  return (
    <div
      ref={setNodeRef}
      // testid は**この外側の要素**に付ける。dnd-kit の `attributes`（role/tabIndex）と
      // `listeners`（キーボード・ポインタ）が付いているのはここなので、内側の Card に
      // 付けると focus してもキーボード操作がドラッグとして認識されない
      // （E2E がキーボード D&D で駆動するため、ここを取り違えると全く動かない）。
      data-testid="board-card"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // ドラッグ中の実体は DragOverlay 側に出すので、元の位置は薄く残す。
        opacity: isDragging ? 0.4 : 1,
      }}
      {...attributes}
      {...listeners}
      onClick={onClick}
    >
      <TaskCardBody task={task} assignees={assignees} />
    </div>
  );
}

function TaskCardBody({
  task,
  assignees,
  dragging = false,
}: {
  task: Task;
  assignees: string[];
  dragging?: boolean;
}) {
  return (
    <Card withBorder padding="sm" shadow={dragging ? "md" : undefined}>
      <Stack gap={6}>
        <Text size="sm" fw={600} lineClamp={2}>
          {task.isPinned ? "📌 " : ""}
          {task.title}
        </Text>

        <Group gap="xs">
          <Badge size="sm" color={PRIORITY_COLORS[task.priority]} variant="light">
            {priorityLabel(task.priority)}
          </Badge>
          <Text size="xs" c="dimmed">
            {task.startDate} 〜 {task.endDate}
          </Text>
        </Group>

        <Progress value={task.progress} size="sm" aria-label={`進捗 ${task.progress}%`} />

        {assignees.length > 0 ? (
          <Text size="xs" c="dimmed" lineClamp={1}>
            {assignees.join(", ")}
          </Text>
        ) : null}
      </Stack>
    </Card>
  );
}
