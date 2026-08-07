"use client";

/**
 * プロジェクト設定画面のクライアント側（M5 #29）。依存連動のON/OFFトグルのみを扱う。
 * `Switch` の変更を即座に `updateProjectAction` へ送る楽観的UI（保存ボタンを挟まない）。
 * 決定D-08/§6: 編集自体は全ログインユーザーに開く。
 */
import { useState } from "react";
import { Card, Stack, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useRouter } from "next/navigation";
import { updateProjectAction } from "../../app/projects/actions";

export interface ProjectSettingsFormProps {
  projectId: string;
  dependencySyncEnabled: boolean;
}

export function ProjectSettingsForm({ projectId, dependencySyncEnabled }: ProjectSettingsFormProps) {
  const router = useRouter();
  // `checked` の表示はサーバ確定を待たず即時反映し、失敗時のみ元に戻す
  // （EditProjectButtonのような保存ボタン方式だとON/OFFのためだけに毎回モーダルを
  // 開く必要があり、トグルという操作の性質に合わない）。
  const [checked, setChecked] = useState(dependencySyncEnabled);
  const [submitting, setSubmitting] = useState(false);

  async function handleChange(value: boolean) {
    const previous = checked;
    setChecked(value);
    setSubmitting(true);
    try {
      const result = await updateProjectAction(projectId, { dependencySyncEnabled: value });
      if (!result.ok) {
        setChecked(previous);
        notifications.show({ color: "red", title: "更新に失敗しました", message: result.message });
        return;
      }
      notifications.show({
        color: "green",
        message: value ? "依存連動をONにしました" : "依存連動をOFFにしました",
      });
      router.refresh();
    } catch (error) {
      // `updateProjectAction` が予期しない例外を投げた場合（ネットワークエラー等）、
      // 楽観的に反映した `checked` がDBの実際の値と食い違ったまま残ってしまう
      // （TaskDrawer.tsx の handleSubmit と同じ catch パターン、Amazon Q レビュー指摘）。
      setChecked(previous);
      notifications.show({
        color: "red",
        title: "予期しないエラーが発生しました",
        message: error instanceof Error ? error.message : "しばらくしてから再度お試しください",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card withBorder padding="md" maw={480}>
      <Stack gap="xs">
        <Switch
          label="依存連動"
          description="タスクの日付を移動したとき、依存する後続タスクを自動で連動させます。OFFにすると移動したタスクのみが動きます。"
          checked={checked}
          disabled={submitting}
          onChange={(event) => void handleChange(event.currentTarget.checked)}
        />
        {checked && (
          <Text size="xs" c="dimmed">
            ONの状態でも、ドラッグ中にShiftキーを押すとその操作だけ一時的に連動を切れます。
          </Text>
        )}
      </Stack>
    </Card>
  );
}
