/**
 * 全体共通の404ページ（M6 #34）。カスタムページが無いとNext.js既定の
 * 素っ気ない画面が出るため、他画面と統一感のあるMantineベースの表示にする。
 *
 * `Button` の polymorphic `component` prop に next/link の `Link`（関数）を
 * Server Component（本ファイル）から直接渡すと、Client Component（Mantine
 * Button）の境界を関数値のまま越えようとして "Functions cannot be passed
 * directly to Client Components" で実行時エラーになる（`app/projects/page.tsx`
 * で確認済みの既知の落とし穴と同じ。e2e実行時にサーバログで再現確認済み）。
 * `Link` で `Button`（`<button>` 要素）を包むと、この関数越境エラーは避けられる
 * ものの、`<a><button>...</button></a>` という不正な入れ子（インタラクティブ要素の
 * 二重ネスト）になってしまう。`component="a"` は文字列（関数ではない）のため
 * Server→Client の境界を安全に越えられ、かつ実際に描画される要素も
 * ナビゲーション用途として意味的に正しい単一の `<a>` タグになる
 * （Next.jsのクライアント側プリフェッチ/遷移は使えなくなるが、404という
 * まれな経路のページであり通常のフルページ遷移で十分）。
 */
import { Button, Center, Stack, Text, Title } from "@mantine/core";

export default function NotFound() {
  return (
    <Center h="60vh">
      <Stack align="center" gap="sm">
        <Title order={2}>ページが見つかりません</Title>
        <Text c="dimmed">お探しのページは存在しないか、削除された可能性があります。</Text>
        <Button component="a" href="/projects" mt="sm">
          プロジェクト一覧へ戻る
        </Button>
      </Stack>
    </Center>
  );
}
