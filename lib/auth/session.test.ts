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

    expect(session).toEqual({ userId: "dev-owner" });
  });

  it("Cookie があればそのユーザーIDを返す", async () => {
    cookieStore.set("pj-pilot-dev-user", "dev-member");

    const session = await getSession();

    expect(session).toEqual({ userId: "dev-member" });
  });
});
