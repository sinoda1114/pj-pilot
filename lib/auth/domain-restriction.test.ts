import { describe, expect, it } from "vitest";
import { isAllowedEmailDomain } from "./domain-restriction";

describe("isAllowedEmailDomain", () => {
  it("許可ドメインに完全一致するメールアドレスは許可する", () => {
    expect(isAllowedEmailDomain("alice@example.com", "example.com")).toBe(true);
  });

  it("大文字小文字が違っても許可する", () => {
    expect(isAllowedEmailDomain("alice@Example.COM", "example.com")).toBe(true);
    expect(isAllowedEmailDomain("alice@example.com", "Example.COM")).toBe(true);
  });

  it("複数ドメインのうちいずれかに一致すれば許可する", () => {
    expect(isAllowedEmailDomain("alice@b.com", "a.com,b.com,c.com")).toBe(true);
  });

  it("カンマ区切りの前後の空白を無視する", () => {
    expect(isAllowedEmailDomain("alice@b.com", "a.com, b.com , c.com")).toBe(true);
  });

  it("許可ドメインに含まれないメールアドレスは拒否する", () => {
    expect(isAllowedEmailDomain("alice@evil.com", "example.com")).toBe(false);
  });

  it("サブドメインは自動では許可しない（完全一致のみ）", () => {
    expect(isAllowedEmailDomain("alice@mail.example.com", "example.com")).toBe(false);
  });

  it("ALLOWED_EMAIL_DOMAINSが未設定なら全拒否する（安全側デフォルト）", () => {
    expect(isAllowedEmailDomain("alice@example.com", undefined)).toBe(false);
  });

  it("ALLOWED_EMAIL_DOMAINSが空文字列なら全拒否する", () => {
    expect(isAllowedEmailDomain("alice@example.com", "")).toBe(false);
  });

  it("@を含まない不正なメールアドレスは拒否する", () => {
    expect(isAllowedEmailDomain("not-an-email", "example.com")).toBe(false);
  });
  /**
   * 公開前セキュリティ監査の指摘。`split("@")[1]` は「最初の `@` の直後」を取るため、
   * `alice@example.com@evil.com` が許可判定になっていた（実測で確認）。
   * ログイン経路は Google OAuth のみで多重 `@` のアドレスは発行されないが、
   * ここが実質唯一の防御線（リスク R-10）なので、安全性の根拠を外部の挙動に
   * 依存させない。
   */
  it.each([
    "alice@example.com@evil.com",
    "alice@evil.com@example.com",
    "alice@@example.com",
    "alice@example.com@",
  ])("`@` を複数含むアドレスは拒否する: %s", (email) => {
    expect(isAllowedEmailDomain(email, "example.com")).toBe(false);
  });

  it("`@` を1つだけ含む正規のアドレスは従来どおり許可する", () => {
    expect(isAllowedEmailDomain("alice@example.com", "example.com")).toBe(true);
  });
});
