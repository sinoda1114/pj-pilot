---
name: create-pr
description: Summarize the current branch's changes and draft a pull request title and body. Use when asked to create, open, or draft a PR ("PRを作って", "プルリクエスト作成して"). Does not push or open the PR without confirmation.
---

# Create PR

3エージェント共通のPR下書き生成。

## Purpose

ブランチの変更内容を要約し、PRタイトル・本文の下書きを作る。

## When to Use

- 「PRを作って」「プルリクエストの下書きを作って」と依頼されたとき

## When Not to Use

- ユーザーの明示確認なしにpushやPR作成（送信）まで自動で行いたい場合は、実行前に必ず確認を取る

## Inputs

- 対象ブランチ（未指定なら現在のブランチ）
- ベースブランチ（未指定なら`origin/HEAD`）

## Preconditions

- Gitリポジトリであること
- リモートにベースブランチの参照があること

## Instructions

1. 変更内容を収集する。
   ```bash
   git log <base>...HEAD --oneline
   git diff <base>...HEAD --stat
   ```
2. コミット履歴全体（直近のコミットだけでなく）から変更意図を把握する。
3. PRタイトルを1行で作る（70文字以内目安）。
4. PR本文を作る（Summary / Test Plan / 既知のリスクを含める）。
5. 実際のpush・PR作成コマンドはユーザーに提示し、実行前に確認を取る。

## Validation

- 本文のSummaryが実際の差分と一致していること
- Test Planに具体的な確認項目が入っていること

## Output Format

```
## Title
<PRタイトル>

## Body
### Summary
- <変更点1>
- <変更点2>

### Test Plan
- [ ] <確認項目>

### Known Risks
<既知のリスク、なければ「なし」>
```

## Failure Handling

- ベースブランチが特定できない場合はユーザーに確認する
- コミットが1つもない場合はその旨を伝えて終了する
