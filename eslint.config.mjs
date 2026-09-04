import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      "**/.next/**",
      "**/node_modules/**",
      "coverage/**",
      "playwright-report/**",
      ".claude/worktrees/**",
      // ベンダリングした外部スキル（claude-kit 経由）。本体のコードではないため対象外にする。
      ".claude/skills/**",
    ],
  },
];

export default eslintConfig;
