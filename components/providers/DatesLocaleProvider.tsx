"use client";

/**
 * `@mantine/dates`（DatePickerInput等）の日本語ロケール設定（M6 #33）。
 *
 * `import "dayjs/locale/ja"` はブラウザ側のdayjsインスタンスへロケールを登録する
 * 副作用importのため、Server Component（`app/layout.tsx`）に直接書いても効かない
 * （RSCコンパイラがServer Componentのコードをクライアントバンドルへ含めないため、
 * サーバー側でのみ実行され、ブラウザ側の別インスタンスには反映されない。
 * 実機のスクリーンショットで「DatesProviderにlocale="ja"を渡しても
 * カレンダーがAugust 2026のまま」という形で確認済み）。このファイルを
 * "use client" にしてクライアントバンドルへ確実に含めることで解決する。
 */
import "dayjs/locale/ja";
import { DatesProvider } from "@mantine/dates";

export function DatesLocaleProvider({ children }: { children: React.ReactNode }) {
  return <DatesProvider settings={{ locale: "ja" }}>{children}</DatesProvider>;
}
