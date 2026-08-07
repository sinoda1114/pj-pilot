"use client";

/**
 * SVAR Gantt の実体（M3 #20 / M4 ドラッグ連動）。
 *
 * `GanttLoader.tsx` から `next/dynamic(..., { ssr: false })` 経由でのみ読み込まれる
 * 前提（§2.4）。DOM の実寸を測ってレイアウトするため、直接 import すると
 * ハイドレーション不整合やビルドエラーになる。
 *
 * ドラッグ移動・リサイズ・依存の作成/削除は SVAR の標準インタラクションをそのまま
 * 使い（`readonly` を渡さない）、`api.intercept(...)` で確定イベントを捕捉して
 * サーバへ反映する（§2.3）。実際のイベント形状は実機で検証済み（M4着手時）:
 *   - `update-task`: `task.start` があれば移動、`task.end` のみならリサイズ。
 *     `task.start`/`task.end` の値自体は変更前のスナップショットのままで
 *     信用できないため、`diff`（整数の日数）だけを Δ として使う。
 *   - `add-link`/`delete-link`: `inProgress` は無く、確定時に1回だけ発火する。
 */
import { useEffect, useRef, useState } from "react";
import { Button, Center, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  Gantt,
  Willow,
  type IApi,
  type IColumnConfig,
  type IScaleConfig,
  type IZoomConfig,
} from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/all.css";
import {
  createDependencyAction,
  deleteDependencyAction,
  moveTaskAction,
  resizeTaskEndAction,
  undoDateChangesAction,
} from "../../app/projects/[id]/gantt/actions";
import {
  fromGanttEndDate,
  fromGanttStartDate,
  toGanttEndDate,
  toGanttLinks,
  toGanttStartDate,
  toGanttTasks,
  type DbDependencyLike,
  type DbTaskLike,
} from "../../lib/gantt/transform";

export interface GanttViewProps {
  projectId: string;
  tasks: DbTaskLike[];
  dependencies: DbDependencyLike[];
}

/**
 * 列はタスク名・開始日・終了日・進捗の最低限（要件どおり）。
 *
 * `start`/`end` はどちらも SVAR 内部表現（`end` は排他）の `Date` が来るため、
 * `fromGanttStartDate`/`fromGanttEndDate`（§9 S-1 で確定済みの変換）を通して
 * DB の `date-only` 表記に戻して表示する。素の `end` をそのまま表示すると、
 * DB の `end_date`（終了日を含む）より 1 日先の日付が画面に出てしまう。
 *
 * `template` は列幅の自動計算時などに SVAR 内部から実データ以外の値
 * （`Date` でない値）で呼ばれることがある（実機確認済み）ため、`Date`
 * かどうかを確認してから変換する。
 */
const columns: IColumnConfig[] = [
  { id: "text", header: "タスク名", flexgrow: 2, resize: true },
  {
    id: "start",
    header: "開始日",
    align: "center",
    width: 110,
    resize: true,
    template: (value: unknown) => (value instanceof Date ? fromGanttStartDate(value) : ""),
  },
  {
    id: "end",
    header: "終了日",
    align: "center",
    width: 110,
    resize: true,
    template: (value: unknown) => (value instanceof Date ? fromGanttEndDate(value) : ""),
  },
  {
    id: "progress",
    header: "進捗",
    align: "center",
    width: 80,
    resize: true,
    template: (value: unknown) => (typeof value === "number" ? `${value}%` : ""),
  },
];

