import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../db/client";
import { projectMembers, projects, taskAssignees, taskDependencies, tasks } from "../db/schema";
import { insertTestUsers } from "../db/testHelpers";
import { purgeExpiredTrash } from "./purge";

const DAY_MS = 24 * 60 * 60 * 1000;

/** テスト用の「今」を固定する。相対日数計算をブレさせないため。 */
const NOW = new Date("2026-08-07T00:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe("purgeExpiredTrash（M1 #9c / §4.4(a)(b)）", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-purge-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    await insertTestUsers(handle.db, ["owner-1"]);

    const [project] = await handle.db.insert(projects).values({ name: "P" }).returning();
    if (!project) {
      throw new Error("Failed to create test project");
    }
    projectId = project.id;
  });

  afterEach(() => {
    try {
      handle.client.close();
    } finally {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function insertTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
    const [task] = await handle.db
      .insert(tasks)
      .values({
        projectId,
        title: "タスク",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        ...overrides,
      })
      .returning();
    if (!task) {
      throw new Error("Failed to create test task");
    }
    return task;
  }

  /** 孤児レコードが0件であることを検証する共通アサーション（§4.4(b) の必須要求）。 */
  async function expectNoOrphans() {
    const allTasks = await handle.db.select().from(tasks);
    const taskIds = new Set(allTasks.map((t) => t.id));

    const allAssignees = await handle.db.select().from(taskAssignees);
    for (const assignee of allAssignees) {
      expect(taskIds.has(assignee.taskId)).toBe(true);
    }

    const allDependencies = await handle.db.select().from(taskDependencies);
    for (const dependency of allDependencies) {
      expect(taskIds.has(dependency.predecessorId)).toBe(true);
      expect(taskIds.has(dependency.successorId)).toBe(true);
    }

    const allProjects = await handle.db.select().from(projects);
    const projectIds = new Set(allProjects.map((p) => p.id));
    for (const task of allTasks) {
      expect(projectIds.has(task.projectId)).toBe(true);
    }

    const allMembers = await handle.db.select().from(projectMembers);
    for (const member of allMembers) {
      expect(projectIds.has(member.projectId)).toBe(true);
    }
  }

  it("何も削除済みでなければ何もしない", async () => {
    await insertTask();

    const result = await purgeExpiredTrash(handle.db, NOW);

    expect(result).toEqual({
      purgedProjectCount: 0,
      purgedTaskCount: 0,
      purgedAssigneeCount: 0,
      purgedDependencyCount: 0,
      purgedMemberCount: 0,
    });
    await expectNoOrphans();
  });

  it("30日超前に削除されたタスクを、担当者・依存関係もろとも物理削除する（孤児0件）", async () => {
    const predecessor = await insertTask({ title: "前工程" });
    const target = await insertTask({
      title: "対象タスク",
      deletedAt: daysAgo(31),
    });
    const successor = await insertTask({ title: "後工程" });

    await handle.db.insert(taskAssignees).values({ taskId: target.id, userId: "u1" });
    await handle.db.insert(taskDependencies).values([
      { projectId, predecessorId: predecessor.id, successorId: target.id },
      { projectId, predecessorId: target.id, successorId: successor.id },
    ]);

    const result = await purgeExpiredTrash(handle.db, NOW);

    expect(result.purgedProjectCount).toBe(0);
    expect(result.purgedTaskCount).toBe(1);
    expect(result.purgedAssigneeCount).toBe(1);
    expect(result.purgedDependencyCount).toBe(2);

    const remainingTask = await handle.db.select().from(tasks).where(eq(tasks.id, target.id));
    expect(remainingTask).toHaveLength(0);

    const remainingAssignees = await handle.db
      .select()
      .from(taskAssignees)
      .where(eq(taskAssignees.taskId, target.id));
    expect(remainingAssignees).toHaveLength(0);

    const remainingDependencies = await handle.db.select().from(taskDependencies);
    expect(remainingDependencies).toHaveLength(0);

    // 依存の反対側（predecessor / successor）自体は生存タスクなので残る。
    const predecessorAfter = await handle.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, predecessor.id));
    expect(predecessorAfter).toHaveLength(1);
    const successorAfter = await handle.db.select().from(tasks).where(eq(tasks.id, successor.id));
    expect(successorAfter).toHaveLength(1);

    await expectNoOrphans();
  });

  it("30日以内に削除されたタスクは物理削除しない", async () => {
    const recentlyDeleted = await insertTask({
      title: "最近削除",
      deletedAt: daysAgo(29),
    });

    const result = await purgeExpiredTrash(handle.db, NOW);

    expect(result.purgedTaskCount).toBe(0);
    const remaining = await handle.db.select().from(tasks).where(eq(tasks.id, recentlyDeleted.id));
    expect(remaining).toHaveLength(1);
    await expectNoOrphans();
  });

  it("ちょうど30日（境界値）は物理削除の対象にしない", async () => {
    const boundary = await insertTask({
      title: "ちょうど30日",
      deletedAt: daysAgo(30),
    });

    const result = await purgeExpiredTrash(handle.db, NOW);

    expect(result.purgedTaskCount).toBe(0);
    const remaining = await handle.db.select().from(tasks).where(eq(tasks.id, boundary.id));
    expect(remaining).toHaveLength(1);
  });

  it("30日超前に削除されたプロジェクトは、配下タスク（個別には未削除でも）ごと物理削除する（孤児0件）", async () => {
    const [expiredProject] = await handle.db
      .insert(projects)
      .values({ name: "削除済みPJ", deletedAt: daysAgo(31) })
      .returning();
    if (!expiredProject) {
      throw new Error("Failed to create expired project");
    }

    await handle.db
      .insert(projectMembers)
      .values({ projectId: expiredProject.id, userId: "owner-1", role: "owner" });

    const [aliveTaskInExpiredProject] = await handle.db
      .insert(tasks)
      .values({
        projectId: expiredProject.id,
        title: "PJ削除の巻き添えになるタスク（個別には未削除）",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      })
      .returning();
    if (!aliveTaskInExpiredProject) {
      throw new Error("Failed to create test task");
    }

    await handle.db
      .insert(taskAssignees)
      .values({ taskId: aliveTaskInExpiredProject.id, userId: "u1" });

    const [otherTaskInExpiredProject] = await handle.db
      .insert(tasks)
      .values({
        projectId: expiredProject.id,
        title: "同PJ内の別タスク",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      })
      .returning();
    if (!otherTaskInExpiredProject) {
      throw new Error("Failed to create test task");
    }

    await handle.db.insert(taskDependencies).values({
      projectId: expiredProject.id,
      predecessorId: aliveTaskInExpiredProject.id,
      successorId: otherTaskInExpiredProject.id,
    });

    // 無関係の生存プロジェクトとそのタスクは影響を受けないことも確認する。
    const untouchedTask = await insertTask({ title: "無関係の生存タスク" });

    const result = await purgeExpiredTrash(handle.db, NOW);

    expect(result.purgedProjectCount).toBe(1);
    expect(result.purgedTaskCount).toBe(2);
    expect(result.purgedAssigneeCount).toBe(1);
    expect(result.purgedDependencyCount).toBe(1);
    expect(result.purgedMemberCount).toBe(1);

    const remainingProject = await handle.db
      .select()
      .from(projects)
      .where(eq(projects.id, expiredProject.id));
    expect(remainingProject).toHaveLength(0);

    const remainingMembers = await handle.db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.projectId, expiredProject.id));
    expect(remainingMembers).toHaveLength(0);

    const remainingTasksInProject = await handle.db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, expiredProject.id));
    expect(remainingTasksInProject).toHaveLength(0);

    const untouchedAfter = await handle.db.select().from(tasks).where(eq(tasks.id, untouchedTask.id));
    expect(untouchedAfter).toHaveLength(1);

    await expectNoOrphans();
  });

  it("TOCTOU対策: 削除条件をDELETE文自身に持たせているため、直前に復元されたタスクは物理削除しない", async () => {
    // 30日超前に削除された状態で作り、その後すぐに復元する（deleted_at を NULL に戻す）。
    // 「対象をSELECTで確定してからID配列でDELETEする」実装だと、SELECT時点では
    // 削除済みだったこのタスクが誤って物理削除されてしまう回帰を防ぐためのテスト。
    const restored = await insertTask({
      title: "直前に復元されたタスク",
      deletedAt: daysAgo(31),
    });
    await handle.db.update(tasks).set({ deletedAt: null }).where(eq(tasks.id, restored.id));

    const result = await purgeExpiredTrash(handle.db, NOW);

    expect(result.purgedTaskCount).toBe(0);
    const remaining = await handle.db.select().from(tasks).where(eq(tasks.id, restored.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.deletedAt).toBeNull();
  });

  it("生存中のプロジェクトは物理削除しない", async () => {
    const result = await purgeExpiredTrash(handle.db, NOW);

    expect(result.purgedProjectCount).toBe(0);
    const remaining = await handle.db.select().from(projects).where(eq(projects.id, projectId));
    expect(remaining).toHaveLength(1);
  });
  /**
   * リスク R-7 の「孤児 0 件を結合テストで検証する」を実体にする。
   *
   * 本番（Turso の HTTP 接続）は接続ごとに `PRAGMA foreign_keys = ON` を担保できず
   * FK が無言で効かない。一方ローカルのファイル DB は既定で FK が有効なので、
   * **同じバグがローカルでは例外、本番では静かな孤児**という形で現れる。
   * ここでは本番相当（FK OFF）に切り替えたうえで孤児を SQL で数える。
   */
  describe("purge 後に孤児が残らない（リスク R-7）", () => {
    async function countOrphans() {
      const rows = await handle.client.execute(`
        select
          (select count(*) from tasks t
             where t.parent_id is not null
               and not exists (select 1 from tasks p where p.id = t.parent_id)) as taskParent,
          (select count(*) from tasks t
             where not exists (select 1 from projects p where p.id = t.project_id)) as taskProject,
          (select count(*) from task_assignees a
             where not exists (select 1 from tasks t where t.id = a.task_id)) as assignee,
          (select count(*) from task_dependencies d
             where not exists (select 1 from tasks t where t.id = d.predecessor_id)
                or not exists (select 1 from tasks t where t.id = d.successor_id)) as dependency,
          (select count(*) from project_members m
             where not exists (select 1 from projects p where p.id = m.project_id)) as member
      `);
      return rows.rows[0] as unknown as Record<string, number>;
    }

    beforeEach(async () => {
      // 本番（Turso HTTP）と同じ「FK が効かない」状態にする。有効なままだと
      // 孤児ではなく SQLITE_CONSTRAINT で落ちてしまい、本番の壊れ方を再現できない。
      await handle.client.execute("PRAGMA foreign_keys = OFF");
    });

    it("親だけが期限切れで子が残る場合でも、子の parent_id が宙吊りにならない", async () => {
      const parent = await insertTask({ title: "親", deletedAt: daysAgo(40) });
      const child = await insertTask({ title: "子", parentId: parent.id });

      const result = await purgeExpiredTrash(handle.db, NOW);

      expect(result.purgedTaskCount).toBe(1);
      const [remainingChild] = await handle.db.select().from(tasks).where(eq(tasks.id, child.id));
      expect(remainingChild?.parentId).toBeNull();
      expect(await countOrphans()).toEqual({
        taskParent: 0,
        taskProject: 0,
        assignee: 0,
        dependency: 0,
        member: 0,
      });
    });

    it("親が古く削除・子が新しく削除でも孤児が残らない", async () => {
      const parent = await insertTask({ title: "親", deletedAt: daysAgo(40) });
      await insertTask({ title: "子", parentId: parent.id, deletedAt: daysAgo(1) });

      await purgeExpiredTrash(handle.db, NOW);

      expect(await countOrphans()).toEqual({
        taskParent: 0,
        taskProject: 0,
        assignee: 0,
        dependency: 0,
        member: 0,
      });
    });
  });
});
