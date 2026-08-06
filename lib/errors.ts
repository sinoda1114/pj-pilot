/** 対象のリソースが存在しない、または論理削除済みで対象外（§4.4 決定 D-03）。 */
export class NotFoundError extends Error {
  constructor(message = "対象が見つかりません") {
    super(message);
    this.name = "NotFoundError";
  }
}
