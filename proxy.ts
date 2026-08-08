/**
 * `/projects` 配下への未ログインアクセスを `/sign-in` へ振り向ける
 * 軽量チェック（Cookieの有無だけを見る。DBアクセスは行わない）。
 *
 * これは「入り口での大半のケースの足切り」であり、正式な検証
 * （ドメイン制限の再チェックを含む）は引き続き各ページの
 * `requireLogin(await getSession())` が担う（多層防御。`lib/auth/session.ts`
 * 参照）。Cookieが有効に見えても実際のセッションが無効/期限切れ/ドメイン
 * 制限に反する場合は、ページ側で `UnauthorizedError` となり `app/error.tsx`
 * が受け止める。
 *
 * Next.js 16 で `middleware.ts` は非推奨になり `proxy.ts`（エクスポート名も
 * `proxy`）に置き換えられた（実機ビルドで非推奨警告を確認済み）。
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie) {
    const signInUrl = new URL("/sign-in", request.url);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

/**
 * 保護対象のパス。**ログインが要る画面を追加したら必ずここにも足すこと。**
 * 漏らしてもデータは出ない（ページ側の `requireLogin` が例外を投げる）が、
 * 利用者にはログイン導線ではなく汎用エラー画面が出る。実際に Phase 2 で
 * 追加した `/dashboard` がここから漏れていた。`e2e/auth-redirect.spec.ts` が
 * 一覧を突き合わせているので、足し忘れると E2E が落ちる。
 */
export const config = {
  matcher: ["/projects/:path*", "/dashboard/:path*"],
};
