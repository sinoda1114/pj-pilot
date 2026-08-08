/**
 * カンバンの並び替えの純粋関数（Phase 2 §5.3 / M8 #39）。
 *
 * DB も React も触らない。「id の配列 → id の配列」だけを扱う。
 * 呼び出し側（lib/board/service.ts）は board_order 昇順の id 配列を渡し、
 * **戻り値の配列の添字がそのまま新しい board_order（0 始まり）**になる。
 *
 * 列の完全リインデックス方式を採る（決定 P2-05）。フラクショナルインデックス
 * （隣接2件の中間値）は使わない。1列あたりのタスク数は現実的に数十件で、
 * 全件 UPDATE でも数十行に収まるため、不変条件が明快なこちらを優先する。
 */

/** `index` を `[0, max]` の範囲に丸める。UI やクライアントから範囲外の値が届いても壊れないようにする。 */
function clampIndex(index: number, max: number): number {
  if (!Number.isFinite(index)) {
    return max;
  }
  return Math.min(Math.max(Math.trunc(index), 0), max);
}

/**
 * 同じ列の中で `taskId` を `toIndex` の位置へ移動した配列を返す。
 *
 * - `taskId` が列に無い場合は元の並びをそのまま返す（列を壊さない）。
 * - `toIndex` が範囲外なら先頭/末尾に丸める。
 * - 引数の配列は変更しない。
 */
export function reorderWithinColumn(
  column: readonly string[],
  taskId: string,
  toIndex: number,
): string[] {
  const currentIndex = column.indexOf(taskId);
  if (currentIndex === -1) {
    return [...column];
  }

  const withoutTask = column.filter((id) => id !== taskId);
  // 丸めの上限は「取り除いたあとの長さ」。取り除く前の length で丸めると、
  // 末尾へ移動したいときに 1 つ手前で止まる。
  const insertAt = clampIndex(toIndex, withoutTask.length);

  withoutTask.splice(insertAt, 0, taskId);
  return withoutTask;
}

/**
 * `taskId` を `from` 列から取り除き、`to` 列の `toIndex` の位置へ挿入した結果を返す。
 *
 * - `from` に `taskId` が無い場合は、どちらの列も変更せずに返す。
 * - `to` に既に同じ `taskId` がある場合は取り除いてから挿入する（重複させない）。
 *   楽観更新とサーバー確定が二重に適用された場合などの防御。
 * - 引数の配列は変更しない。
 */
export function moveAcrossColumns(
  from: readonly string[],
  to: readonly string[],
  taskId: string,
  toIndex: number,
): { from: string[]; to: string[] } {
  if (!from.includes(taskId)) {
    return { from: [...from], to: [...to] };
  }

  const nextFrom = from.filter((id) => id !== taskId);
  const nextTo = to.filter((id) => id !== taskId);
  const insertAt = clampIndex(toIndex, nextTo.length);

  nextTo.splice(insertAt, 0, taskId);
  return { from: nextFrom, to: nextTo };
}
