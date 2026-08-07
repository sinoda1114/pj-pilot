"use client";

/**
 * 未捕捉例外の簡易受け皿。特に `requireLogin`/`requireProjectOwner`
 * （`lib/auth/authz.ts`）が投げる `UnauthorizedError`/`ForbiddenError` は
 * 各ページの Server Component 内で未catchのまま投げているため、ここで
 * 受け止める（Cookieはあるがセッションが無効/期限切れ、またはドメイン制限に
 * 反する場合に発生しうる。多層防御の一環）。
 *
 * Next.js は本番ビルドで Error オブジェクトの詳細（`message`等）をクライアントへ
 * 渡す前に取り除く仕様のため、`error.name`でエラー種別を判定して出し分ける
 * ことはしない（開発環境では動いても本番で当てにできない）。エラー種別を
 * 問わず、ログイン画面と一覧画面の両方への導線を常に出す。
 */
import { useEffect } from "react";
import { Button, Center, Group, Stack, Text, Title } from "@mantine/core";
import Link from "next/link";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Center h="60vh">
      <Stack align="center" gap="sm">
        <Title order={2}>エラーが発生しました</Title>
        <Text c="dimmed" ta="center">
          セッションが無効になっているか、一時的な問題が発生した可能性があります。
        </Text>
        <Group mt="sm">
          <Link href="/sign-in">
            <Button variant="light">ログイン画面へ</Button>
          </Link>
          <Link href="/projects">
            <Button>プロジェクト一覧へ戻る</Button>
          </Link>
        </Group>
      </Stack>
    </Center>
  );
}
