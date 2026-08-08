import Link from "next/link";
import { Card, Group, Stack, Text, Title } from "@mantine/core";
import { CreateProjectButton } from "../../components/projects/CreateProjectButton";
import { DeleteProjectButton } from "../../components/projects/DeleteProjectButton";
import { EditProjectButton } from "../../components/projects/EditProjectButton";
import { RestoreProjectButton } from "../../components/projects/RestoreProjectButton";
import { requireLogin } from "../../lib/auth/authz";
import { getSession } from "../../lib/auth/session";
import { db } from "../../lib/db";
import { listDeletedProjects, listProjects } from "../../lib/projects/service";

/**
 * ゴミ箱に入った日時の表示（`app/projects/[id]/trash/page.tsx` と同じ形式）。
 */
function formatDeletedAt(deletedAt: Date | null): string {
  if (!deletedAt) {
    return "-";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(deletedAt);
}

export default async function ProjectsPage() {
  const session = await getSession();
  requireLogin(session);
  const [projectList, deletedProjectList] = await Promise.all([
    listProjects(db, session),
    listDeletedProjects(db, session),
  ]);

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>プロジェクト一覧</Title>
        <CreateProjectButton />
      </Group>

      {projectList.length === 0 ? (
        <Text c="dimmed">プロジェクトがまだありません。「プロジェクトを作成」から始めてください。</Text>
      ) : (
        <Stack gap="sm">
          {projectList.map((project) => (
            <Card key={project.id} withBorder padding="md">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                  {/*
                    Text の polymorphic `component` prop に next/link の Link を直接渡すと、
                    Server Component（本ファイル）から Client Component（Mantine Text）の境界を
                    関数値のまま越えようとして "Functions cannot be passed directly to Client
                    Components" で実行時エラーになる（`next dev` 実機起動で確認済み）。
                    Link で Text を包む形（どちらも解決済みの JSX 要素として渡す）にすれば
                    関数そのものを props として越境させずに済む。
                  */}
                  <Link href={`/projects/${project.id}/tasks`}>
                    <Text component="span" fw={600} size="lg">
                      {project.name}
                    </Text>
                  </Link>
                  {project.description ? (
                    <Text size="sm" c="dimmed">
                      {project.description}
                    </Text>
                  ) : null}
                </Stack>
                <Group gap="xs" wrap="nowrap">
                  <EditProjectButton
                    project={{ id: project.id, name: project.name, description: project.description }}
                  />
                  <DeleteProjectButton projectId={project.id} projectName={project.name} />
                </Group>
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      {/*
        削除済みプロジェクト（Issue #65）。以前は論理削除したあと復元する手段が
        どこにも無く、30日後に配下タスクごと物理削除されるまで取り戻せなかった。
        件数が 0 のときはセクションごと出さない（通常はここが空なので、常時出すと
        一覧のノイズになる）。
      */}
      {deletedProjectList.length > 0 ? (
        <Stack gap="sm" mt="xl">
          <Title order={3} size="h5" c="dimmed">
            削除済みプロジェクト
          </Title>
          <Text size="sm" c="dimmed">
            削除から30日を過ぎると、配下のタスクごと完全に削除されます。復元できるのは
            プロジェクトの owner だけです。
          </Text>
          {deletedProjectList.map((project) => (
            <Card key={project.id} withBorder padding="md" bg="var(--mantine-color-default-hover)">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                  <Text fw={600} size="lg" c="dimmed">
                    {project.name}
                  </Text>
                  <Text size="sm" c="dimmed">
                    削除日時: {formatDeletedAt(project.deletedAt)}
                  </Text>
                </Stack>
                <RestoreProjectButton projectId={project.id} projectName={project.name} />
              </Group>
            </Card>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}
