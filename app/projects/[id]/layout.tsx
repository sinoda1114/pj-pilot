import { notFound } from "next/navigation";
import { Stack, Title } from "@mantine/core";
import { db } from "../../../lib/db";
import { getActiveProject } from "../../../lib/db/queries";
import { ProjectTabs } from "../../../components/projects/ProjectTabs";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getActiveProject(db, id);

  if (!project) {
    notFound();
  }

  return (
    <Stack gap="md">
      <Title order={2}>{project.name}</Title>
      <ProjectTabs projectId={id} />
      {children}
    </Stack>
  );
}
