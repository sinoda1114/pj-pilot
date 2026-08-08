"use client";

/**
 * 削除済みプロジェクトの復元ボタン（Issue #65）。
 *
 * 決定 D-15: 復元は削除と同じく role='owner' のみ。`DeleteProjectButton` と同じく
 * ボタン自体は誰でも押せる状態にし、権限が無い場合は Server Action 側の
 * ForbiddenError を通知として出す（認可の判定はサーバ側を正とする）。
 */
import { useTransition } from "react";
import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useRouter } from "next/navigation";
import { restoreProjectAction } from "../../app/projects/actions";

export function RestoreProjectButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // 削除と違い、復元は元に戻せる（また削除すればよい）操作なので確認モーダルは挟まない。
  const handleClick = () => {
    startTransition(async () => {
      const result = await restoreProjectAction(projectId);
      if (result.ok) {
        notifications.show({
          color: "green",
          title: "復元しました",
          message: `「${projectName}」を一覧に戻しました`,
        });
        router.refresh();
      } else {
        notifications.show({
          color: "red",
          title: "復元に失敗しました",
          message: result.message,
        });
      }
    });
  };

  return (
    <Button
      variant="light"
      size="xs"
      onClick={handleClick}
      loading={isPending}
      disabled={isPending}
      data-testid={`restore-project-${projectId}`}
    >
      復元
    </Button>
  );
}
