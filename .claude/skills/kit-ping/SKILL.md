---
name: kit-ping
description: 配布されたスキルが実際に全て使える状態かを検証する。マニフェストと実体を突き合わせ、欠落・リンク切れ・空ファイルを検出する。「kit-ping」「スキル読み込み確認して」「クラウド対応できてるか確認して」と言われたら使う。
license: MIT
metadata:
  author: sinoda
  version: "2.0"
---

# kit-ping

配布されたスキルが**全て実体として存在し、使える状態か**を検証する。

## なぜ「このスキルが動いたら OK」では不十分か

このスキルが発火することは、`kit-ping` 自身が読めたことしか証明しない。
過去に、11スキル中7つがシンボリックリンクのまま配置されて全滅していたのに、
`kit-ping` だけは実体があったため「成功」と報告してしまった事故がある。

**必ず下記の検証を実行し、マニフェストとの突き合わせ結果を報告すること。**
発火しただけで OK と報告してはいけない。

## 検証手順

以下を順に実行し、結果を番号付きで報告する。

### 1. マニフェストの読み込み

```bash
cat .claude/.claude-kit-manifest 2>/dev/null || echo "MANIFEST_MISSING"
```

`MANIFEST_MISSING` の場合は未配布。§判定の D に該当する。

### 2. 期待スキルと実体の突き合わせ

```bash
expected=$(sed -n 's/^skills=//p' .claude/.claude-kit-manifest)
missing=""; empty=""; linked=""
for s in $expected; do
  d=".claude/skills/$s"
  if [ -L "$d" ]; then linked="$linked $s"
  elif [ ! -d "$d" ]; then missing="$missing $s"
  elif [ ! -s "$d/SKILL.md" ]; then empty="$empty $s"
  fi
done
echo "期待: $(echo $expected | wc -w) 件"
echo "欠落:${missing:- なし}"
echo "リンク:${linked:- なし}"
echo "空:${empty:- なし}"
```

### 3. リポジトリ全体のリンク切れ確認

```bash
find .claude -type l 2>/dev/null || true
find .claude -xtype l 2>/dev/null || true
```

どちらも出力が無いことを確認する。出力があればリンク切れが存在する。

### 4. スキル一覧との照合

自分が現在ロードしているスキル一覧を確認し、マニフェストの各スキルが
実際に一覧へ載っているかを照合する。ディスク上にファイルがあっても
セッション開始後に配置されたものは登録されていない。

### 5. 実行環境

```bash
uname -s && pwd && ls CLAUDE.md 2>/dev/null
```

## 報告フォーマット

```
kit-ping 結果
1. マニフェスト: あり / なし
2. 突き合わせ: 期待 N 件 / 欠落 X / リンク Y / 空 Z
3. リンク切れ: なし / (一覧)
4. スキル一覧との照合: N 件中 M 件が実際にロード済み
5. 環境: (uname -s) / cwd / CLAUDE.md の有無

判定: 正常 / 要対処（理由）
```

## 判定

| 状況 | 判定 | 対処 |
|---|---|---|
| 欠落・リンク・空・リンク切れが全てゼロ、一覧とも一致 | 正常 | なし |
| リンクまたはリンク切れがある | **要対処** | 配布元で `-L` 付きの再配置が必要 |
| 欠落がある | **要対処** | 再配置が必要 |
| ディスクにはあるが一覧に無い | **要対処** | push 前に開いたセッション。開き直す |
| マニフェストが無い | **未配布** | 配布スクリプトの実行が必要 |

要対処の場合は、**何件中何件が壊れているかを具体的に報告する**。
「動きました」だけの報告は禁止する。
