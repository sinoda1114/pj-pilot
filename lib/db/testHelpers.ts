/**
 * テスト専用ヘルパー。`project_members.userId` / `task_assignees.userId` は
 * `user.id` への外部キー制約を持つ（フォローアップ課題）ため、ダミーの
 * userId文字列（"owner-1"・"alice"等）を使うテストでは、対応する`user`行を
 * 事前に作成しておく必要がある。
 */
import type { DbHandle } from "./client";
import { user } from "./schema";

export async function insertTestUsers(db: DbHandle["db"], userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.com` })));
}
