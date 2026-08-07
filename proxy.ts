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

export const config = {
  matcher: ["/projects/:path*"],
};
