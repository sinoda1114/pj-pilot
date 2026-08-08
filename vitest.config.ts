import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**", ".claude/worktrees/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      // ラチェット方式: 実測値の少し下に設定し、カバレッジの退行だけを CI で止める。
      // 向上したら随時引き上げる。
      //
      // 2026-08-08 の補強（Server Actions・認可・境界値・防御的分岐）で
      // 実測が Stmts 95.67 / Branch 92.88 / Funcs 94.14 / Lines 95.46 まで上がったため、
      // 85/75/85/85 から引き上げた。ここを上げないと、せっかく塞いだ穴が
      // 静かに開き直しても CI が気付けない。
      thresholds: {
        statements: 94,
        branches: 90,
        functions: 92,
        lines: 94,
      },
    },
  },
});
