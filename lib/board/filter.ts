/**
 * カンバンボードの絞り込みの純粋関数（Phase 2 §5 / 未決事項 Q-3 の方針変更分）。
 *
 * 計画書 §9 の Q-3 では「カンバンにフィルターは付けない」を既定としていたが、
 * 方針が変わって付けることになった。
 *
 * `lib/board/order.ts` と同じ方針で、**DB も React も触らない**。
 * 「タスク配列 + 条件 → タスク配列」だけを扱い、境界条件はすべてここで潰す。
 * `BoardClient.tsx` 側は「state → この関数を適用 → 描画」の薄い層に徹する。
 *
 * 絞り込みの意味論:
 * - 条件が空（未指定 or 空配列）なら**絞り込まない**（全件を返す）。
 * - 種類の異なる条件どうしは **AND**（優先度が一致し、かつ担当者が一致）。
 * - 同じ条件の中の複数値は **OR**（「高」または「緊急」）。
 *
 * 依存を持たないよう、タスクは構造的な最小型（`FilterableTask`）で受ける。
 * `lib/db/schema` の `Task` はこれを満たすため、そのまま渡せる（ジェネリクスで
 * 元の型のまま返るので、呼び出し側で型が落ちない）。
 */

/**
 * 「担当者なし」を表す番兵値。担当者が未設定のタスクを探せると実用的なため、
 * 担当者の選択肢に混ぜて渡せるようにしている。
 *
 * 実在の userId（cuid2）と衝突しない形にしてある。cuid2 は英数小文字のみで
 * アンダースコアを含まないため、この値が userId と一致することはない。
 */
export const UNASSIGNED_ASSIGNEE = "__unassigned__";

/** 絞り込み条件。どちらも省略・空配列なら「その条件では絞り込まない」。 */
export interface BoardFilterCriteria {
  /** 残したい優先度（`tasks.priority` の DB 値）。同士は OR。 */
  priorities?: readonly string[];
  /** 残したい担当者の userId。`UNASSIGNED_ASSIGNEE` を含めると未割り当ても残す。同士は OR。 */
  assignees?: readonly string[];
}

/** 絞り込みに必要な最小限のタスク形状。これ以外のフィールドは一切見ない。 */
export interface FilterableTask {
  readonly id: string;
  readonly priority: string;
}

/** タスク id → 割り当てられた userId の配列。1タスクに複数担当者が付きうる。 */
export type AssigneesByTaskId = Readonly<Record<string, readonly string[]>>;

/**
 * 絞り込み条件が1つでも指定されているかを返す。
 *
 * 「絞り込み中である」ことを UI に出すための判定。絞り込んでいるのに
 * 何も表示されていないと「タスクが消えた」と誤解されるため、呼び出し側は
 * これが `true` のときに絞り込み中である旨を明示する。
 */
export function isBoardFilterActive(criteria: BoardFilterCriteria): boolean {
  return (criteria.priorities?.length ?? 0) > 0 || (criteria.assignees?.length ?? 0) > 0;
}

/**
 * 条件に一致するタスクだけを、**元の並び順のまま**返す。
 *
 * - 条件が空なら全件返す（絞り込まない）。
 * - 引数の配列は変更しない。常に新しい配列を返すので、呼び出し元の state を
 *   そのまま渡してよい。
 * - `assigneesByTaskId` に存在しない id は「担当者なし」として扱う。
 */
export function filterBoardTasks<T extends FilterableTask>(
  tasks: readonly T[],
  criteria: BoardFilterCriteria = {},
  assigneesByTaskId: AssigneesByTaskId = {},
): T[] {
  const priorities = criteria.priorities ?? [];
  const assignees = criteria.assignees ?? [];

  if (priorities.length === 0 && assignees.length === 0) {
    return [...tasks];
  }

  const prioritySet = new Set(priorities);
  const assigneeSet = new Set(assignees);
  // 番兵値は「未割り当てを残すか」のフラグに変換し、userId の集合からは取り除く。
  // 取り除かないと、万一 userId として同じ文字列が来たときに二重の意味を持ってしまう。
  const includeUnassigned = assigneeSet.delete(UNASSIGNED_ASSIGNEE);

  return tasks.filter((task) => {
    if (prioritySet.size > 0 && !prioritySet.has(task.priority)) {
      return false;
    }

    if (assignees.length === 0) {
      return true;
    }

    const assigned = assigneesByTaskId[task.id] ?? [];
    if (includeUnassigned && assigned.length === 0) {
      return true;
    }
    return assigned.some((userId) => assigneeSet.has(userId));
  });
}

/**
 * 渡されたタスクに実際に割り当てられている担当者の userId を、重複なく昇順で返す。
 *
 * 担当者の選択肢は「そのプロジェクトのタスクに実際に割り当てられている担当者」から
 * 作る。選んでも必ず0件になる選択肢を並べないため。
 */
export function listAssigneeOptions(
  tasks: readonly FilterableTask[],
  assigneesByTaskId: AssigneesByTaskId = {},
): string[] {
  const userIds = new Set<string>();
  for (const task of tasks) {
    for (const userId of assigneesByTaskId[task.id] ?? []) {
      userIds.add(userId);
    }
  }
  return [...userIds].sort((a, b) => a.localeCompare(b));
}
