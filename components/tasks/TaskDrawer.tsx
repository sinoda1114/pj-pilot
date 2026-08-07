"use client";

/**
 * タスク詳細・編集用の Drawer（M2 #14〜#17）。
 *
 * 既知の落とし穴（CLAUDE.md 直下の指示・実機確認済みバグ）への対応として、
 * Mantine のコンパウンドコンポーネントはドット記法（`Drawer.Body` 等）を一切使わず、
 * フラットな named export（`DrawerRoot` / `DrawerBody` 等）だけを使用する。
 *
 * 日付は `@mantine/dates` v9 の `DateStringValue`（'YYYY-MM-DD' 文字列）をそのまま
 * `DatePickerInput` の value/onChange に使う。Date オブジェクトへの変換を一切挟まないため、
 * §3.2 の「日付はタイムゾーン変換をしない」規約に自然に従う。
 */
import {
  Alert,
  Button,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerHeader,
  DrawerOverlay,
  DrawerRoot,
  DrawerTitle,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
} from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import type { InferSelectModel } from "drizzle-orm";
import { useState } from "react";
import type { tasks } from "../../lib/db/schema";
import { priorityLabel, statusLabel } from "../../lib/labels";
import { HasChildrenError } from "../../lib/tasks/errors";
import {
  createTaskAction,
  deleteTaskAction,
  updateTaskAction,
} from "../../app/projects/[id]/tasks/actions";

/**
 * `deleteTaskAction` が子タスクの存在を理由に失敗したときのメッセージ。
 * "use server" ファイル（`actions.ts`）は非 async 関数を export できない制約があるため
 * （実機ビルドで確認済み）、文字列定数はそちらから export せず、双方が参照できる
 * `HasChildrenError` から同じ文字列を導出する。
 */
const HAS_CHILDREN_MESSAGE = new HasChildrenError().message;

type Task = InferSelectModel<typeof tasks>;
type Priority = Task["priority"];
type Status = Task["status"];

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = (
  ["low", "medium", "high", "urgent"] as const
).map((value) => ({ value, label: priorityLabel(value) }));

const STATUS_OPTIONS: { value: Status; label: string }[] = (
  ["todo", "in_progress", "review", "done"] as const
).map((value) => ({ value, label: statusLabel(value) }));

interface TaskFormValues {
  title: string;
  startDate: string;
  endDate: string;
  priority: Priority;
  status: Status;
  progress: number;
  estimatedHours: number | null;
  actualHours: number | null;
  assignees: string[];
  isPinned: boolean;
}

