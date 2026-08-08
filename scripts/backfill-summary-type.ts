/**
 * 既存データの `tasks.type` を実際の親子関係に合わせて整合させる、
 * 一度だけ流すバックフィル（Issue #60）。
 *
 * 決定 D-11（親タスクの日付・進捗・工数は子から自動集計）の集計側
 * （`lib/tasks/summary.ts` / `lib/scheduling/propagate.ts`）は `type === "summary"` の
 * 行しか処理しない。印の付け外し自体は `lib/tasks/summary-marker.ts` が
 * indent/outdent・削除・復元の各経路で行うようになったが、それは
 * **これから行われる操作**にしか効かない。修正前に作られた階層には
 *
 *   - 生存する子を持つのに `type='task'`（集計されない）
 *   - 生存する子が0件なのに `type='summary'`（カンバン・ダッシュボードから消え、
 *     Gantt でもドラッグできない行き止まり）
 *
 * が残っているため、このスクリプトで一度だけ揃える。
 *
 * **判定基準は `lib/tasks/summary-marker.ts` と厳密に一致させている。**
 * ずれると、このスクリプトが付けた印を後の復元操作が別の基準で外す（またはその逆）
 * ことになり、印が食い違う。具体的には marker が使う問い合わせに合わせて
 *
 *   - 対象行:   `getActiveTask` 相当。`deleted_at IS NULL` の行のみ
 *               （削除済みの行の `type` は触らない）
 *   - 子の数え方: `listActiveChildren` 相当。`deleted_at IS NULL` の子のみ数える
 *   - `milestone`: 対象外（決定 D-12。意図して設定された種別を潰さない）
 *
 * とする。プロジェクトの生存（`projects.deleted_at`）は marker 側も見ていないため、
 * ここでも条件に加えない。
 *
 * 既定は dry-run。実際に UPDATE を流すのは `--apply` を明示したときだけ。
 *
 * 実行: npm run db:backfill-summary-type -- --apply
 */

import { pathToFileURL } from "node:url";
import { inArray } from "drizzle-orm";
import { createDb } from "../lib/db/client";
import { tasks } from "../lib/db/schema";

type Database = ReturnType<typeof createDb>["db"];

type TaskType = (typeof tasks.$inferSelect)["type"];

/** 判定に必要な列だけを持つ行。純粋関数を DB から切り離して単体テストするための型。 */
export interface TaskTypeRow {
  id: string;
  title: string;
  type: TaskType;
  parentId: string | null;
  deletedAt: Date | null;
}

export interface TypeChange {
  id: string;
  title: string;
  /** 変更前の種別。`milestone` は対象外なのでこの2値しか取らない。 */
  from: "task" | "summary";
  /** 変更後の種別。 */
  to: "task" | "summary";
}

/** dry-run で明細を出す件数の上限。これを超えた分は件数だけを表示する。 */
export const DETAIL_LIMIT = 50;

/** 1回の UPDATE に載せる id の数。SQLite のバインド変数の上限に触れないよう分割する。 */
const CHUNK_SIZE = 200;

const USAGE = `使い方: tsx scripts/backfill-summary-type.ts [--apply]

  tasks.type を実際の親子関係（生存している子の有無）に合わせて整合させます。

  オプション:
    --apply     実際に UPDATE を流す。省略時は dry-run（DB を変更しない）。
    -h, --help  この使い方を表示する。

  対象DBは環境変数 TURSO_DATABASE_URL（未設定なら file:local.db）です。`;

export interface CliOptions {
  apply: boolean;
  help: boolean;
}

/**
 * 引数を解釈する。知らない引数は黙って無視せずエラーにする。
 * `--aply` のような打ち間違いを「dry-run が指定された」と誤解して読み飛ばすと、
 * 利用者は `--apply` を付けたつもりで何も更新されないまま終わったことに気付けない。
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { apply: false, help: false };

  for (const arg of argv) {
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`不明な引数です: ${arg}\n\n${USAGE}`);
    }
  }

  return options;
}

/**
 * 更新すべき行を決める純粋関数。
 *
 * 削除済みの行も含めた**全行**を受け取る。子の数え上げに使うのは生存している行だけだが、
 * 「削除済みの子しか持たない親は summary にしない」という判定のためには、
 * 呼び出し側で先に絞るのではなくここで `deleted_at` を見て弾く方が、
 * 基準が1箇所にまとまって marker とのズレを検証しやすい。
 */
export function planSummaryTypeChanges(rows: readonly TaskTypeRow[]): TypeChange[] {
  // `getActiveTask` / `listActiveChildren` に合わせ、生存行だけを対象・母数にする。
  const activeRows = rows.filter((row) => row.deletedAt === null);

  const activeChildCount = new Map<string, number>();
  for (const row of activeRows) {
    if (row.parentId !== null) {
      activeChildCount.set(row.parentId, (activeChildCount.get(row.parentId) ?? 0) + 1);
    }
  }

  const changes: TypeChange[] = [];
  for (const row of activeRows) {
    const hasActiveChild = (activeChildCount.get(row.id) ?? 0) > 0;

    if (row.type === "task" && hasActiveChild) {
      changes.push({ id: row.id, title: row.title, from: "task", to: "summary" });
    } else if (row.type === "summary" && !hasActiveChild) {
      changes.push({ id: row.id, title: row.title, from: "summary", to: "task" });
    }
    // `milestone` はどちらの分岐にも入らない（決定 D-12）。
    // 既に整合している行も同様に、変更対象へは積まない。
  }

  // 出力と UPDATE の順序を安定させ、dry-run の結果を突き合わせやすくする。
  changes.sort((a, b) => a.id.localeCompare(b.id));

  return changes;
}

