"use client";

/**
 * SVAR Gantt の実体（M3 #20）。
 *
 * `GanttLoader.tsx` から `next/dynamic(..., { ssr: false })` 経由でのみ読み込まれる
 * 前提（§2.4）。DOM の実寸を測ってレイアウトするため、直接 import すると
 * ハイドレーション不整合やビルドエラーになる。
 *
 * 依存線のドラッグ連動（`api.intercept("update-task", ...)` によるサーバへの
 * 反映、M4 #23-28 のスコープ）はここでは実装しない。`readonly` を渡して
 * ドラッグ移動・リサイズ・グリッド編集を無効化し、既存タスクの階層・日付・
 * 依存線を描画するだけの読み取り専用ビューに留める。
 */
import { Center, Text } from "@mantine/core";
import { Gantt, Willow, type IColumnConfig } from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/all.css";
import {
  fromGanttEndDate,
  fromGanttStartDate,
  toGanttLinks,
  toGanttTasks,
  type DbDependencyLike,
  type DbTaskLike,
} from "../../lib/gantt/transform";

export interface GanttViewProps {
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
  { id: "text", header: "タスク名", flexgrow: 2 },
  {
    id: "start",
    header: "開始日",
    align: "center",
    width: 110,
    template: (value: unknown) => (value instanceof Date ? fromGanttStartDate(value) : ""),
  },
  {
    id: "end",
    header: "終了日",
    align: "center",
    width: 110,
    template: (value: unknown) => (value instanceof Date ? fromGanttEndDate(value) : ""),
  },
  {
    id: "progress",
    header: "進捗",
    align: "center",
    width: 80,
    template: (value: unknown) => (typeof value === "number" ? `${value}%` : ""),
  },
];

export function GanttView({ tasks, dependencies }: GanttViewProps) {
  if (tasks.length === 0) {
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
  const parentIds = new Set(tasks.map((task) => task.parentId).filter((id) => id !== null));
  const ganttTasks = toGanttTasks(tasks).map((task) =>
    parentIds.has(String(task.id)) ? { ...task, open: true } : task,
  );
  const ganttLinks = toGanttLinks(dependencies);

  // `Gantt` 自体はバー/依存線の配色に使う `--wx-gantt-*` 系 CSS 変数を持たない
  // （`all.css` の `.wx-willow-theme` セレクタでのみ定義される）。`Willow` で
  // 包まずに `all.css` だけを読み込むと、CSS 変数が未定義のままバーが透明になり
  // 何も描画されない（実機確認済み）。
  return (
    <Willow>
      <Gantt tasks={ganttTasks} links={ganttLinks} columns={columns} readonly />
    </Willow>
  );
}
