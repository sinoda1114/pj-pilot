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
      // ラチェット方式: 実測値（Stmts 88 / Branch 79 / Funcs 90 / Lines 88）の
      // 少し下に設定し、カバレッジの退行だけを CI で止める。向上したら随時引き上げる
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 85,
      },
    },
  },
});
