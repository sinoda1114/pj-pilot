---
name: code-review
description: Review a diff or pull request for bugs, security issues, regressions, and maintainability problems. Use when asked to review a diff, pull request, or implementation ("この差分をレビューして", "PRをレビューして"). Do not use for implementing new features, and do not use for deep security-only audits (see security-review for that).
---

# Code Review

3エージェント（Claude Code / Codex / Cursor）共通の軽量差分レビュー。

## Purpose

変更差分を読み、バグ・リグレッション・保守性問題を重要度順に洗い出す。

## When to Use

- 「差分をレビューして」「PRをレビューして」と依頼されたとき
- コミット前・PR作成前に品質確認したいとき

## When Not to Use

- 新機能の実装依頼（実装はこのスキルの範囲外）
- 認証・認可・秘密情報・OWASP観点の深掘りが主目的（`security-review`を使う）

## Inputs

- 対象: 未コミット差分（デフォルト）、または指定されたPR番号/ブランチ

## Instructions

1. 対象差分を特定する
   ```bash
   git status --short
   git diff --stat
   git diff HEAD
   ```
   PRが指定された場合は `gh pr diff <NUMBER>` 等で取得する。
2. 変更ファイルを全文読む（差分の周辺コンテキストも見る）。
3. 次の観点でチェックする。
   - **正しさ**: ロジック誤り、off-by-one、null/undefined処理、エッジケース
   - **リグレッション**: 既存挙動を壊していないか
   - **セキュリティ（軽く）**: ハードコードされた認証情報、明らかなインジェクション
   - **保守性**: 長すぎる関数、深いネスト、命名、重複
   - **テスト**: 新規ロジックにテストがあるか
4. 各指摘に重要度（CRITICAL / HIGH / MEDIUM / LOW）を付け、ファイルパスと行番号を添える。
5. スタイルの好み（フォーマット等）は指摘に含めない。

## Validation

- 指摘には必ずファイルパス・行番号・理由・修正案が揃っていること
- 実際に壊れる入力/状況を示せない指摘は出さない

## Output Format

```
## Summary
<1-2文の総評>

## Critical
<file:line — issue — fix>

## High
## Medium
## Low

## Recommended Tests
<不足しているテストの提案>
```

## Failure Handling

- 差分が空の場合は「レビュー対象なし」とだけ伝えて終了する
- 対象ファイルが読めない場合はその旨を明記し、読めた範囲でレビューを続ける
