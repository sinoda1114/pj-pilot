---
name: security-review
description: Perform a security-focused review of code changes — authentication, authorization, secrets, injection, SSRF, and dependency risk. Use when asked for a security review or audit ("セキュリティレビューして", "脆弱性ないか確認して"). Do not use for general code-quality review (see code-review for that).
---

# Security Review

3エージェント共通のセキュリティ観点レビュー。OWASP Top 10相当を軸にする。

## Purpose

コード変更をセキュリティ観点でのみ精査し、悪用可能な欠陥を検出する。

## When to Use

- 「セキュリティレビューして」「脆弱性がないか確認して」と依頼されたとき
- 認証・認可・入力処理・外部通信・秘密情報を扱うコードを変更したとき

## When Not to Use

- 一般的なコード品質・保守性の確認が主目的（`code-review`を使う）

## Inputs

- 対象: 指定された差分・ブランチ・PR（対象範囲が曖昧な場合はユーザーに確認する）

## Instructions

1. 対象コードを特定し、変更ファイルを全文読む。
2. 次の観点をすべて確認する。
   - **認証・認可**: 権限昇格、認可漏れ、セッション管理の不備
   - **秘密情報**: APIキー・トークン・パスワードのハードコード、ログ出力への混入
   - **インジェクション**: SQL/コマンド/XSS
   - **SSRF・パストラバーサル**: 外部URL/ファイルパスをユーザー入力から構築していないか
   - **入力検証**: 型・範囲・長さの検証漏れ
   - **依存関係**: 新規追加パッケージの信頼性、既知脆弱性
3. 各指摘に重要度（CRITICAL / HIGH / MEDIUM / LOW）を付け、具体的な悪用シナリオを添える。
4. 悪用シナリオを説明できない指摘は出さない（推測だけの指摘を避ける）。

## Validation

- 各指摘に「どう悪用されるか」の具体例があること
- CRITICALは実際にデータ漏洩・不正操作につながる経路を示せること

## Output Format

```
## Summary
<総評とブロック要否>

## Critical
<file:line — vulnerability — exploit scenario — fix>

## High
## Medium
## Low
```

## Failure Handling

- 対象範囲が不明な場合は先にユーザーへ確認する
- 外部通信先やシークレット管理の実態が確認できない場合は、その旨を明記した上で分かる範囲でレビューする
