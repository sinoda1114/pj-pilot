import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
// `mantine-datatable` は自身のCSSを明示的にimportしないと、空状態オーバーレイ
// （`noRecordsText`）の位置決めCSSが効かず、レコードが存在するテーブルの上にも
// 「タスクがありません」が重なって表示されてしまう（実機のスクリーンショットで
// 確認済み。M6 #34/#35）。
import "mantine-datatable/styles.css";

import type { Metadata } from "next";
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
import { getFullSession } from "../lib/auth/session";

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
  // （`lib/auth/session.ts` 参照）。ドメイン制限のチェックは行わないが、
  // 表示専用でありデータアクセスには使わないため問題ない
  // （実際の認可は各ページの `requireLogin(await getSession())` が担う）。
  const fullSession = await getFullSession();

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
                    <Text fw={700}>pj-pilot</Text>
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
