/**
 * ダッシュボード画面（Phase 2 M9 #48）。全プロジェクト横断。
 *
 * Server Component は認可と集計だけを行い、描画は `DashboardClient` に委譲する。
 * チャート（`@mantine/charts` → Recharts）はブラウザの実寸を測るためクライアント専用。
 */
import { Stack, Title } from "@mantine/core";
import { getSession } from "../../lib/auth/session";
import { getDashboardData } from "../../lib/dashboard/service";
import { todayInTimeZone } from "../../lib/dates/date-only";
import { db } from "../../lib/db";
import { DashboardClient } from "./DashboardClient";

/**
 * 「今日」を判定するタイムゾーン。Vercel のサーバーは UTC で動くため、これを
 * 明示しないと JST の 0:00〜9:00 の間は期限超過の判定が丸1日ずれる（決定 P2-08）。
 */
const DISPLAY_TIME_ZONE = "Asia/Tokyo";

export default async function DashboardPage() {
  const session = await getSession();
  const today = todayInTimeZone(DISPLAY_TIME_ZONE);
  const data = await getDashboardData(db, session, today);

  return (
    <Stack gap="lg">
      <Title order={2}>ダッシュボード</Title>
      <DashboardClient data={data} today={today} />
    </Stack>
  );
}
