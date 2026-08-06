---
name: implementation-plan
description: Produce a step-by-step implementation plan — target files, steps, dependencies, test plan, and rollback plan — before writing code. Use when asked to plan an implementation before coding ("実装計画を立てて", "着手前にプランして"). Do not use once requirements are still unclear (use a hearing/requirements-gathering flow first).
---

# Implementation Plan

3エージェント共通の実装計画テンプレ。

## Purpose

要件がある程度固まった後、実行手順・依存関係・リスクを計画に落とす。

## When to Use

- 「実装計画を立てて」「着手前にプランして」と依頼されたとき
- 要件は固まっているが、着手前に手順を整理したいとき

## When Not to Use

- 要件・仕様がまだ固まっていない場合（先に要件を確認してから使う）

## Inputs

- 実装したい機能・変更の概要
- 既知の制約（期限、影響範囲、非互換変更の可否）

## Instructions

1. 変更対象のファイル・モジュールを特定する（既存コードを読んで確認する）。
2. 実装ステップを依存順に並べる。
3. 各ステップの検証方法（テスト種別、確認コマンド）を明記する。
4. ロールバック方法を明記する（元に戻すコストが高い変更ほど詳しく）。
5. 完了条件（Definition of Done）を明記する。

## Validation

- 各ステップが具体的で、担当ファイル・変更内容が特定できること
- ロールバック計画が「git revertする」で済まない変更（DBスキーマ等）は、その旨を明記していること

## Output Format

```
## Goal
<達成したいこと>

## Target Files
<ファイル/モジュール一覧>

## Steps
1. <ステップ> — 検証: <方法>
2. ...

## Dependencies
<ステップ間の依存関係>

## Test Plan
<テスト種別と確認項目>

## Rollback Plan
<元に戻す手順>

## Definition of Done
<完了条件>
```

## Failure Handling

- 要件が曖昧で計画が立てられない場合は、具体的な不明点を挙げて確認する
