import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";

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
        </MantineProvider>
      </body>
    </html>
  );
}
