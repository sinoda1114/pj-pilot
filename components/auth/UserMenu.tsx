"use client";

/**
 * ヘッダーに表示するログイン中ユーザー表示 + ログアウト（`components/dev/DevUserSwitcher.tsx`
 * の置き換え）。表示専用の情報（名前/email）は `AuthSession`（`userId`のみ）を
 * 経由せず `app/layout.tsx` から直接渡される（`lib/auth/session.ts` の
 * `getFullSession()` 参照）。
 */
import { useState } from "react";
import { Group, Menu, MenuDropdown, MenuItem, MenuTarget, Text, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useRouter } from "next/navigation";
import { authClient } from "../../lib/auth-client";

export interface UserMenuProps {
  name: string;
  email: string;
}

export function UserMenu({ name, email }: UserMenuProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    // authClient.signOut()も`signIn.social`と同じくAPIレベルのエラーは
    // `{ data, error }` で返る（例外はthrowしない）。見ずに遷移すると、
    // 失敗時にCookieが残ったままUIだけログアウトしたように見えてしまう
    // （Cursor Bugbot指摘）。
    const { error } = await authClient.signOut();
    if (error) {
      setSigningOut(false);
      notifications.show({
        color: "red",
        title: "ログアウトに失敗しました",
        message: error.message ?? "しばらくしてから再度お試しください",
      });
      return;
    }
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <Menu position="bottom-end">
      <MenuTarget>
        <UnstyledButton disabled={signingOut}>
          <Group gap="xs">
            <Text size="sm" fw={500}>
              {name}
            </Text>
            <Text size="xs" c="dimmed">
              {email}
            </Text>
          </Group>
        </UnstyledButton>
      </MenuTarget>
      <MenuDropdown>
        <MenuItem onClick={() => void handleSignOut()} disabled={signingOut}>
          ログアウト
        </MenuItem>
      </MenuDropdown>
    </Menu>
  );
}
