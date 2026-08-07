/**
 * プロジェクト名・説明の文字数上限（M2 #13）。
 *
 * サーバ側（`app/projects/actions.ts`）の検証と、クライアント側フォーム
 * （`components/projects/*`）の `maxLength` 表示の両方から参照する共通値。
 * `actions.ts` は "use server" ファイルのため、定数（非関数）をそのまま
 * export できない（Server Actions 以外の export が許されない）。
 * そのため定数はこの独立したファイルに切り出す。
 */
export const PROJECT_NAME_MAX_LENGTH = 200;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 2000;
