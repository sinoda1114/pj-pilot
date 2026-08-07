"use client";

/**
 * プロジェクト削除の確認モーダル（M2 #13）。
 * 決定 D-15: 削除は role='owner' のみ許可。ここではボタン自体は誰でも押せる状態にし、
 * 権限が無い場合は Server Action 側の ForbiddenError を通知として表示する
 * （認可の判定はサーバ側を正とする）。
 */
import { useTransition } from "react";
import { Button, Text } from "@mantine/core";
import { openConfirmModal } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useRouter } from "next/navigation";
import { deleteProjectAction } from "../../app/projects/actions";

export function DeleteProjectButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    openConfirmModal({
      title: "プロジェクトを削除しますか？",
      children: (
        <Text size="sm">
          「{projectName}」を削除します。この操作は元に戻せません。
        </Text>
      ),
      labels: { confirm: "削除する", cancel: "キャンセル" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        startTransition(async () => {
          const result = await deleteProjectAction(projectId);
          if (result.ok) {
            notifications.show({
              color: "green",
              title: "削除しました",
              message: `「${projectName}」を削除しました`,
            });
            router.refresh();
          } else {
            notifications.show({
              color: "red",
              title: "削除に失敗しました",
              message: result.message,
            });
          }
        });
      },
    });
  };

  return (
    <Button
      color="red"
      variant="subtle"
      size="xs"
      onClick={handleClick}
      loading={isPending}
      disabled={isPending}
      data-testid={`delete-project-${projectId}`}
    >
      削除
    </Button>
  );
}