/**
 * M6 #33: チャート上部のスケールヘッダー（月・日）のロケール対応。
 *
 * SVAR本体・`@svar-ui/gantt-locales` はUIチェイン（ツールバー・右クリックメニュー・
 * 標準タスクエディタ）文言の翻訳辞書のみを提供しており、この画面では標準
 * エディタ等を使っていないため対象外（本体は`en`/`cn`のみで`ja`も無い）。
 * スケールヘッダーの月表示はSVAR既定では英語（"July 2026"）になる
 * （実機のスクリーンショットで確認済み）ため、`format` に関数を渡して
 * 自前で日本語表記に変換する（`IScaleConfig.format` は文字列トークンか
 * 関数のどちらかを受け付け、関数を渡すとSVAR側のトークン解釈を経由せず
 * 自分で完全に文字列を制御できる）。
 *
 * ズーム（`zoom` #33）用に「日単位（既定）」「月単位（縮小）」の2段階を
 * 用意する。`zoom.levels` の各レベルは独立した `scales` を持てるため、
 * どちらのレベルでも英語に戻らず日本語表記を維持できる。
 */
const DAY_LEVEL_SCALES: IScaleConfig[] = [
  {
    unit: "month",
    step: 1,
    format: (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月`,
  },
  { unit: "day", step: 1, format: (date: Date) => `${date.getDate()}` },
];

const MONTH_LEVEL_SCALES: IScaleConfig[] = [
  { unit: "year", step: 1, format: (date: Date) => `${date.getFullYear()}年` },
  { unit: "month", step: 1, format: (date: Date) => `${date.getMonth() + 1}月` },
];

/**
 * Ctrl/Cmd+ホイールでズームする（SVAR標準の操作方法、実機確認済み。
 * `wxi-gantt` コンポーネント側に `zoom-scale` アクションとしてハードコードされて
 * おり、こちらから明示的にトリガーするAPIは無い）。既定（日単位）の
 * `DAY_LEVEL_SCALES` から、縮小すると `MONTH_LEVEL_SCALES` に切り替わる。
 */
const zoom: IZoomConfig = {
  levels: [
    { minCellWidth: 60, maxCellWidth: 200, scales: DAY_LEVEL_SCALES },
    { minCellWidth: 20, maxCellWidth: 60, scales: MONTH_LEVEL_SCALES },
  ],
};

const SKIP_REASON_LABEL: Record<"pinned" | "deleted", string> = {
  pinned: "ピン留めのため",
  deleted: "削除済みのため",
};

export function GanttView({ projectId, tasks, dependencies }: GanttViewProps) {
  // Server Component から渡された初期データを保持しつつ、ドラッグ確定後の
  // サーバ確定結果は `api.exec("update-task", ...)` で SVAR 内部状態に直接
  // 反映する（`revalidatePath` によるページ全体の再取得だけに頼ると、
  // Gantt のスクロール位置や選択状態が毎回リセットされてしまうため）。
  const apiRef = useRef<IApi | null>(null);
  // `update-task` の intercept は `void applyDragChange(...)` で非同期に投げっぱなしに
  // すると、1回目のドラッグのサーバ確定（DB読み書き）が終わる前に2回目のドラッグが
  // 割り込み、2回目が「1回目の変更前」の古いDB状態を基に伝播を計算してしまう
  // （Cursor Bugbot指摘）。このPromiseチェーンで直列化し、常に前の確定が完了して
  // から次のドラッグのサーバ処理を始めるようにする。
  const dragQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Shift ドラッグで一時的に連動を切る（決定D-08）。SVAR の update-task
  // イベント自体には修飾キー情報が含まれないため、ウィンドウ全体の
  // keydown/keyup を見て現在の押下状態を追跡する。
  const shiftPressedRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftPressedRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftPressedRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Server Action（`createDependencyAction` 等）の呼び出し後、Next.js が
  // `revalidatePath` されたルートを自動的に再検証し、Server Component から
  // 新しい `tasks`/`dependencies` が props として渡り直す。ここで state を
  // 追従させないと、直後の再レンダリングで古い `dependencyRows` から
  // 再計算された `links` が `Gantt` に渡り、`api.exec("add-link", ...)` で
  // 反映したはずの内部状態を巻き戻してしまう（実機確認済み）。
  // `useEffect` で同期すると `react-hooks/set-state-in-effect` に抵触する
  // （カスケードするレンダーを招くため非推奨）ため、React公式が推奨する
  // 「レンダー中に前回の props と比較して直接 setState する」パターンを使う。
  const [prevTasks, setPrevTasks] = useState(tasks);
  const [taskRows, setTaskRows] = useState(tasks);
  if (tasks !== prevTasks) {
    setPrevTasks(tasks);
    setTaskRows(tasks);
  }

  const [prevDependencies, setPrevDependencies] = useState(dependencies);
  const [dependencyRows, setDependencyRows] = useState(dependencies);
  if (dependencies !== prevDependencies) {
    setPrevDependencies(dependencies);
    setDependencyRows(dependencies);
  }

  // ドラッグ確定・Undoともこの1本のキューを経由させる。Undoだけ`dragQueueRef`を
  // 経由せず直接実行すると、キュー内で確定待ちのドラッグより先にUndoがDBの日付を
  // 書き換えてしまい、その後に実行される古いドラッグの結果で上書きされる
  // （またはその逆）競合が起こる（Cursor Bugbot指摘）。
  function enqueue(task: () => Promise<void>) {
    dragQueueRef.current = dragQueueRef.current.then(task).catch(() => {});
  }

  // 引数の `changes` はそのトースト（ドラッグ1回ぶん）の変更内容をクロージャで
  // 直接受け取る。以前は共有の `pendingUndoRef`（最新1件のみ保持）を参照していたため、
  // 複数のトーストが並んでいるときに古いトーストの「元に戻す」を押しても常に
  // 最新のドラッグが取り消されてしまっていた（Cursor Bugbot指摘）。
  async function handleUndo(changes: { id: string; startDate: string; endDate: string }[]) {
    const result = await undoDateChangesAction(projectId, changes);
    if (!result.ok) {
      notifications.show({ color: "red", title: "元に戻せませんでした", message: result.message });
      return;
    }

    const api = apiRef.current;
    if (api) {
      for (const change of changes) {
        api.exec("update-task", {
          id: change.id,
          task: {
            start: toGanttStartDate(change.startDate),
            end: toGanttEndDate(change.endDate),
          },
          skipUndo: true,
        });
      }
    }
    notifications.show({ color: "green", title: "元に戻しました", message: "" });
  }

  async function applyDragChange(
    taskId: string,
    deltaDays: number,
    isResize: boolean,
    beforeStart: Date | undefined,
    beforeEnd: Date | undefined,
    bypassSync: boolean,
  ) {
    const action = isResize ? resizeTaskEndAction : moveTaskAction;
    const result = await action(projectId, taskId, deltaDays, bypassSync);

    const api = apiRef.current;

    if (!result.ok) {
      notifications.show({ color: "red", title: "移動に失敗しました", message: result.message });
      // サーバ確定に失敗した場合、SVAR側は楽観的に更新済み（intercept で true を
      // 返している）ため、ドラッグ開始前の値（`api.getTask` から事前に
      // 取得しておいたもの）に巻き戻す。値が取得できていなければ諦めて
      // 画面をそのまま残す（次のドラッグかリロードで整合する）。
      if (api && beforeStart && beforeEnd) {
        api.exec("update-task", {
          id: taskId,
          task: { start: beforeStart, end: beforeEnd },
          skipUndo: true,
        });
      }
      return;
    }

    if (api) {
      for (const change of result.result.changes) {
        api.exec("update-task", {
          id: change.id,
          task: {
            start: toGanttStartDate(change.after.startDate),
            end: toGanttEndDate(change.after.endDate),
          },
          skipUndo: true,
        });
      }
      for (const summary of result.result.summaryUpdates) {
        api.exec("update-task", {
          id: summary.id,
          task: { progress: summary.progress },
          skipUndo: true,
        });
      }
    }

    const undoChanges = result.result.changes.map((c) => ({
      id: c.id,
      startDate: c.before.startDate,
      endDate: c.before.endDate,
    }));

    const movedCount = result.result.changes.length;
    const skippedBySameReason = new Map<string, number>();
    for (const skip of result.result.skipped) {
      skippedBySameReason.set(skip.reason, (skippedBySameReason.get(skip.reason) ?? 0) + 1);
    }
    const skippedLines = [...skippedBySameReason.entries()].map(
      ([reason, count]) =>
        `${count}件は${SKIP_REASON_LABEL[reason as "pinned" | "deleted"]}移動しませんでした`,
    );

    notifications.show({
      color: "blue",
      title: `${movedCount}件のタスクを移動しました`,
      autoClose: 8000,
      message: (
        <Stack gap="xs">
          {skippedLines.map((line) => (
            <Text key={line} size="sm">
              {line}
            </Text>
          ))}
          <Button size="xs" variant="light" onClick={() => enqueue(() => handleUndo(undoChanges))}>
            元に戻す
          </Button>
        </Stack>
      ),
    });
  }

  async function applyAddLink(predecessorId: string, successorId: string) {
    const result = await createDependencyAction(projectId, predecessorId, successorId);
    if (!result.ok) {
      notifications.show({
        color: "red",
        title: "依存の作成に失敗しました",
        message: result.message,
      });
      return;
    }
    // `id` を明示的に渡さないと SVAR が独自のIDを割り当ててしまい、後で
    // その依存を削除しようとした際に `delete-link` が渡すIDがDBの実際の
    // `dependencyId`（cuid2）と一致せず、削除に失敗する（Cursor Bugbot指摘）。
    apiRef.current?.exec("add-link", {
      id: result.dependencyId,
      link: { source: predecessorId, target: successorId, type: "e2s" },
    });
  }

  async function applyDeleteLink(dependencyId: string) {
    const result = await deleteDependencyAction(projectId, dependencyId);
    if (!result.ok) {
      notifications.show({
        color: "red",
        title: "依存の削除に失敗しました",
        message: result.message,
      });
      return;
    }
    apiRef.current?.exec("delete-link", { id: dependencyId });
  }

  if (taskRows.length === 0) {
    return (
      <Center h={200} style={{ border: "1px solid var(--mantine-color-default-border)" }}>
        <Text c="dimmed">タスクがまだ登録されていません。</Text>
      </Center>
    );
  }

  // SVAR は `open` が明示的に `true` のノードしか子を展開しない（`gantt-store` の
  // ツリー実装を実測で確認）。`toGanttTasks` は DB↔SVAR の日付/ID変換のみを担う層
  // のため `open` は持たず、既定では階層がすべて折りたたまれてしまう。今回の要件
  // 「既存タスクの階層を描画する」を満たすため、このビュー層で全ノードを展開状態
  // にする。ただし子を持たないタスクにまで `open: true` を付けると、SVAR 内部の
  // ツリー展開処理（子が無いノードの `data` は `null` のまま）が
  // `null.forEach` で例外を投げて画面がクラッシュする（実機確認済み）。
  // 実際に子を持つタスク（他タスクの `parentId` として参照されている ID）だけに絞る。
  const parentIds = new Set(taskRows.map((task) => task.parentId).filter((id) => id !== null));
  // M5 #30: ピン留めの視覚表現。グリッド列の `template` にはSVAR内部で正規化された
  // 行データが渡ってきて、`isPinned` のようなカスタムフィールドが残っていない
  // （実機確認済み。テキストの頭に📌を付ける表示にならなかった）。
  // そのため、SVARへ渡す前の `text` フィールド自体に絵文字を埋め込む（`open` と
  // 同じく、このビュー層で SVAR 渡し用のタスクデータを加工する既存の方式）。
  const ganttTasks = toGanttTasks(taskRows).map((task) => {
    const withOpen = parentIds.has(String(task.id)) ? { ...task, open: true } : task;
    return task.isPinned ? { ...withOpen, text: `📌 ${withOpen.text}` } : withOpen;
  });
  const ganttLinks = toGanttLinks(dependencyRows);

  // `Gantt` 自体はバー/依存線の配色に使う `--wx-gantt-*` 系 CSS 変数を持たない
  // （`all.css` の `.wx-willow-theme` セレクタでのみ定義される）。`Willow` で
  // 包まずに `all.css` だけを読み込むと、CSS 変数が未定義のままバーが透明になり
  // 何も描画されない（実機確認済み）。
  //
  // M6 #35: スマートフォン幅（実測375px）では、グリッド列（開始日/終了日/進捗の
  // 固定幅合計300px超）がGanttコンテナの横幅に収まりきらず、SVAR内部が
  // `.wx-table-container` に `flex: 0 0 calc(100% - 4px)` を割り当てて
  // グリッド側がほぼ全幅を占有し、チャート側（`.wx-chart`）が `width: 0` に
  // 潰れてバー・タイムラインが一切見えなくなる不具合を実機で確認した。
  // 外側にこの `minWidth` + `overflowX: auto` のラッパーを挟むことで、
  // SVAR内部には常に十分な幅（グリッド+チャート）を確保させ、収まらない
  // 場合はページではなくこのGantt部分だけが横スクロールするようにする。
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 700 }}>
        <Willow>
          <Gantt
            tasks={ganttTasks}
            links={ganttLinks}
            columns={columns}
            scales={DAY_LEVEL_SCALES}
            zoom={zoom}
            init={(api) => {
              apiRef.current = api;

              api.intercept("update-task", (ev) => {
                const diff = ev.diff;
                if (typeof diff !== "number" || diff === 0) {
                  return true;
                }

                // `task.start` の有無で移動/リサイズを判定する（決定D-01: リサイズは
                // 終了日のみ変更）。`task.start`/`task.end` の値自体は SVAR が
                // 返す時点ではまだ変更前のスナップショットのため使わず、`diff`
                // （実測で確認済みの整数の日数）だけを Δ として使う。
                const isResize = ev.task.start === undefined && ev.task.end !== undefined;
                // サーバ確定に失敗した場合の巻き戻し用に、変更前の値を
                // `api.getTask` から取得しておく（intercept 時点ではまだ内部状態に
                // 適用されていないため、ここで取得した値が「変更前」になる）。
                const before = api.getTask(ev.id);
                // Shiftキーの押下状態は intercept 時点（ドラッグ確定の瞬間）でスナップ
                // ショットを取る。キュー内で待機して実行が遅れる `applyDragChange` の
                // 内部で都度 `shiftPressedRef.current` を読むと、キュー待機中にユーザーが
                // Shiftを離した場合、決定D-08（Shiftドラッグは連動を切る）に反して
                // 連動ONのまま確定してしまう（Cursor Bugbot指摘）。
                const bypassSync = shiftPressedRef.current;
                // 前のドラッグ/Undoのサーバ確定を待ってから次を実行する（直列化、
                // `enqueue` 定義部のコメント参照）。`applyDragChange` 自体は内部で全
                // エラーを `notifications` に変換して握りつぶす設計だが、万一の例外で
                // チェーンが途切れないよう `enqueue` 側で保険の catch をしている。
                enqueue(() =>
                  applyDragChange(
                    String(ev.id),
                    diff,
                    isResize,
                    before?.start,
                    before?.end,
                    bypassSync,
                  ),
                );

                return true; // 楽観的にローカル反映を許可し、結果はサーバ確定後に上書きする。
              });

              api.intercept("add-link", (ev) => {
                const { source, target } = ev.link;
                if (source === undefined || target === undefined) {
                  return true;
                }
                // 循環検出等のサーバ側バリデーションを待つ必要があるため、
                // 一旦キャンセルしてからサーバの検証結果を見て正式に反映する
                // （update-task と異なり悲観的に扱う）。
                void applyAddLink(String(source), String(target));
                return false;
              });

              api.intercept("delete-link", (ev) => {
                void applyDeleteLink(String(ev.id));
                return false;
              });
            }}
          />
        </Willow>
      </div>
    </div>
  );
}
