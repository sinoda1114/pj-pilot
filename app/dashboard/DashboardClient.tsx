"use client";

/**
 * ダッシュボードのクライアント側（Phase 2 M9 #48・#50）。
 *
 * `@mantine/charts` は内部で Recharts を使い、コンテナの実寸を測って描画するため
 * クライアント専用。集計は済んだ状態で props として渡ってくるので、ここは描画だけ。
 */

import { BarChart, DonutChart } from "@mantine/charts";
import { Anchor, Badge, Button, Card, Group, Stack, Table, Text, Title } from "@mantine/core";
import Link from "next/link";
import { useState } from "react";
import { BOARD_STATUSES, type BoardStatus } from "../../lib/board/service";
import type { DashboardData, OverdueTaskRow } from "../../lib/dashboard/service";
import { buildCsvFileName, toCsv, withUtf8Bom, type CsvColumn } from "../../lib/export/csv";
import { downloadCsvFile } from "../../lib/export/csv-download";
import { statusLabel } from "../../lib/labels";

/** ステータスの色。カンバン（BoardClient）と揃える。 */
const STATUS_COLORS: Record<BoardStatus, string> = {
  todo: "gray.5",
  in_progress: "blue.6",
  review: "yellow.6",
  done: "green.6",
};

/**
 * 期限超過一覧の初期表示件数（未決事項 Q-2 の既定）。
 * これを超える分は「もっと見る」で展開する。全件を常時出すと画面が長くなりすぎるため。
 */
const OVERDUE_PREVIEW_COUNT = 20;

/** 横棒グラフの Y 軸（プロジェクト名）の幅。日本語名が切れない程度に確保する。 */
const Y_AXIS_WIDTH = 140;

/** Y軸に収まる長さ。これを超える名前は末尾を省略する（軸幅を無限に広げないため）。 */
const PROJECT_NAME_MAX_CHARS = 9;

function truncateProjectName(name: string): string {
  return name.length > PROJECT_NAME_MAX_CHARS ? `${name.slice(0, PROJECT_NAME_MAX_CHARS)}…` : name;
}

/**
 * 期限超過一覧の CSV 列定義。表の列（プロジェクト/タスク/ステータス/終了日）に合わせる。
 * ステータスは DB の英字 enum ではなく日本語ラベルで出す（決定 D-19）。
 */
const OVERDUE_CSV_COLUMNS: CsvColumn<OverdueTaskRow>[] = [
  { header: "プロジェクト", value: (task) => task.projectName },
  { header: "タスク", value: (task) => task.title },
  { header: "ステータス", value: (task) => statusLabel(task.status) },
  { header: "終了日", value: (task) => task.endDate },
];

