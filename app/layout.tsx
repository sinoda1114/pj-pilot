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
import { DevUserSwitcher } from "../components/dev/DevUserSwitcher";
import { getSession } from "../lib/auth/session";

export const metadata: Metadata = {
  title: "pj-pilot",
  description: "社内チーム向けの総合プロジェクト管理ツール",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getSession();

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
                    {session ? <DevUserSwitcher currentUserId={session.userId} /> : null}
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
