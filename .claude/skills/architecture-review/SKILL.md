---
name: architecture-review
description: Evaluate a design or architecture proposal against requirements, component boundaries, data flow, security, availability, and cost tradeoffs. Use when asked to review an architecture, design doc, or system design ("設計をレビューして", "アーキテクチャどう思う").
---

# Architecture Review

3エージェント共通の設計レビュー。

## Purpose

設計案を品質特性の観点で評価し、トレードオフを明示する。

## When to Use

- 「この設計どう思う」「アーキテクチャをレビューして」と依頼されたとき
- 新機能・大きめの変更の設計段階

## When Not to Use

- 実装済みコードの品質レビュー（`code-review`を使う）

## Inputs

- 設計案（ドキュメント、図、または口頭説明）
- 既知の制約（性能要件、期限、チーム規模など、あれば）

## Instructions

1. 設計案を理解し、不明点があれば先に確認する。
2. 次の品質特性で評価する。
   - **要件との整合**: 要求を満たしているか
   - **コンポーネント境界**: 責務が適切に分かれているか
   - **データフロー**: 一貫性・整合性の担保
   - **セキュリティ**: 認証認可、データ保護
   - **可用性**: 単一障害点、リトライ・冪等性
   - **運用性**: 監視・デバッグのしやすさ
   - **コスト**: 実装・運用コスト
3. 各観点で強み・弱み・代替案をトレードオフとして提示する。
4. 「これで進めてよいか」の推奨を1つ出す（GO / 条件付きGO / 再検討）。

## Validation

- 指摘には代替案または軽減策が伴っていること
- 単なる好みの指摘（無根拠な言い換え等）はしない

## Output Format

```
## Summary
<総評と推奨>

## Strengths
## Concerns
<観点ごとに: 懸念 — 影響 — 代替案/軽減策>

## Recommendation
GO / 条件付きGO / 再検討
```

## Failure Handling

- 設計案が不完全で評価できない場合は、不足している情報を具体的に聞き返す
