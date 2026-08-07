import { afterEach, describe, expect, it, vi } from "vitest";

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieStore.has(name) ? { value: cookieStore.get(name) } : undefined),
  }),
}));

const { getSession } = await import("./session");

describe("getSession", () => {
  afterEach(() => {
    cookieStore.clear();
  });

  it("Cookie が無ければ既定の開発用ユーザーを返す", async () => {
    const session = await getSession();

    expect(session).toEqual({ userId: "seed-owner" });
  });

  it("Cookie があればそのユーザーIDを返す", async () => {
    cookieStore.set("pj-pilot-dev-user", "seed-member");

    const session = await getSession();

    expect(session).toEqual({ userId: "seed-member" });
  });

  it("未知のユーザーIDのCookieなら既定の開発用ユーザーにフォールバックする", async () => {
    cookieStore.set("pj-pilot-dev-user", "tampered-value");

    const session = await getSession();

    expect(session).toEqual({ userId: "seed-owner" });
  });
});
