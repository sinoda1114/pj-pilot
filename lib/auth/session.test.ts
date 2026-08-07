import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fullSession: null as { user: { id: string; email: string } } | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("../auth", () => ({
  auth: {
    api: {
      getSession: async () => state.fullSession,
    },
  },
}));

const ORIGINAL_ALLOWED_EMAIL_DOMAINS = process.env.ALLOWED_EMAIL_DOMAINS;

const { getSession } = await import("./session");

describe("getSession", () => {
  afterEach(() => {
    state.fullSession = null;
    process.env.ALLOWED_EMAIL_DOMAINS = ORIGINAL_ALLOWED_EMAIL_DOMAINS;
  });

  it("Better Authのセッションが無ければnullを返す（未ログイン）", async () => {
    state.fullSession = null;

    const session = await getSession();

    expect(session).toBeNull();
  });

  it("許可ドメインのユーザーならuserIdを返す", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "example.com";
    state.fullSession = { user: { id: "user-1", email: "alice@example.com" } };

    const session = await getSession();

    expect(session).toEqual({ userId: "user-1" });
  });

  it("許可ドメイン外のユーザーはセッションがあってもnullを返す（多層防御）", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "example.com";
    state.fullSession = { user: { id: "user-2", email: "eve@evil.com" } };

    const session = await getSession();

    expect(session).toBeNull();
  });
});
