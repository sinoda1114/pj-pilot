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
 *
 * 絞り込み（優先度・担当者）の判定も `lib/board/filter.ts` の純粋関数に寄せてある。
 * ここで持つのは「選択された値の state」と「その結果をどう描画するか」だけ。
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
import {
  Badge,
  Button,
  Card,
  Group,
  MultiSelect,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { InferSelectModel } from "drizzle-orm";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { TaskDrawer } from "../../../../components/tasks/TaskDrawer";
import {
  UNASSIGNED_ASSIGNEE,
  filterBoardTasks,
  isBoardFilterActive,
  listAssigneeOptions,
  type BoardFilterCriteria,
} from "../../../../lib/board/filter";
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

/**
 * 絞り込みの選択肢に出す優先度。低→緊急の順に並べる。
 * 値は DB の enum のまま持ち、表示だけ `priorityLabel()` の日本語にする（決定 D-17）。
 */
const PRIORITY_VALUES = ["low", "medium", "high", "urgent"] as const satisfies readonly Priority[];

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
  //
  // ただし**移動の確定待ちの間は同期しない**。連続してドラッグしたとき、前の移動の
  // router.refresh() が後の移動の確定より先に着地することがあり、そのまま同期すると
  // 楽観更新が「移動前のサーバー状態」で上書きされてカードが一瞬戻る
  // （Cursor Bugbot の2回目の指摘。上の同期を入れたことで生まれた競合）。
  // 確定待ちが 0 に戻った時点で再描画が走り、そのとき最新の props と同期される。
  const [pendingMoveCount, setPendingMoveCount] = useState(0);
  const [syncedTasks, setSyncedTasks] = useState<Task[]>(initialTasks);
  if (pendingMoveCount === 0 && syncedTasks !== initialTasks) {
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

  // 絞り込み条件。既存のタスク一覧（TasksPageClient.tsx）と同じくローカル state で持ち、
  // URL には載せない。
  const [priorityFilter, setPriorityFilter] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  /**
   * 列ごとの id 配列。board_order 昇順（サーバーの並びをそのまま保持している）。
   *
   * **絞り込みの影響を受けない「その列の全タスク」**であることが重要。
   * D&D の `toIndex` はここから算出する（`handleDragEnd` のコメント参照）。
   */
  const columns = useMemo(() => {
    const result = {} as Record<BoardStatus, string[]>;
    for (const status of BOARD_STATUSES) {
      result[status] = tasks.filter((task) => task.status === status).map((task) => task.id);
    }
    return result;
  }, [tasks]);

  const criteria = useMemo<BoardFilterCriteria>(
    () => ({ priorities: priorityFilter, assignees: assigneeFilter }),
    [priorityFilter, assigneeFilter],
  );
  const filtering = isBoardFilterActive(criteria);

  /** 絞り込みを通過したタスク。件数表示にも使う。 */
  const visibleTasks = useMemo(
    () => filterBoardTasks(tasks, criteria, assigneesByTaskId),
    [tasks, criteria, assigneesByTaskId],
  );

  /**
   * 実際に描画する列ごとの id 配列（＝絞り込み後）。
   *
   * `columns` とは**別に**持つ。描画とバッジの件数はこちらを使い、
   * D&D の位置計算は `columns`（全件）だけを使う、という分担にしている。
   */
  const visibleColumns = useMemo(() => {
    const visibleIds = new Set(visibleTasks.map((task) => task.id));
    const result = {} as Record<BoardStatus, string[]>;
    for (const status of BOARD_STATUSES) {
      result[status] = columns[status].filter((id) => visibleIds.has(id));
    }
    return result;
  }, [columns, visibleTasks]);

  /** 担当者の選択肢。そのプロジェクトのタスクに実際に割り当てられている人だけを出す。 */
  const assigneeOptions = useMemo(
    () => [
      { value: UNASSIGNED_ASSIGNEE, label: "担当者なし" },
      ...listAssigneeOptions(tasks, assigneesByTaskId).map((userId) => ({
        value: userId,
        label: userId,
      })),
    ],
    [tasks, assigneesByTaskId],
  );

  function clearFilters() {
    setPriorityFilter([]);
    setAssigneeFilter([]);
  }

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
    //
    // **絞り込み中でも必ず `columns`（絞り込み前の全件）から index を取ること。**
    // `visibleColumns`（見た目の並び）から取ると、隠れているカードの分だけ位置が
    // 詰まった index になり、サーバーには「絞り込みを解除したときの位置」として
    // 別の場所が保存されてしまう。
    //
    // ドロップ先 `overId` は必ず「表示中のカードの id」か「列の id」のどちらかで、
    // 表示中のカードは当然その列の全件にも含まれる。したがって
    // `columns[toStatus].indexOf(overId)` は常に見つかり、しかもそれは
    // 「掴んだカードを、そのカードが今いる絶対位置へ置く」という意図どおりの値になる。
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

    // サーバーへ渡す位置。`optimistic` は絞り込みを通していない全件なので、
    // ここで求まる index も「その列の全タスクの中での位置」になる。
    const normalizedIndex = optimistic
      .filter((row) => row.status === toStatus)
      .findIndex((row) => row.id === taskId);

    // 確定待ちの間は props との同期を止める（上の pendingMoveCount のコメント参照）。
    // finally で必ず戻すこと。戻し忘れると props の変更が二度と反映されなくなる。
    setPendingMoveCount((count) => count + 1);
    try {
      const result = await moveTaskOnBoardAction(projectId, taskId, toStatus, normalizedIndex);

      if (!result.ok) {
        // 失敗したら楽観更新を巻き戻す。サーバー側は何も変わっていない。
        setTasks(snapshot);
        notifications.show({
          color: "red",
          title: "移動できませんでした",
          message: result.message,
        });
        return;
      }

      router.refresh();
    } finally {
      setPendingMoveCount((count) => count - 1);
    }
  }

  const activeTask = activeTaskId ? tasksById.get(activeTaskId) : null;

  return (
    <Stack gap="md">
      <Group align="flex-end" gap="md" wrap="wrap">
        {/*
          `placeholder` を選択が無いときだけに絞っているのは、Mantine の MultiSelect が
          選択済みの Pill があっても placeholder を出し続け、「すべて」と選択中の値が
          並んで見えてしまうため。
        */}
        {/*
          両方の MultiSelect に `searchable` を付けて挙動を揃えている。
          Mantine の MultiSelect は `searchable` でないと、値を選んだ時点で内側の
          入力欄が `data-type="hidden"`（幅0）になる。するとラッパーがクリックを
          横取りして「2つ目の値を選ぶために開き直す」操作ができなくなる
          （実際に E2E で踏んで特定した）。優先度は4件しかなく検索の実益は薄いが、
          担当者側と同じ操作感になり、選択後も開き直せる利点のほうが大きい。

          E2E 用の `data-testid` は外側の div に付ける。Mantine は `data-testid` を
          内側の input へ転送してしまい、`getByLabel` は展開後の listbox にも
          aria-labelledby で紐づいて2要素に一致するため、どちらも掴み手として不安定。
        */}
        <div data-testid="board-filter-priority">
          <MultiSelect
            label="優先度"
            placeholder={priorityFilter.length === 0 ? "すべて" : undefined}
            data={PRIORITY_VALUES.map((value) => ({ value, label: priorityLabel(value) }))}
            value={priorityFilter}
            onChange={setPriorityFilter}
            clearable
            searchable
            w={240}
            nothingFoundMessage="該当する優先度がありません"
          />
        </div>
        <div data-testid="board-filter-assignee">
          <MultiSelect
            label="担当者"
            placeholder={assigneeFilter.length === 0 ? "すべて" : undefined}
            data={assigneeOptions}
            value={assigneeFilter}
            onChange={setAssigneeFilter}
            clearable
            searchable
            w={240}
            nothingFoundMessage="該当する担当者がいません"
          />
        </div>

        {/*
          絞り込み中であることを必ず画面に出す。出していないと、条件を掛けたことを
          忘れたときに「タスクが消えた」と誤解される。
        */}
        {filtering ? (
          <Group gap="xs" data-testid="board-filter-status">
            <Text size="sm" c="dimmed">
              絞り込み中: 全{tasks.length}件中{visibleTasks.length}件
            </Text>
            <Button variant="subtle" size="compact-sm" onClick={clearFilters}>
              絞り込みを解除
            </Button>
          </Group>
        ) : null}
      </Group>

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
              // 描画も件数バッジも絞り込み後。絞り込んでいるのに全件数が出ていると
              // 「バッジの数だけカードが無い」という誤解のもとになる。
              taskIds={visibleColumns[status]}
              tasksById={tasksById}
              assigneesByTaskId={assigneesByTaskId}
              filtering={filtering}
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
  filtering,
  onCardClick,
}: {
  status: BoardStatus;
  /** 絞り込み後の id 配列。件数バッジもこの長さを出す。 */
  taskIds: string[];
  tasksById: Map<string, Task>;
  assigneesByTaskId: Record<string, string[]>;
  filtering: boolean;
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
        <Badge color={STATUS_COLORS[status]} variant="light" data-testid={`board-count-${status}`}>
          {taskIds.length}
        </Badge>
      </Group>

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <Stack gap="xs" mih={80}>
          {taskIds.length === 0 ? (
            <Text size="sm" c="dimmed">
              {filtering ? "条件に一致するタスクがありません" : "タスクがありません"}
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
