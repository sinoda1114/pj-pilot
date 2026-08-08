/**
 * Gantt画面のドラッグ連動 Server Actions のテスト（M4）。
 *
 * `app/projects/[id]/tasks/actions.test.ts` と同じパターンで、`db` シングルトンと
 * `getSession()` を `vi.mock` で差し替える。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../../../../lib/db/client";
import { projects, taskDependencies, tasks } from "../../../../lib/db/schema";
import type { AuthSession } from "../../../../lib/auth/types";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  session: null as AuthSession | null,
}));

vi.mock("../../../../lib/db", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("../../../../lib/auth/session", () => ({
  getSession: async () => state.session,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const {
  moveTaskAction,
  resizeTaskEndAction,
  undoDateChangesAction,
  createDependencyAction,
  deleteDependencyAction,
} = await import("./actions");

const SESSION: AuthSession = { userId: "u1" };

describe("app/projects/[id]/gantt/actions", () => {
  let dir: string;
  let handle: DbHandle;
  let projectId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pj-pilot-gantt-actions-test-"));
    handle = createDb(`file:${join(dir, "test.db")}`);
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    state.db = handle.db;
  });

  afterAll(() => {
    try {
      handle.client.close();
    } finally {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  afterEach(() => {
    state.session = null;
  });

  async function setupProjectWithChain(overrides?: { dependencySyncEnabled?: boolean }) {
    const [project] = await handle.db
      .insert(projects)
      .values({ name: "P", dependencySyncEnabled: overrides?.dependencySyncEnabled ?? true })
      .returning();
    if (!project) {
      throw new Error("Failed to create test project");
    }
    projectId = project.id;

    const [a] = await handle.db
      .insert(tasks)
      .values({ projectId, title: "A", startDate: "2026-08-01", endDate: "2026-08-03" })
      .returning();
    const [b] = await handle.db
      .insert(tasks)
      .values({ projectId, title: "B", startDate: "2026-08-04", endDate: "2026-08-06" })
      .returning();
    if (!a || !b) {
      throw new Error("Failed to create test tasks");
    }
    await handle.db.insert(taskDependencies).values({
      projectId,
      predecessorId: a.id,
      successorId: b.id,
    });

    return { project, a, b };
  }

  describe("moveTaskAction", () => {
    it("未ログインならUnauthorizedのメッセージで失敗する", async () => {
      const { a } = await setupProjectWithChain();

      const result = await moveTaskAction(projectId, a.id, 3, false);

      expect(result.ok).toBe(false);
    });

    it("後続タスクをギャップ維持で連動して動かし、DBに反映する", async () => {
      state.session = SESSION;
      const { a, b } = await setupProjectWithChain();

      const result = await moveTaskAction(projectId, a.id, 3, false);

      expect(result.ok).toBe(true);
      const [updatedA] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
      const [updatedB] = await handle.db.select().from(tasks).where(eq(tasks.id, b.id));
      expect(updatedA).toMatchObject({ startDate: "2026-08-04", endDate: "2026-08-06" });
      expect(updatedB).toMatchObject({ startDate: "2026-08-07", endDate: "2026-08-09" });
    });

    it("dependencySyncEnabledがfalseなら本人のみ動く", async () => {
      state.session = SESSION;
      const { a, b } = await setupProjectWithChain({ dependencySyncEnabled: false });

      await moveTaskAction(projectId, a.id, 3, false);

      const [updatedB] = await handle.db.select().from(tasks).where(eq(tasks.id, b.id));
      expect(updatedB).toMatchObject({ startDate: "2026-08-04", endDate: "2026-08-06" });
    });

    it("bypassSync（Shiftドラッグ相当）がtrueなら本人のみ動く", async () => {
      state.session = SESSION;
      const { a, b } = await setupProjectWithChain();

      await moveTaskAction(projectId, a.id, 3, true);

      const [updatedB] = await handle.db.select().from(tasks).where(eq(tasks.id, b.id));
      expect(updatedB).toMatchObject({ startDate: "2026-08-04", endDate: "2026-08-06" });
    });

    it("存在しないタスクIDは失敗する", async () => {
      state.session = SESSION;
      await setupProjectWithChain();

      const result = await moveTaskAction(projectId, "nonexistent", 3, false);

      expect(result.ok).toBe(false);
    });

    it.each([NaN, Infinity, -Infinity, 1.5, 100000])(
      "不正なdeltaDays（%s）は失敗し、DBを変更しない",
      async (deltaDays) => {
        state.session = SESSION;
        const { a } = await setupProjectWithChain();

        const result = await moveTaskAction(projectId, a.id, deltaDays, false);

        expect(result.ok).toBe(false);
        const [unchanged] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
        expect(unchanged).toMatchObject({ startDate: "2026-08-01", endDate: "2026-08-03" });
      },
    );
  });

  describe("resizeTaskEndAction", () => {
    it("終了日のみをΔシフトする（開始日は変えない）", async () => {
      state.session = SESSION;
      const { a } = await setupProjectWithChain();

      const result = await resizeTaskEndAction(projectId, a.id, 2, false);

      expect(result.ok).toBe(true);
      const [updatedA] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
      expect(updatedA).toMatchObject({ startDate: "2026-08-01", endDate: "2026-08-05" });
    });
  });

  describe("resizeTaskEndAction の不変条件", () => {
    it("終了日が開始日より前になるリサイズは拒否し、DBを変更しない", async () => {
      // SVAR 側にバー幅の clamp があるため Gantt UI からは起こせないが、
      // Server Action は直接呼べるため守る。実測では -30 で
      // 2026-08-10〜2026-07-13 という逆転データが書き込めてしまっていた。
      state.session = SESSION;
      const { a } = await setupProjectWithChain();

      const result = await resizeTaskEndAction(projectId, a.id, -30, true);

      expect(result.ok).toBe(false);
      const [unchanged] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
      expect(unchanged).toMatchObject({ startDate: "2026-08-01", endDate: "2026-08-03" });
    });
  });

  describe("undoDateChangesAction", () => {
    it("指定した日付にタスクを戻す", async () => {
      state.session = SESSION;
      const { a, b } = await setupProjectWithChain();
      await moveTaskAction(projectId, a.id, 3, false);

      const result = await undoDateChangesAction(projectId, [
        { id: a.id, startDate: "2026-08-01", endDate: "2026-08-03" },
        { id: b.id, startDate: "2026-08-04", endDate: "2026-08-06" },
      ]);

      expect(result.ok).toBe(true);
      const [restoredA] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
      const [restoredB] = await handle.db.select().from(tasks).where(eq(tasks.id, b.id));
      expect(restoredA).toMatchObject({ startDate: "2026-08-01", endDate: "2026-08-03" });
      expect(restoredB).toMatchObject({ startDate: "2026-08-04", endDate: "2026-08-06" });
    });

    it("他プロジェクトのタスクIDを含む場合は失敗し、そのタスクのDBを変更しない（IDOR対策）", async () => {
      state.session = SESSION;
      const { a } = await setupProjectWithChain();
      const [otherProject] = await handle.db.insert(projects).values({ name: "他PJ" }).returning();
      if (!otherProject) {
        throw new Error("Failed to create other test project");
      }
      const [otherTask] = await handle.db
        .insert(tasks)
        .values({
          projectId: otherProject.id,
          title: "他PJのタスク",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
        })
        .returning();
      if (!otherTask) {
        throw new Error("Failed to create other test task");
      }

      const result = await undoDateChangesAction(projectId, [
        { id: a.id, startDate: "2026-08-01", endDate: "2026-08-03" },
        { id: otherTask.id, startDate: "1999-01-01", endDate: "1999-01-02" },
      ]);

      expect(result.ok).toBe(false);
      const [unchangedOtherTask] = await handle.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, otherTask.id));
      expect(unchangedOtherTask).toMatchObject({ startDate: "2026-08-01", endDate: "2026-08-05" });
    });

    it("不正な日付文字列を含む場合は失敗する", async () => {
      state.session = SESSION;
      const { a } = await setupProjectWithChain();

      const result = await undoDateChangesAction(projectId, [
        { id: a.id, startDate: "not-a-date", endDate: "2026-08-03" },
      ]);

      expect(result.ok).toBe(false);
    });

    it("終了日が開始日より前なら失敗する（他の全経路が守っている不変条件）", async () => {
      // `lib/tasks/service.ts` の `assertValidDateRange` はフォーム経由の全更新で
      // これを弾く。ここだけ抜けていると逆転した日付を注入でき、Gantt の描画と
      // 伝播計算が壊れたうえ、UI からは直せなくなる。
      state.session = SESSION;
      const { a } = await setupProjectWithChain();

      const result = await undoDateChangesAction(projectId, [
        { id: a.id, startDate: "2031-01-01", endDate: "2030-01-02" },
      ]);

      expect(result.ok).toBe(false);
      const [unchanged] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
      expect(unchanged).toMatchObject({ startDate: "2026-08-01", endDate: "2026-08-03" });
    });

    it("削除済みタスクが逆転した日付を持っていても、残りのタスクは戻せる", async () => {
      // 検証より先に削除済みを落とさないと、ゴミ箱の中の旧バグ由来の逆転データで
      // payload 全体が弾かれ、「削除済みは除外して残りは戻す」が働かない。
      state.session = SESSION;
      const { a, b } = await setupProjectWithChain();
      await handle.db
        .update(tasks)
        .set({ deletedAt: new Date(), startDate: "2026-08-10", endDate: "2026-07-13" })
        .where(eq(tasks.id, a.id));

      const result = await undoDateChangesAction(projectId, [
        // 削除済み a のスナップショットは逆転したまま
        { id: a.id, startDate: "2026-08-10", endDate: "2026-07-13" },
        { id: b.id, startDate: "2026-08-04", endDate: "2026-08-06" },
      ]);

      expect(result.ok).toBe(true);
      const [restored] = await handle.db.select().from(tasks).where(eq(tasks.id, b.id));
      expect(restored).toMatchObject({ startDate: "2026-08-04", endDate: "2026-08-06" });
    });

    it("論理削除済みタスクは書き換えず、残りのタスクは戻す", async () => {
      // `listAllTasksByProject` は削除済みも返す（伝播が「後続が削除済みか」を見るために
      // 必要）。絞らないとゴミ箱の中のタスクの日付まで書き換えられる。
      // 一方で payload 全体を拒否すると、ドラッグから「元に戻す」までの間に他の誰かが
      // 1件削除しただけで、正常なタスクまで戻せなくなる。該当分だけ落として残りは戻す。
      state.session = SESSION;
      const { a, b } = await setupProjectWithChain();
      await handle.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, a.id));

      const result = await undoDateChangesAction(projectId, [
        { id: a.id, startDate: "1999-01-01", endDate: "1999-01-02" },
        { id: b.id, startDate: "2026-08-04", endDate: "2026-08-06" },
      ]);

      expect(result.ok).toBe(true);
      // 削除済みの a は書き換わっていない
      const [deleted] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
      expect(deleted).toMatchObject({ startDate: "2026-08-01", endDate: "2026-08-03" });
      // 生存している b は戻っている
      const [restored] = await handle.db.select().from(tasks).where(eq(tasks.id, b.id));
      expect(restored).toMatchObject({ startDate: "2026-08-04", endDate: "2026-08-06" });
    });

    it("逆転した子を持つサマリーがあっても、正常なタスクのドラッグは通る", async () => {
      // サマリーの日付は子から導出されるため、子が1件でも逆転していると
      // 再集計結果（after）が逆転する。実測: before 2026-08-01〜08-20 が
      // after 2026-08-13〜07-16 になる。`result.changes` 全体を見て弾く実装だと、
      // この巻き添えで正常な操作まで拒否されていた（Cursor Bugbot の指摘）。
      state.session = SESSION;
      const { project, a } = await setupProjectWithChain();
      const [summary] = await handle.db
        .insert(tasks)
        .values({
          projectId: project.id,
          title: "S",
          type: "summary",
          startDate: "2026-08-01",
          endDate: "2026-08-20",
        })
        .returning();
      if (!summary) throw new Error("unreachable");
      // 逆転した子（旧バグで書き込まれたデータを模す）を summary 配下に置き、
      // a からの依存で動くようにする
      const [child] = await handle.db
        .insert(tasks)
        .values({
          projectId: project.id,
          parentId: summary.id,
          title: "C",
          startDate: "2026-08-10",
          endDate: "2026-07-13",
        })
        .returning();
      if (!child) throw new Error("unreachable");
      await handle.db
        .insert(taskDependencies)
        .values({ projectId: project.id, predecessorId: a.id, successorId: child.id });

      const result = await moveTaskAction(projectId, a.id, 3, false);

      expect(result.ok).toBe(true);
    });

    it("既に日付が逆転している行があっても、正常なタスクのドラッグは通る", async () => {
      // `after` の逆転を一律で弾くと、旧バグ等で既に逆転している行が1つでもあるだけで
      // そこへ伝播する無関係なタスクまで動かせなくなり、逆転行自身も修復できなくなる。
      state.session = SESSION;
      const { a, b } = await setupProjectWithChain();
      // b を「既に逆転している」状態にする（旧バグで書き込まれたデータを模す）
      await handle.db
        .update(tasks)
        .set({ startDate: "2026-08-10", endDate: "2026-07-13" })
        .where(eq(tasks.id, b.id));

      const result = await moveTaskAction(projectId, a.id, 3, false);

      expect(result.ok).toBe(true);
      const [movedA] = await handle.db.select().from(tasks).where(eq(tasks.id, a.id));
      expect(movedA).toMatchObject({ startDate: "2026-08-04", endDate: "2026-08-06" });
    });
  });

  describe("createDependencyAction / deleteDependencyAction", () => {
    it("依存を新規作成できる（実DBの依存IDが返る）", async () => {
      state.session = SESSION;
      const { project, b } = await setupProjectWithChain();
      const [c] = await handle.db
        .insert(tasks)
        .values({ projectId: project.id, title: "C", startDate: "2026-08-07", endDate: "2026-08-09" })
        .returning();
      if (!c) {
        throw new Error("Failed to create test task");
      }

      const result = await createDependencyAction(project.id, b.id, c.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // クライアント側（GanttView）が `add-link` に渡すIDとしてそのまま使うため、
      // SVAR側が独自採番したものではなく実DBのIDが返っている必要がある
      // （Cursor Bugbot指摘: これが無いと後の delete-link が失敗する）。
      const [created] = await handle.db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.id, result.dependencyId));
      expect(created).toMatchObject({ predecessorId: b.id, successorId: c.id });
    });

    it("循環になる依存の作成は失敗する", async () => {
      state.session = SESSION;
      const { a, b } = await setupProjectWithChain();

      const result = await createDependencyAction(projectId, b.id, a.id);

      expect(result.ok).toBe(false);
    });

    it("依存を削除できる", async () => {
      state.session = SESSION;
      await setupProjectWithChain();
      // DBはテスト間で使い回されるため、テーブル全体ではなく今回作成した
      // `projectId` に属する依存に絞って取得する。
      const [dependency] = await handle.db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.projectId, projectId));
      if (!dependency) {
        throw new Error("Failed to find test dependency");
      }

      const result = await deleteDependencyAction(projectId, dependency.id);

      expect(result.ok).toBe(true);
      const remaining = await handle.db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.id, dependency.id));
      expect(remaining).toHaveLength(0);
    });

    it("他プロジェクトの依存IDを指定した場合は失敗し、削除しない（IDOR対策）", async () => {
      state.session = SESSION;
      await setupProjectWithChain();

      const [otherProject] = await handle.db.insert(projects).values({ name: "他PJ" }).returning();
      if (!otherProject) {
        throw new Error("Failed to create other test project");
      }
      const [otherA] = await handle.db
        .insert(tasks)
        .values({
          projectId: otherProject.id,
          title: "他PJ-A",
          startDate: "2026-08-01",
          endDate: "2026-08-03",
        })
        .returning();
      const [otherB] = await handle.db
        .insert(tasks)
        .values({
          projectId: otherProject.id,
          title: "他PJ-B",
          startDate: "2026-08-04",
          endDate: "2026-08-06",
        })
        .returning();
      if (!otherA || !otherB) {
        throw new Error("Failed to create other test tasks");
      }
      const [otherDependency] = await handle.db
        .insert(taskDependencies)
        .values({ projectId: otherProject.id, predecessorId: otherA.id, successorId: otherB.id })
        .returning();
      if (!otherDependency) {
        throw new Error("Failed to create other test dependency");
      }

      // `projectId`（このブロック冒頭で作った依存関係のプロジェクト）を指定しつつ、
      // 削除対象のIDだけ他プロジェクトの依存を渡す（Cursor Bugbot指摘のIDOR）。
      const result = await deleteDependencyAction(projectId, otherDependency.id);

      expect(result.ok).toBe(false);
      const stillExists = await handle.db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.id, otherDependency.id));
      expect(stillExists).toHaveLength(1);
    });
  });
});
