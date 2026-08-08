/**
 * CSV 文字列をファイルとしてダウンロードさせる（ブラウザ専用）。
 *
 * `document` / `URL.createObjectURL` に依存するため Client Component からのみ呼ぶこと
 * （タスク一覧とダッシュボードの2箇所で同一実装が重複していたため共通化した）。
 *
 * 一覧・集計のデータはすでにクライアント側にあるため、専用の API エンドポイントは作らず
 * Blob と `URL.createObjectURL` で完結させる（サーバーに同じ取得・整形処理を
 * 二重に持たせない）。生成した object URL は必ず `revokeObjectURL` で解放する。
 * 解放を次のイベントループに回しているのは、`click()` の直後に同期的に解放すると
 * ブラウザによってはダウンロード開始前に URL が無効化されうるため。
 * アンカーを一度 DOM に挿入するのは、切り離した要素の `click()` を無視する
 * ブラウザ（Firefox）があるため。
 */
export function downloadCsvFile(fileName: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
