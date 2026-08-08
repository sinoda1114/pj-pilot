import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
// `@mantine/charts` も自身のCSSを明示的にimportしないと、軸ラベル・凡例・
// ツールチップの見た目が崩れる（`mantine-datatable` と同じ事情）。
import "@mantine/charts/styles.css";
// `mantine-datatable` は自身のCSSを明示的にimportしないと、空状態オーバーレイ
// （`noRecordsText`）の位置決めCSSが効かず、レコードが存在するテーブルの上にも
// 「タスクがありません」が重なって表示されてしまう（実機のスクリーンショットで
// 確認済み。M6 #34/#35）。
import "mantine-datatable/styles.css";

import type { Metadata } from "next";
import Link from "next/link";
import {
  AppShell,
  AppShellHeader,
  AppShellMain,
  ColorSchemeScript,
  Group,
  MantineProvider,
  Text,
  mantineHtmlProps,
} from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { DatesLocaleProvider } from "../components/providers/DatesLocaleProvider";
import { UserMenu } from "../components/auth/UserMenu";
import { getFullSession, getSession } from "../lib/auth/session";

export const metadata: Metadata = {
  title: "pj-pilot",
  description: "社内チーム向けの総合プロジェクト管理ツール",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // ヘッダーの表示専用（名前/email）。`getSession()` が返す `AuthSession` は
  // `userId` のみのため、表示情報が必要なここだけ生セッションを直接見る
  // （`lib/auth/session.ts` 参照）。
  //
  // ただし**出すかどうか**の判定は `getSession()`（ドメイン制限チェック済み）で行う。
  // `getFullSession()` だけで判定していたときは、`ALLOWED_EMAIL_DOMAINS` から外れた
  // ユーザーにも氏名・メールとナビが表示され、「ログインできているのに何を押しても
  // エラー」という状態になっていた（監査で実測）。他人のデータは出ないので
  // 情報漏洩ではないが、防御線の外にいることが画面から分からないのは避ける。
  // どちらも React の `cache()` 越しなので、2回呼んでも DB アクセスは増えない。
  const session = await getSession();
  const fullSession = session ? await getFullSession() : null;

  return (
    <html lang="ja" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript />
      </head>
      <body>
        <MantineProvider>
          <DatesLocaleProvider>
            <ModalsProvider>
              <Notifications />
              <AppShell header={{ height: 56 }} padding="md">
                <AppShellHeader>
                  <Group h="100%" px="md" justify="space-between">
                    <Group gap="lg">
                      <Text fw={700}>pj-pilot</Text>
                      {/* ログイン済みのときだけ出す。未ログインでは押しても
                          サインインへ飛ばされるだけで、導線として意味がないため。 */}
                      {/*
                        Mantine の polymorphic な `component` prop に next/link の Link を
                        直接渡すと、Server Component（このファイル）から Client Component
                        （Mantine Anchor）の境界を関数値のまま越えようとして
                        "Functions cannot be passed directly to Client Components" で
                        実行時エラーになる（app/projects/page.tsx と同じ罠。実際に踏んで確認済み）。
                        Link で Text を包む形にすれば、関数そのものを props として
                        越境させずに済む。
                      */}
                      {fullSession ? (
                        <Group gap="md">
                          <Link href="/projects">
                            <Text component="span" size="sm">
                              プロジェクト
                            </Text>
                          </Link>
                          <Link href="/dashboard">
                            <Text component="span" size="sm">
                              ダッシュボード
                            </Text>
                          </Link>
                        </Group>
                      ) : null}
                    </Group>
                    {fullSession ? (
                      <UserMenu name={fullSession.user.name} email={fullSession.user.email} />
                    ) : null}
                  </Group>
                </AppShellHeader>
                <AppShellMain>{children}</AppShellMain>
              </AppShell>
            </ModalsProvider>
          </DatesLocaleProvider>
        </MantineProvider>
      </body>
    </html>
  );
}
