---
name: generate-docs
description: Generate a requirements/specification/structure document set (3-document set) for a new system or feature. Use when asked to write requirements, a spec, or project documentation from scratch ("要件定義書を作って", "仕様書を書いて"). Not for API reference generation from existing code (that's a different task).
---

# Generate Docs

3エージェント共通のドキュメント生成（要件定義・仕様・構造の3点セット）。

## Purpose

新規システム・機能について、要件定義書・仕様書・ストラクチャ構造の3文書を整合させて作る。

## When to Use

- 「要件定義書を作って」「仕様書を書いて」と依頼されたとき
- 新規プロジェクト・大きめの機能の企画段階

## When Not to Use

- 既存コードからのAPIリファレンス自動生成（別タスク）

## Inputs

- 対象システム・機能の概要
- 既知の制約・対象範囲

## Instructions

1. **要件定義書**を作る: 背景・目的・対象範囲・利用者・機能要件・非機能要件・受け入れ条件。
2. **仕様書**を作る: アーキテクチャ、データ構造、API/インターフェース、配置先、検証仕様。要件定義書の各項目に対応させる。
3. **ストラクチャ構造**を作る: ディレクトリ構成、ファイル責務、実装優先順位。仕様書の内容を実装可能な粒度に分解する。
4. 3文書間で用語・スコープが矛盾していないか相互チェックする。

## Validation

- 要件定義書の各機能要件が、仕様書のどこかに対応していること
- 仕様書の各コンポーネントが、ストラクチャ構造のどこかに対応していること

## Output Format

3ファイルに分けて出力する（ファイル名は呼び出し元の慣習に合わせる。例: `01_REQUIREMENTS.md` / `02_SPECIFICATION.md` / `03_STRUCTURE.md`）。各文書の冒頭に文書名・対象・作成日を記載する。

## Failure Handling

- 対象範囲が広すぎて1回で書ききれない場合は、まず目次・章立てを提示してから、セクションごとに書き進める
