/**
 * ダッシュボードの集計（Phase 2 §6.2 / M9 #46）。
 *
 * 「タスク配列 → 集計結果」の純粋関数だけを置く。DB も React も触らない。
 *
 * SQL の GROUP BY に寄せない理由は §6.4 のとおり。①DB なしでテストが書ける、
 * ②Phase 1 から続く「クエリは queries.ts / 計算は純粋関数」の構成と一貫する、の2点。
 * PJ 数・タスク数が数千を超えたら SQL 集計へ寄せる（リスク R-4）。
 */

import { BOARD_STATUSES, type BoardStatus } from "../board/service";

/**
 * 集計に必要な最小限の形。`tasks` テーブルの行をそのまま渡せるが、
 * テストからは必要なフィールドだけを組み立てて渡せるように絞ってある。
 */
export interface DashboardTask {
  id: string;
  projectId: string;
  title: string;
  status: BoardStatus;
  type: "task" | "summary" | "milestone";
  /** date-only 文字列（'YYYY-MM-DD'）。 */
  endDate: string;
}

export interface DashboardProject {
  id: string;
  name: string;
}

export interface ProjectProgress {
  projectId: string;
  name: string;
  /** 対象タスクの総数。 */
  total: number;
  /** そのうち完了しているもの。 */
  done: number;
  /**
   * 完了率（0〜100 の整数）。**タスクが 0 件のときは `null`**。
   * 0% と「そもそもタスクが無い」を取り違えないため。
   */
  percent: number | null;
}

/**
 * 集計対象は `type = 'task'` のみ（決定 P2-02）。
 *
 * - `summary` は子の集計行なので、含めると二重計上になる。
 * - `milestone` は決定 D-12 により Phase 1 の UI から作成できず、実データが存在しない。
 *
 * カンバン（`lib/db/queries.ts` の `listActiveBoardTasksByProject`）と同じ基準に
 * 揃えてある。片方だけ基準を変えると、ボードの件数とダッシュボードの件数が食い違う。
 */
function isCountable(task: DashboardTask): boolean {
  return task.type === "task";
}

/** ステータスごとの件数。該当0件のステータスも必ず 0 として含める。 */
export function countByStatus(tasks: readonly DashboardTask[]): Record<BoardStatus, number> {
  const counts = Object.fromEntries(BOARD_STATUSES.map((status) => [status, 0])) as Record<
    BoardStatus,
    number
  >;

  for (const task of tasks) {
    if (isCountable(task)) {
      counts[task.status] += 1;
    }
  }

  return counts;
}

/**
 * 期限超過のタスク（終了日が今日より前、かつ未完了）を、期限の古い順に返す。
 *
 * `today` は呼び出し側が `todayInTimeZone("Asia/Tokyo")` で求めた date-only 文字列を渡す。
 * ここで `new Date()` を呼ばないのは、Vercel が UTC で動くため（§6.3 / 決定 P2-08）と、
 * テストで境界時刻を固定できるようにするため。
 *
 * 比較は date-only 文字列の辞書順で成立する（ゼロ埋めの固定長のため）。
 */
export function findOverdueTasks(tasks: readonly DashboardTask[], today: string): DashboardTask[] {
  return tasks
    .filter((task) => isCountable(task) && task.status !== "done" && task.endDate < today)
    .sort(
      (a, b) =>
        // 期限の古い順。同値のときは id で安定させ、描画順が揺れないようにする。
        a.endDate.localeCompare(b.endDate) || a.id.localeCompare(b.id),
    );
}

/**
 * プロジェクトごとの進捗率。**件数ベース**（`status = 'done'` の割合。決定 P2-07）。
 *
 * `progress` カラムの平均を採らないのは、手入力で未入力の 0 が多く、実態より低く
 * 出るため。`status` はカンバンとタスク一覧の両方で日常的に更新される値なので、
 * こちらのほうが実態を反映する。
 *
 * 戻り値は引数 `projects` の順序を保つ（呼び出し側で並べ替えられるように）。
 */
export function computeProjectProgress(
  projects: readonly DashboardProject[],
  tasks: readonly DashboardTask[],
): ProjectProgress[] {
  const countable = tasks.filter(isCountable);

  /**
   * 完了率を 0〜100 の整数で返す（タスク 0 件なら null）。
   *
   * **100% は「全件完了」のときだけ**にする。素の `Math.round` だと 200 件中 199 件
   * （99.5%）が 100% に切り上がり、「完了率 100% なのに未完了が残っている」という
   * 表示になるため、未完了が1件でもあれば 99% で止める。
   *
   * 逆側（300件中1件 → 0%）に同様のクランプは**入れない**。0% は「まだ実質
   * 動いていない」を素直に表しており、100% 側のような矛盾（「完了なのに残っている」）
   * を生まないため。1件でも完了していれば 1% と出したい場合は仕様を決め直す。
   */
  function toPercent(done: number, total: number): number | null {
    if (total === 0) {
      return null;
    }
    if (done === total) {
      return 100;
    }
    return Math.min(99, Math.round((done / total) * 100));
  }

  return projects.map((project) => {
    const own = countable.filter((task) => task.projectId === project.id);
    const done = own.filter((task) => task.status === "done").length;

    return {
      projectId: project.id,
      name: project.name,
      total: own.length,
      done,
      // タスクが無いプロジェクトは 0% ではなく null。画面側で「タスクなし」と出す。
      percent: toPercent(done, own.length),
    };
  });
}
