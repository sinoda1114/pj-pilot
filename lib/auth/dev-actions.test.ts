import { afterEach, describe, expect, it, vi } from "vitest";

const cookieStore = new Map<string, string>();
const setMock = vi.fn((name: string, value: string) => {
  cookieStore.set(name, value);
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: setMock,
  }),
}));

const { setDevUser } = await import("./dev-actions");

describe("setDevUser", () => {
  afterEach(() => {
    cookieStore.clear();
    setMock.mockClear();
  });

  it("既知の開発用ユーザーIDならCookieに設定する", async () => {
    await setDevUser("seed-member");

    expect(cookieStore.get("pj-pilot-dev-user")).toBe("seed-member");
  });

  it("未知のユーザーIDなら例外を投げ、Cookieを設定しない", async () => {
    await expect(setDevUser("unknown-user")).rejects.toThrow();

    expect(setMock).not.toHaveBeenCalled();
  });
});
