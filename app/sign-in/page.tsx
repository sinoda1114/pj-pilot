/**
 * サインイン画面（決定D-04/D-07）。Google OAuthのみ。ドメイン制限に反した
 * 場合、Better Authはエラー情報をクエリパラメータに付けてこの画面へ
 * リダイレクトする想定のため、`error` パラメータがあれば表示する。
 */
import { Alert, Center, Stack, Text, Title } from "@mantine/core";
import { GoogleSignInButton } from "../../components/auth/GoogleSignInButton";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <Center h="60vh">
      <Stack align="center" gap="md" maw={360}>
        <Title order={2}>pj-pilot</Title>
        <Text c="dimmed" ta="center">
          社内チーム向けの総合プロジェクト管理ツールです。
        </Text>
        {error ? (
          <Alert color="red" title="ログインできませんでした" w="100%">
            許可されていないメールドメインの可能性があります。社内アカウントで再度お試しください。
          </Alert>
        ) : null}
        <GoogleSignInButton />
      </Stack>
    </Center>
  );
}