function todayDateOnly(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toFormValues(task: Task | null, initialAssignees: string[]): TaskFormValues {
  if (!task) {
    const today = todayDateOnly();
    return {
      title: "",
      startDate: today,
      endDate: today,
      priority: "medium",
      status: "todo",
      progress: 0,
      estimatedHours: null,
      actualHours: null,
      assignees: [],
      isPinned: false,
    };
  }

  return {
    title: task.title,
    startDate: task.startDate,
    endDate: task.endDate,
    priority: task.priority,
    status: task.status,
    progress: task.progress,
    estimatedHours: task.estimatedHours,
    actualHours: task.actualHours,
    assignees: initialAssignees,
    isPinned: task.isPinned,
  };
}

export interface TaskDrawerProps {
  opened: boolean;
  mode: "create" | "edit";
  projectId: string;
  task: Task | null;
  initialAssignees: string[];
  onClose: () => void;
  /** 保存・削除が成功したときに呼ばれる。呼び出し側で Drawer を閉じて一覧を再取得する想定。 */
  onSaved: () => void;
}

export function TaskDrawer({
  opened,
  mode,
  projectId,
  task,
  initialAssignees,
  onClose,
  onSaved,
}: TaskDrawerProps) {
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [childConflict, setChildConflict] = useState(false);

  const form = useForm<TaskFormValues>({
    initialValues: toFormValues(task, initialAssignees),
    validate: {
      title: (value) => (value.trim().length === 0 ? "タイトルは必須です" : null),
      startDate: (value) => (value ? null : "開始日は必須です"),
      endDate: (value, values) => {
        if (!value) return "終了日は必須です";
        if (values.startDate && value < values.startDate) {
          return "終了日は開始日以降にしてください";
        }
        return null;
      },
      progress: (value) =>
        value < 0 || value > 100 ? "進捗は0〜100の範囲で入力してください" : null,
      estimatedHours: (value) => (value !== null && value < 0 ? "0以上を入力してください" : null),
      actualHours: (value) => (value !== null && value < 0 ? "0以上を入力してください" : null),
    },
  });

  async function handleSubmit(values: TaskFormValues) {
    setSubmitting(true);
    try {
      const taskInput = {
        title: values.title.trim(),
        startDate: values.startDate,
        endDate: values.endDate,
        priority: values.priority,
        status: values.status,
        progress: values.progress,
        estimatedHours: values.estimatedHours,
        actualHours: values.actualHours,
        isPinned: values.isPinned,
      };

      const result =
        mode === "create"
          ? await createTaskAction(projectId, taskInput, values.assignees)
          : await updateTaskAction(projectId, task!.id, taskInput, values.assignees);

      if (!result.ok) {
        notifications.show({ color: "red", title: "保存に失敗しました", message: result.message });
        return;
      }

      notifications.show({
        color: "green",
        message: mode === "create" ? "タスクを作成しました" : "タスクを更新しました",
      });
      onSaved();
    } catch (error) {
      notifications.show({
        color: "red",
        title: "予期しないエラーが発生しました",
        message: error instanceof Error ? error.message : "しばらくしてから再度お試しください",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function performDelete(deleteMode?: "subtree" | "promote") {
    if (!task) return;
    setDeleting(true);
    try {
      const result = await deleteTaskAction(projectId, task.id, deleteMode);
      if (!result.ok) {
        if (result.message === HAS_CHILDREN_MESSAGE) {
          setChildConflict(true);
          return;
        }
        notifications.show({ color: "red", title: "削除に失敗しました", message: result.message });
        return;
      }

      notifications.show({ color: "green", message: "タスクを削除しました" });
      onSaved();
    } catch (error) {
      notifications.show({
        color: "red",
        title: "予期しないエラーが発生しました",
        message: error instanceof Error ? error.message : "しばらくしてから再度お試しください",
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <DrawerRoot opened={opened} onClose={onClose} position="right" size="md">
      <DrawerOverlay />
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{mode === "create" ? "新規タスク作成" : "タスク詳細"}</DrawerTitle>
          <DrawerCloseButton aria-label="閉じる" />
        </DrawerHeader>
        <DrawerBody>
          <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack gap="md">
              {childConflict && (
                <Alert color="orange" title="子タスクが存在します">
                  <Stack gap="sm">
                    <Text size="sm">
                      このタスクには子タスクがあります。削除方法を選択してください。
                    </Text>
                    <Group>
                      <Button
                        color="red"
                        variant="light"
                        loading={deleting}
                        onClick={() => performDelete("subtree")}
                      >
                        子タスクごと削除
                      </Button>
                      <Button
                        variant="light"
                        loading={deleting}
                        onClick={() => performDelete("promote")}
                      >
                        子タスクを繰り上げて削除
                      </Button>
                      <Button variant="subtle" onClick={() => setChildConflict(false)}>
                        キャンセル
                      </Button>
                    </Group>
                  </Stack>
                </Alert>
              )}

              <TextInput
                label="タイトル"
                withAsterisk
                {...form.getInputProps("title")}
                disabled={submitting || deleting}
              />

              <Group grow>
                <DatePickerInput
                  label="開始日"
                  withAsterisk
                  valueFormat="YYYY-MM-DD"
                  {...form.getInputProps("startDate")}
                  disabled={submitting || deleting}
                />
                <DatePickerInput
                  label="終了日"
                  withAsterisk
                  valueFormat="YYYY-MM-DD"
                  {...form.getInputProps("endDate")}
                  disabled={submitting || deleting}
                />
              </Group>

              <Group grow>
                <Select
                  label="優先度"
                  data={PRIORITY_OPTIONS}
                  allowDeselect={false}
                  {...form.getInputProps("priority")}
                  disabled={submitting || deleting}
                />
                <Select
                  label="ステータス"
                  data={STATUS_OPTIONS}
                  allowDeselect={false}
                  {...form.getInputProps("status")}
                  disabled={submitting || deleting}
                />
              </Group>

              <NumberInput
                label="進捗（%）"
                min={0}
                max={100}
                value={form.values.progress}
                onChange={(value) =>
                  form.setFieldValue("progress", typeof value === "number" ? value : 0)
                }
                error={form.errors.progress}
                disabled={submitting || deleting}
              />

              <Group grow>
                <NumberInput
                  label="見積工数（時間）"
                  min={0}
                  decimalScale={2}
                  value={form.values.estimatedHours ?? ""}
                  onChange={(value) =>
                    form.setFieldValue(
                      "estimatedHours",
                      value === "" || value === undefined ? null : Number(value),
                    )
                  }
                  error={form.errors.estimatedHours}
                  disabled={submitting || deleting}
                />
                <NumberInput
                  label="実績工数（時間）"
                  min={0}
                  decimalScale={2}
                  value={form.values.actualHours ?? ""}
                  onChange={(value) =>
                    form.setFieldValue(
                      "actualHours",
                      value === "" || value === undefined ? null : Number(value),
                    )
                  }
                  error={form.errors.actualHours}
                  disabled={submitting || deleting}
                />
              </Group>

              <Switch
                label="ピン留め"
                description="ONにすると、依存する先行タスクを動かしてもこのタスクは連動して動かなくなります（Gantt上で📌が表示されます）。"
                checked={form.values.isPinned}
                onChange={(event) => form.setFieldValue("isPinned", event.currentTarget.checked)}
                disabled={submitting || deleting}
              />

              <TagsInput
                label="担当者"
                description="ユーザーIDを入力して Enter で追加します（ユーザー管理機能は未実装のため自由入力です）"
                value={form.values.assignees}
                onChange={(value) => form.setFieldValue("assignees", value)}
                disabled={submitting || deleting}
              />

              <Group justify="space-between" mt="md">
                <div>
                  {mode === "edit" && (
                    <Button
                      color="red"
                      variant="outline"
                      loading={deleting}
                      disabled={submitting}
                      onClick={() => performDelete()}
                    >
                      削除
                    </Button>
                  )}
                </div>
                <Group>
                  <Button variant="default" onClick={onClose} disabled={submitting || deleting}>
                    キャンセル
                  </Button>
                  <Button type="submit" loading={submitting} disabled={deleting}>
                    保存
                  </Button>
                </Group>
              </Group>
            </Stack>
          </form>
        </DrawerBody>
      </DrawerContent>
    </DrawerRoot>
  );
}
