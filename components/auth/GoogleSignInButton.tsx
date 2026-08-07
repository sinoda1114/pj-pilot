"use client";

import { useState } from "react";
import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { authClient } from "../../lib/auth-client";

export function GoogleSignInButton() {
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    setSubmitting(true);
    try {
      // better-authのクライアントはAPIレベルのエラー（プロバイダ未設定等）を
      // 例外としてthrowせず `{ data, error }` で返す（`@better-fetch/fetch` の
      // 既定動作）。catch は実際のネットワーク例外用で、`error` も別途見る
      // 必要がある（見ないとログイン失敗時にボタンが読み込み中のまま固まる）。
      const { error } = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/projects",
      });
      if (error) {
        setSubmitting(false);
        notifications.show({
          color: "red",
          title: "ログインに失敗しました",
          message: error.message ?? "しばらくしてから再度お試しください",
        });
      }
    } catch (error) {
      setSubmitting(false);
      notifications.show({
        color: "red",
        title: "ログインに失敗しました",
        message: error instanceof Error ? error.message : "しばらくしてから再度お試しください",
      });
    }
  }

  return (
    <Button onClick={() => void handleClick()} loading={submitting} size="md">
      Googleでログイン
    </Button>
  );
}