export function DashboardClient({ data, today }: { data: DashboardData; today: string }) {
  const { statusCounts, overdueTasks, projectProgress } = data;
  const [showAllOverdue, setShowAllOverdue] = useState(false);

  const totalTasks = BOARD_STATUSES.reduce((sum, status) => sum + statusCounts[status], 0);

  const donutData = BOARD_STATUSES.filter((status) => statusCounts[status] > 0).map((status) => ({
    name: statusLabel(status),
    value: statusCounts[status],
    color: STATUS_COLORS[status],
  }));

  // 進捗率は「タスクがあるプロジェクト」だけをグラフに出す。
  // percent が null（タスク0件）のものを 0 として混ぜると、着手していないだけの
  // プロジェクトが「進捗0%で遅れている」ように見えてしまう。
  const progressWithTasks = projectProgress.filter((row) => row.percent !== null);
  const barData = progressWithTasks.map((row) => ({
    project: row.name,
    完了率: row.percent as number,
  }));
  const projectsWithoutTasks = projectProgress.filter((row) => row.percent === null);

  const visibleOverdue = showAllOverdue
    ? overdueTasks
    : overdueTasks.slice(0, OVERDUE_PREVIEW_COUNT);

  /**
   * 期限超過タスクを CSV でダウンロードする。
   *
   * 「もっと見る」で折りたたまれている分も含めて**全件**出す。ここでの省略は
   * 画面が長くなりすぎないための表示上の都合にすぎず、20 件で切れたファイルが
   * 出てくる方が利用者の意図から外れるため。
   * ファイル名の日付は画面に出している基準日（サーバー側で
   * `todayInTimeZone("Asia/Tokyo")` として求めた値）と同じものを使い、
   * 「どの日を基準に抽出した一覧か」がファイル名と画面で食い違わないようにする。
   * Excel で開かれる前提なので BOM を付ける。
   */
  function handleDownloadOverdueCsv() {
    const csv = toCsv(overdueTasks, OVERDUE_CSV_COLUMNS);
    downloadCsvFile(buildCsvFileName("overdue-tasks", today), withUtf8Bom(csv));
  }

  return (
    <Stack gap="lg">
      <Group align="stretch" gap="md" grow wrap="wrap">
        <Card withBorder padding="md" miw={280}>
          <Title order={3} size="h5" mb="sm">
            ステータス別タスク数
          </Title>
          {totalTasks === 0 ? (
            <Text c="dimmed" size="sm">
              集計対象のタスクがありません。
            </Text>
          ) : (
            <Group align="center" gap="lg" wrap="nowrap">
              {/* データが空のまま Recharts に渡すと高さ 0 の空要素になり、
                  原因の分かりにくい見た目の不具合になるため上で分岐している。 */}
              <DonutChart data={donutData} withTooltip size={160} thickness={28} />
              <Stack gap={4}>
                {BOARD_STATUSES.map((status) => (
                  <Group key={status} gap="xs" wrap="nowrap">
                    <Badge color={STATUS_COLORS[status]} variant="light" w={72}>
                      {statusLabel(status)}
                    </Badge>
                    <Text size="sm" fw={600}>
                      {statusCounts[status]}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </Group>
          )}
        </Card>

        <Card withBorder padding="md" miw={280}>
          <Title order={3} size="h5" mb="sm">
            プロジェクト別進捗率
          </Title>
          {barData.length === 0 ? (
            <Text c="dimmed" size="sm">
              進捗を計算できるプロジェクトがありません。
            </Text>
          ) : (
            <>
              <BarChart
                h={Math.max(160, barData.length * 44)}
                data={barData}
                dataKey="project"
                orientation="vertical"
                series={[{ name: "完了率", color: "blue.6" }]}
                withTooltip
                gridAxis="x"
                xAxisProps={{ domain: [0, 100], unit: "%" }}
                // Y軸の幅を明示する。既定（60px）のままだと日本語のプロジェクト名が
                // 頭から切れて「ステム刷新」のように読めなくなる（実機の
                // スクリーンショットで確認して修正）。長い名前は末尾を省略する。
                yAxisProps={{ width: Y_AXIS_WIDTH, tickFormatter: truncateProjectName }}
              />
              <Text size="xs" c="dimmed" mt="xs">
                完了率は「完了タスク数 ÷ 全タスク数」（件数ベース）です。
              </Text>
            </>
          )}
          {projectsWithoutTasks.length > 0 ? (
            <Text size="xs" c="dimmed" mt="xs">
              タスクなし: {projectsWithoutTasks.map((row) => row.name).join(" / ")}
            </Text>
          ) : null}
        </Card>
      </Group>

      <Card withBorder padding="md" data-testid="overdue-section">
        <Group justify="space-between" mb="sm">
          <Title order={3} size="h5">
            期限超過タスク
          </Title>
          <Group gap="sm">
            <Badge color={overdueTasks.length > 0 ? "red" : "gray"} variant="light">
              {overdueTasks.length}
            </Badge>
            {/* 0 件のときはボタン自体を出さない。中身のない CSV を渡しても使い道がないため。 */}
            {overdueTasks.length > 0 ? (
              <Button
                variant="default"
                size="xs"
                onClick={handleDownloadOverdueCsv}
                data-testid="overdue-csv-download"
              >
                CSVダウンロード
              </Button>
            ) : null}
          </Group>
        </Group>

        {overdueTasks.length === 0 ? (
          <Text c="dimmed" size="sm">
            期限を過ぎている未完了タスクはありません。
          </Text>
        ) : (
          <>
            <Table striped highlightOnHover data-testid="overdue-table">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>プロジェクト</Table.Th>
                  <Table.Th>タスク</Table.Th>
                  <Table.Th>ステータス</Table.Th>
                  <Table.Th>終了日</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visibleOverdue.map((task) => (
                  <Table.Tr key={task.id}>
                    <Table.Td>
                      <Anchor component={Link} href={`/projects/${task.projectId}/tasks`} size="sm">
                        {task.projectName}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{task.title}</Table.Td>
                    <Table.Td>
                      <Badge size="sm" color={STATUS_COLORS[task.status]} variant="light">
                        {statusLabel(task.status)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="red">
                        {task.endDate}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            {overdueTasks.length > OVERDUE_PREVIEW_COUNT && !showAllOverdue ? (
              <Button variant="subtle" size="sm" mt="sm" onClick={() => setShowAllOverdue(true)}>
                もっと見る（残り {overdueTasks.length - OVERDUE_PREVIEW_COUNT} 件）
              </Button>
            ) : null}
          </>
        )}

        <Text size="xs" c="dimmed" mt="sm">
          基準日: {today}（日本時間）
        </Text>
      </Card>
    </Stack>
  );
}
