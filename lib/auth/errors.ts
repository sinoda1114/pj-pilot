/** ログインしていない（決定 D-07 のドメイン制限を通ったセッションが無い）。 */
export class UnauthorizedError extends Error {
  constructor(message = "ログインが必要です") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** ログインはしているが、その操作を行う権限がない（例: PJ 削除は owner のみ）。 */
export class ForbiddenError extends Error {
  constructor(message = "この操作を行う権限がありません") {
    super(message);
    this.name = "ForbiddenError";
  }
}
