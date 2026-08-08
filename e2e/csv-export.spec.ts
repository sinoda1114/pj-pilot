import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createDb, type DbHandle } from "../lib/db/client";
import { createProject } from "../lib/projects/service";
import { createTask } from "../lib/tasks/service";
import { addSessionCookies, createTestUser } from "./helpers/auth";

/**
 * CSV エクスポートの e2e。
 *
 * テストデータは他のスペックと同様に `lib` 配下の service を直接呼んで用意し、
 * webServer（`npm run build && npm run start`）が使うのと同じ DB ファイルを
 * 同じ URL 解決ロジック（`TURSO_DATABASE_URL` が無ければ `file:local.db`）で開く。
 *
 * ダウンロードは `page.waitForEvent("download")` で捕捉し、保存されたファイルを
 * 読み直して中身を検証する。検証したいのは「画面の状態がそのまま CSV になっているか」
 * （日本語ラベル・BOM・フィルター適用後の行）であり、これは単体テストでは
 * 確認できないため e2e に置いている。
 */

const UTF8_BOM = "\uFEFF";

let session: Awaited<ReturnType<typeof createTestUser>>;
let handle: DbHandle;
let projectId: string;
let projectName: string;
/**
 * 期限超過タスクのタイトル。**実行ごとに一意**にする。
 *
 * ダッシュボードは全プロジェクト横断なので、リトライで beforeAll が再実行されると
 * 同名タスクが複数プロジェクトに並び、`lines.find()` が別実行の行を拾ってしまう
 * （CI で実際に踏んだ。1回目の実行のプロジェクト名と照合して失敗した）。
 */
let overdueTaskTitle: string;

/** JST の今日。ファイル名の日付検証に使う（サーバーは UTC 稼働なので JST で求める）。 */
const todayInJst = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

/** ダウンロードされたファイルを文字列として読む。 */
async function readDownload(download: { path: () => Promise<string | null> }): Promise<string> {
  const filePath = await download.path();
  expect(filePath).not.toBeNull();
  return readFile(filePath as string, "utf8");
}

test.beforeAll(async () => {
  session = await createTestUser({ email: "e2e-csv-export@example.com", name: "E2E CSV Export" });

  const resolvedUrl = process.env.TURSO_DATABASE_URL ?? "file:local.db";
  handle = createDb(resolvedUrl);

  const runId = Date.now();
  projectName = `E2E CSV検証用 ${runId}`;
  overdueTaskTitle = `CSV期限超過タスク-${runId}`;
  const project = await createProject(handle.db, { userId: session.userId }, { name: projectName });
  projectId = project.id;

  // 通常のタスク（未着手・優先度 高）
  await createTask(handle.db, { userId: session.userId }, projectId, {
    title: "CSV通常タスク",
    startDate: "2026-08-01",
    endDate: "2026-08-05",
    status: "todo",
    priority: "high",
    progress: 30,
  });
  // エスケープが必要なタイトル（カンマとダブルクォートを含む）
  await createTask(handle.db, { userId: session.userId }, projectId, {
    title: 'CSV"引用",カンマ入り',
    startDate: "2026-08-02",
    endDate: "2026-08-06",
    status: "in_progress",
    priority: "urgent",
    progress: 50,
  });
  // 期限を大きく過ぎた未完了タスク（ダッシュボードの期限超過一覧に出る）
  await createTask(handle.db, { userId: session.userId }, projectId, {
    title: overdueTaskTitle,
    startDate: "2020-01-01",
    endDate: "2020-01-05",
    status: "review",
  });
});

test.afterAll(() => {
  handle.client.close();
});

test.beforeEach(async ({ context }) => {
  await addSessionCookies(context, session.cookies);
});

test("タスク一覧の CSV に日本語ラベルと BOM が入り、RFC 4180 でエスケープされる", async ({
  page,
}) => {
  await page.goto(`/projects/${projectId}/tasks`);
  await expect(page.getByText("CSV通常タスク", { exact: true })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("tasks-csv-download").click(),
  ]);

  expect(download.suggestedFilename()).toBe(`tasks-${todayInJst}.csv`);

  const content = await readDownload(download);

  // Excel が日本語を文字化けさせないよう BOM 付きで出す
  expect(content.startsWith(UTF8_BOM)).toBe(true);

  const lines = content.slice(UTF8_BOM.length).split("\r\n");
  // 列順は画面の DataTable と一致していること（担当者は優先度の直後）。
  // ここを文字列で固定しているので、片方だけ順序を変えると必ず落ちる。
  expect(lines[0]).toBe("タイトル,ステータス,優先度,担当者,開始日,終了日,進捗");

  // DB の enum 値ではなく画面と同じ日本語ラベルで出ていること
  expect(content).toContain("CSV通常タスク,未着手,高,,2026-08-01,2026-08-05,30");
  expect(content).not.toContain("todo");
  expect(content).not.toContain("in_progress");

  // カンマ・ダブルクォートを含むタイトルは囲みとダブルクォートの二重化が行われること
  expect(content).toContain('"CSV""引用"",カンマ入り",対応中,緊急,,2026-08-02,2026-08-06,50');
});

test("フィルターを適用すると、表示されている行だけが CSV に出る", async ({ page }) => {
  await page.goto(`/projects/${projectId}/tasks`);

  // ステータスを「対応中」に絞り込む
  // getByLabel は使わない。Mantine の Select は展開後の listbox にも
  // aria-labelledby でラベルが紐づき、入力欄と2要素に一致して strict mode violation
  // になる（CI で実際に踏んだ。ローカルでは開閉のタイミング差で顕在化しなかった）。
  await page.getByRole("combobox", { name: "ステータス" }).click();
  await page.getByRole("option", { name: "対応中" }).click();
  await expect(page.getByText("CSV通常タスク", { exact: true })).toHaveCount(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("tasks-csv-download").click(),
  ]);

  const content = await readDownload(download);
  const bodyLines = content
    .slice(UTF8_BOM.length)
    .split("\r\n")
    .slice(1)
    .filter((line) => line.length > 0);

  // 絞り込んだ結果（対応中の1件）だけが出る。全件ではない。
  expect(bodyLines).toHaveLength(1);
  expect(bodyLines[0]).toContain("対応中");
  expect(content).not.toContain("CSV通常タスク");
});

test("ダッシュボードの期限超過一覧を CSV でダウンロードできる", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByTestId("overdue-table")).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("overdue-csv-download").click(),
  ]);

  expect(download.suggestedFilename()).toBe(`overdue-tasks-${todayInJst}.csv`);

  const content = await readDownload(download);
  expect(content.startsWith(UTF8_BOM)).toBe(true);

  const lines = content.slice(UTF8_BOM.length).split("\r\n");
  expect(lines[0]).toBe("プロジェクト,タスク,ステータス,終了日");

  // このテストが作った期限超過タスクの行が、日本語ラベル付きで入っていること。
  // ダッシュボードは全プロジェクト横断なので、他スペックのデータも混ざる前提で
  // 「自分の行があること」だけを見る（実行順に依存させない）。
  const targetLine = lines.find((line) => line.includes(overdueTaskTitle));
  expect(targetLine).toBeDefined();
  expect(targetLine).toContain(projectName);
  expect(targetLine).toContain("確認中");
  expect(targetLine).toContain("2020-01-05");
});
