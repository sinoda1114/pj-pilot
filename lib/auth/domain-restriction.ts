/**
 * ログイン制限（決定 D-07）: `ALLOWED_EMAIL_DOMAINS`（カンマ区切り）に含まれる
 * ドメインのメールアドレスのみログインを許可する。Public リポジトリの社内ツールで
 * ここが実質唯一の防御線のため（リスクR-10）、判定ロジックは純粋関数として切り出し
 * 単体テストで許可/拒否の両方を検証する。
 *
 * サブドメインは自動では許可しない（完全一致のみ）。`ALLOWED_EMAIL_DOMAINS` が
 * 未設定/空文字の場合は安全側に倒して全拒否する（設定漏れで全世界に開くリスクを
 * 避けるため）。
 */
export function isAllowedEmailDomain(email: string, allowedDomainsCsv: string | undefined): boolean {
  // `split("@")[1]` は「最初の `@` の直後」を取るため、`alice@example.com@evil.com` が
  // 許可判定になってしまう（監査で実測）。`@` はちょうど1個であることを要求し、
  // その後ろ全部をドメインとして扱う。Google が多重 `@` のアドレスを発行することは
  // ないので現時点で到達経路は無いが、ここが実質唯一の防御線（リスク R-10）なので、
  // 「なぜ安全か」を外部（Google の挙動）に依存させない。
  const at = email.indexOf("@");
  if (at === -1 || at !== email.lastIndexOf("@")) {
    return false;
  }
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) {
    return false;
  }

  const allowedDomains = (allowedDomainsCsv ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);

  return allowedDomains.includes(domain);
}
