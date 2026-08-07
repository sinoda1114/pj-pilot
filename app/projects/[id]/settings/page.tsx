/**
 * プロジェクト設定画面（M5 #29）。現状は依存連動のON/OFFトグルのみを扱う
 * （§6のルート定義にあるメンバー管理・PJ削除は本Issueのスコープ外）。
 */
import { notFound } from "next/navigation";
import { Stack, Title } from "@mantine/core";
import { requireLogin } from "../../../../lib/auth/authz";
import { getSession } from "../../../../lib/auth/session";
import { db } from "../../../../lib/db";
import { getActiveProject } from "../../../../lib/db/queries";
import { ProjectSettingsForm } from "../../../../components/projects/ProjectSettingsForm";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;

  const session = await getSession();
  requireLogin(session);

  const project = await getActiveProject(db, projectId);
  if (!project) {
    notFound();
  }

  return (
    <Stack gap="md">
      <Title order={3}>設定</Title>
      <ProjectSettingsForm
        projectId={project.id}
        dependencySyncEnabled={project.dependencySyncEnabled}
      />
    </Stack>
  );
}
