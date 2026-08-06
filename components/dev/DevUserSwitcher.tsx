"use client";

/**
 * 開発用ユーザー切り替え UI。`lib/auth/session.ts` の暫定セッション実装と
 * セットで、Better Auth 導入時に削除する。owner/member でロールが変わる
 * 挙動（PJ削除権限等）を実際の画面上で確認できるようにするためのもの。
 */
import { Select } from "@mantine/core";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setDevUser } from "../../lib/auth/dev-actions";
import { DEV_USERS } from "../../lib/auth/dev-users";

export function DevUserSwitcher({ currentUserId }: { currentUserId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Select
      size="xs"
      w={260}
      aria-label="開発用ユーザー切り替え"
      data={DEV_USERS.map((u) => ({ value: u.userId, label: u.label }))}
      value={currentUserId}
      disabled={isPending}
      allowDeselect={false}
      onChange={(value) => {
        if (!value) return;
        startTransition(async () => {
          await setDevUser(value);
          router.refresh();
        });
      }}
    />
  );
}
