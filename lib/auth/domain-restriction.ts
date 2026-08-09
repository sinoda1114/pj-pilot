/**
 * ログイン制限（決定 D-07）: `ALLOWED_EMAIL_DOMAINS`（カンマ区切り）に含まれる
 * ドメインのメールアドレスのみログインを許可する。Public リポジトリの社内ツールで
 * ここが実質唯一の防御線のため（リスクR-10）、判定ロジックは純粋関数として切り出し
 * 単体テストで許可/拒否の両方を検証する。
 *
 * サブドメインは自動では許可しない（完全一致のみ）。`ALLOWED_EMAIL_DOMAINS` が
 * 未設定/空文字の場合は安全側に倒して全拒否する（設定漏れで全世界に開くリスクを
 * 避けるため）。
 *
 * エントリが `@` を含む場合は、ドメインではなく**メールアドレス完全一致**として扱う。
 * `gmail.com` のような共用ドメインを丸ごと許可すると全世界に開いてしまうため
 * （`lib/auth/authz.ts` のとおり、ログインを通れば全 PJ が閲覧できる設計）、
 * 個人アカウントで運用する場合の逃げ道として用意している。両形式は混在可能。
 *
 *   ALLOWED_EMAIL_DOMAINS=alice@gmail.com              # このアドレスだけ
 *   ALLOWED_EMAIL_DOMAINS=alice@gmail.com,bob@gmail.com # 個別に追加
 *   ALLOWED_EMAIL_DOMAINS=example.co.jp                 # ドメイン全体
 *
 * 変数名が「DOMAINS」のままなのは、改名すると Vercel 側の再登録が必要になり、
 * 移行中に「未設定 = 全拒否」で締め出される事故が起きやすいため。
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
  const localPart = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  if (!localPart || !domain) {
    return false;
  }
  const normalizedEmail = `${localPart}@${domain}`;

  const entries = (allowedDomainsCsv ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);

  return entries.some((entry) => {
    const entryAt = entry.indexOf("@");
    if (entryAt === -1) {
      // ドメイン指定。
      return entry === domain;
    }
    // アドレス指定。ローカル部・ドメイン部のどちらかが欠けたエントリ
    // （`@example.com` / `alice@` / `@`）は意図が読めないので何も許可しない。
    // ここでドメイン指定にフォールバックすると、`@gmail.com` の設定ミスが
    // gmail.com 全体の許可に化けてしまう。
    if (entryAt !== entry.lastIndexOf("@") || entryAt === 0 || entryAt === entry.length - 1) {
      return false;
    }
    return entry === normalizedEmail;
  });
}
