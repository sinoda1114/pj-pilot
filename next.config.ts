import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // next dev が CLAUDE.md に Next.js 破壊的変更の注意書きを自動追記する機能を無効化する。
  // このリポジトリの CLAUDE.md はユーザーが管理するクラウドセッション運用ルールのため、
  // ビルドツール側から書き換えさせない。
  agentRules: false,
};

export default nextConfig;
