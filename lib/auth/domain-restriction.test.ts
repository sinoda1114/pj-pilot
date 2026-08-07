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
});
