"use client";

/**
 * プロジェクト名称・説明の編集モーダル（M2 #13）。
 * 決定 D-08/§6: 編集自体は全ログインユーザーに開く（削除だけが owner 限定）。
 */
import { useState } from "react";
import { Button, Group, Modal, Stack, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useRouter } from "next/navigation";
import { updateProjectAction } from "../../app/projects/actions";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "../../lib/projects/constants";

interface FormValues {
  name: string;
  description: string;
}

export function EditProjectButton({
  project,
}: {
  project: { id: string; name: string; description: string | null };
}) {
  const [opened, setOpened] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  const form = useForm<FormValues>({
    initialValues: { name: project.name, description: project.description ?? "" },
    validate: {
      name: (value) => (value.trim().length === 0 ? "プロジェクト名を入力してください" : null),
    },
  });

  const open = () => {
    form.setValues({ name: project.name, description: project.description ?? "" });
    setOpened(true);
  };

  const close = () => {
    if (submitting) return;
    setOpened(false);
  };

  const handleSubmit = form.onSubmit(async (values) => {
    setSubmitting(true);
    try {
      const result = await updateProjectAction(project.id, {
        name: values.name,
        description: values.description.trim() || null,
      });

      if (result.ok) {
        notifications.show({
          color: "green",
          title: "更新しました",
          message: `「${values.name.trim()}」を更新しました`,
        });
        setOpened(false);
        router.refresh();
      } else {
        notifications.show({
          color: "red",
          title: "更新に失敗しました",
          message: result.message,
        });
      }
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <>
      <Button
        variant="subtle"
        size="xs"
        onClick={open}
        data-testid={`edit-project-${project.id}`}
      >
        編集
      </Button>
      <Modal opened={opened} onClose={close} title="プロジェクトを編集" centered closeOnClickOutside={!submitting}>
        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="プロジェクト名"
              data-autofocus
              withAsterisk
              maxLength={PROJECT_NAME_MAX_LENGTH}
              disabled={submitting}
              {...form.getInputProps("name")}
            />
            <Textarea
              label="説明"
              placeholder="任意"
              autosize
              minRows={2}
              maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
              disabled={submitting}
              {...form.getInputProps("description")}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={close} disabled={submitting}>
                キャンセル
              </Button>
              <Button type="submit" loading={submitting}>
                保存
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
