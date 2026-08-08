import type { NextConfig } from "next";

/**
 * 全レスポンスに付けるセキュリティヘッダー。
 *
 * 追加の経緯: 公開前のセキュリティ監査で「ヘッダーが1つも返っていない」ことを
 * `curl -D -` で実測した（`X-Powered-By: Next.js` だけが返る状態だった）。
 *
 * 特に効くのがクリックジャッキング対策。Next.js の Server Action は Origin/Host の
 * 一致検証を持つが、**iframe 内からのリクエストは正規の Origin になるためこの検証を
 * 素通りする**。埋め込みを禁止しないと、ログイン済みの利用者に透明レイヤ越しで
 * 「プロジェクト削除」を踏ませられる。`X-Frame-Options` と CSP の `frame-ancestors`
 * を両方置くのは、前者しか解釈しない古い環境を落とさないため。
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    // このアプリは外部ホストから何も読み込まない（Mantine / charts / datatable の
    // CSS も SVAR Gantt もすべてバンドル済み、アバター画像も出していない）ため、
    // `default-src 'self'` で閉じられる。外部リソースを足すときはここを緩める前に、
    // 本当にバンドルできないかを先に検討すること。
    //
    // `script-src` に `'unsafe-inline'` が要るのは、Next.js が App Router の
    // ハイドレーション用ブートストラップをインラインの `<script>` で出力するため。
    // nonce 方式にするには proxy.ts でリクエストごとに nonce を発行して
    // `'strict-dynamic'` と組み合わせる必要があり、静的化との相性も悪い。
    // `style-src` の `'unsafe-inline'` は Mantine が CSS 変数と動的スタイルを
    // インラインで注入するため（`ColorSchemeScript` を含む）。
    //
    // 値を変えたら E2E（`npm run test:e2e`）を必ず流すこと。E2E は
    // `npm run build && npm run start` の本番ビルドに対して実ブラウザで動くので、
    // CSP 違反で画面が壊れれば落ちる。
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // next dev が CLAUDE.md に Next.js 破壊的変更の注意書きを自動追記する機能を無効化する。
  // このリポジトリの CLAUDE.md はユーザーが管理するクラウドセッション運用ルールのため、
  // ビルドツール側から書き換えさせない。
  agentRules: false,
  // `X-Powered-By: Next.js` を返さない。フレームワークとバージョン帯を
  // 攻撃者に無償で開示する必要はない。
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
