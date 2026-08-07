"use client";

/**
 * プロジェクト作成モーダル（M2 #13）。
 * ドット記法の compound component（Modal.Header 等）は実描画時に undefined になる
 * 既知バグがあるため使わず、Modal 本体の title/onClose props だけで構成する。
 */
import { useState } from "react";
import { Button, Group, Modal, Stack, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useRouter } from "next/navigation";
import { createProjectAction } from "../../app/projects/actions";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "../../lib/projects/constants";

interface FormValues {
  name: string;
  description: string;
}

export function CreateProjectButton() {
  const [opened, setOpened] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  const form = useForm<FormValues>({
    initialValues: { name: "", description: "" },
    validate: {
      name: (value) => (value.trim().length === 0 ? "プロジェクト名を入力してください" : null),
    },
  });

  const close = () => {
    if (submitting) return;
    setOpened(false);
    form.reset();
  };

  const handleSubmit = form.onSubmit(async (values) => {
    setSubmitting(true);
    try {
      const result = await createProjectAction({
        name: values.name,
        description: values.description.trim() || undefined,
      });

      if (result.ok) {
        notifications.show({
          color: "green",
          title: "作成しました",
          message: `「${values.name.trim()}」を作成しました`,
        });
        setOpened(false);
        form.reset();
        router.refresh();
      } else {
        notifications.show({
          color: "red",
          title: "作成に失敗しました",
          message: result.message,
        });
      }
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <>
      <Button onClick={() => setOpened(true)}>プロジェクトを作成</Button>
      <Modal opened={opened} onClose={close} title="プロジェクトを作成" centered closeOnClickOutside={!submitting}>
        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="プロジェクト名"
              placeholder="例: 基幹システム刷新"
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
                作成
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
