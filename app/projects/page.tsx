import Link from "next/link";
import { Card, Group, Stack, Text, Title } from "@mantine/core";
import { CreateProjectButton } from "../../components/projects/CreateProjectButton";
import { DeleteProjectButton } from "../../components/projects/DeleteProjectButton";
import { EditProjectButton } from "../../components/projects/EditProjectButton";
import { getSession } from "../../lib/auth/session";
import { db } from "../../lib/db";
import { listProjects } from "../../lib/projects/service";

export default async function ProjectsPage() {
  const session = await getSession();
  const projectList = await listProjects(db, session);

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
    </Stack>
  );
}
