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

  // `router.refresh()` 後にサーバから新しい `dependencySyncEnabled` が props として
  // 渡り直したとき、`checked` へ追従させる（GanttView.tsx の tasks/dependencies 同期と
  // 同じ、React公式推奨の「レンダー中に前回の props と比較して直接 setState する」
  // パターン）。予期しない例外（下記 catch）発生時、DB側の更新が実際には成功して
  // いたかどうかをクライアント側では判断できないため、catch では前の値へいったん
  // 戻しつつ（多くの例外は永続化前に発生するため、これが安全側のデフォルト。
  // Amazon Q / Cursor Bugbot指摘）、`router.refresh()` 後にサーバ側の値が本当に
  // 変わっていた（＝実は成功していた）場合は、この props 同期が
  // `dependencySyncEnabled !== prevDependencySyncEnabled` を検知して正しい値へ
  // 上書きする（Cursor Bugbot再指摘: 戻すだけでは成功時に表示が食い違ったまま
  // 残ってしまうケースへの対策）。
  const [prevDependencySyncEnabled, setPrevDependencySyncEnabled] = useState(dependencySyncEnabled);
  if (dependencySyncEnabled !== prevDependencySyncEnabled) {
    setPrevDependencySyncEnabled(dependencySyncEnabled);
    setChecked(dependencySyncEnabled);
  }

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
      // ほとんどの例外（ネットワークエラー等）はサーバ側の永続化が完了する前に
      // 発生するため、まず安全側のデフォルトとして直前の値へ戻す。まれに永続化後の
      // 例外だった場合は、`router.refresh()` 後に上の props 同期が本当の値で
      // 上書きする（コメント参照）。
      setChecked(previous);
      notifications.show({
        color: "red",
        title: "予期しないエラーが発生しました",
        message: error instanceof Error ? error.message : "しばらくしてから再度お試しください",
      });
      router.refresh();
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