/** dry-run の一覧を組み立てる。件数が多いときに端末を埋めないよう明細は先頭のみ。 */
export function formatPlanReport(changes: readonly TypeChange[]): string {
  if (changes.length === 0) {
    return "更新対象: 0 件（tasks.type はすべて親子関係と整合しています）";
  }

  const lines = [`更新対象: ${changes.length} 件`];
  for (const change of changes.slice(0, DETAIL_LIMIT)) {
    lines.push(`  ${change.id}  ${change.from} -> ${change.to}  ${change.title}`);
  }

  const rest = changes.length - DETAIL_LIMIT;
  if (rest > 0) {
    lines.push(`  ... 他 ${rest} 件（明細は先頭 ${DETAIL_LIMIT} 件のみ表示）`);
  }

  return lines.join("\n");
}

/**
 * 判定に必要な列だけを全行取得する。
 *
 * 親ごとに子を数える問い合わせを投げると行数分の往復になるため、1回で読み切って
 * メモリ上で数える。一度きりのバックフィルであり、対象は1インスタンスの
 * `tasks` 全件に収まる規模のため。
 */
export async function loadTaskTypeRows(db: Database): Promise<TaskTypeRow[]> {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      type: tasks.type,
      parentId: tasks.parentId,
      deletedAt: tasks.deletedAt,
    })
    .from(tasks);
}

/**
 * 変更をまとめて適用し、実際に更新された行数を返す。
 *
 * 途中で失敗したときに「一部だけ印が付いた」状態を残さないよう、
 * 全体を1つのトランザクションに入れる。件数は自前のカウントではなく
 * `rowsAffected` を積む（想定と実際がずれたときに気付けるようにする）。
 *
 * 素の SQL ではなく drizzle の `update` を通すのは、`updated_at` の `$onUpdate` を
 * 含めて `lib/tasks/summary-marker.ts` と同じ経路で書き換えるため。
 */
export async function applyTypeChanges(
  db: Database,
  changes: readonly TypeChange[],
): Promise<number> {
  if (changes.length === 0) {
    return 0;
  }

  return db.transaction(async (tx) => {
    let updated = 0;

    for (const nextType of ["summary", "task"] as const) {
      const ids = changes.filter((change) => change.to === nextType).map((change) => change.id);

      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const result = await tx
          .update(tasks)
          .set({ type: nextType })
          .where(inArray(tasks.id, chunk));
        updated += result.rowsAffected;
      }
    }

    return updated;
  });
}

export interface BackfillResult {
  changes: TypeChange[];
  /** dry-run では常に 0。 */
  updated: number;
}

/** 読み取り → 判定 →（`apply` のときだけ）更新。出力は行わない。 */
export async function runBackfill(
  db: Database,
  options: { apply: boolean },
): Promise<BackfillResult> {
  const rows = await loadTaskTypeRows(db);
  const changes = planSummaryTypeChanges(rows);

  if (!options.apply) {
    return { changes, updated: 0 };
  }

  const updated = await applyTypeChanges(db, changes);
  return { changes, updated };
}

/**
 * CLI の入口。接続先の解決・出力・ハンドルの後始末だけを担う。
 *
 * `export` しているのはテストから呼ぶため。CLI 部分は「どの DB に、どのモードで
 * 繋いだか」を利用者に伝える唯一の場所であり、ここを未検証のまま置くと
 * 本番 DB に対して黙って `--apply` が走るような取り違えを検出できない。
 */
export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(USAGE);
    return;
  }

  // `scripts/seed.ts` と同じ読み方。ただし seed のような「リモート禁止」ガードは置かない。
  // このスクリプトは既存の本番データを直すためのものであり、リモートに流すことこそが
  // 本来の用途のため。代わりに接続先を必ず表示して、意図しない DB への実行に気付けるようにする。
  const resolvedUrl = process.env.TURSO_DATABASE_URL ?? "file:local.db";

  console.log(`対象DB: ${resolvedUrl}`);
  console.log(
    options.apply
      ? "モード: --apply（実際に UPDATE を流します）"
      : "モード: dry-run（DB は変更しません。適用するには --apply を付けてください）",
  );

  const { db, client } = createDb(resolvedUrl);

  try {
    const { changes, updated } = await runBackfill(db, { apply: options.apply });
    console.log(formatPlanReport(changes));

    if (options.apply) {
      console.log(`更新完了: ${updated} 件`);
    }
  } finally {
    // 途中で例外が起きてもハンドルを開いたままにしない（seed.ts と同じ）。
    client.close();
  }
}

// テストからこのモジュールを import しても main() が走らないよう、
// 直接実行されたときだけ起動する（seed.ts は import されないため無条件に実行している）。
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
