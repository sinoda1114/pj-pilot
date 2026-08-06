/** 対象のリソースが存在しない、または論理削除済みで対象外（§4.4 決定 D-03）。 */
export class NotFoundError extends Error {
  constructor(message = "対象が見つかりません") {
    super(message);
    this.name = "NotFoundError";
  }
}

/** 入力値が業務ルール上不正（日付の前後関係、他プロジェクトへの参照、循環参照など）。 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
