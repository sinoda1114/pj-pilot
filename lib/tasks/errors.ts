/**
 * 子タスクを持つタスクの削除は既定で拒否される（決定 D-02）。
 * 呼び出し側は `deleteTaskSubtree` か `promoteChildrenAndDeleteTask` を選ばせる UI を出す。
 */
export class HasChildrenError extends Error {
  constructor(message = "子タスクが存在するため削除できません") {
    super(message);
    this.name = "HasChildrenError";
  }
}
