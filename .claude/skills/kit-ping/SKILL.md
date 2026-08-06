---
name: kit-ping
description: claude-kit のスキルがこのセッションで読み込まれているかを確認する疎通チェック。「kit-ping」「スキル読み込み確認して」「クラウド対応できてるか確認して」と言われたら使う。
license: MIT
metadata:
  author: sinoda
  version: "1.1"
---

# kit-ping

claude-kit で配布したスキルが、現在のセッションで有効になっているかを確認する。

クラウドセッション（claude.ai/code）では、リポジトリの `.claude/skills/` にファイルが
存在した状態でセッションを開始しないとスキルが読み込まれない。
このスキルが発火すれば、その前提が満たされていることの証拠になる。

## 手順

このスキルが読み込まれた時点で疎通は成立している。以下を報告する。

```
kit-ping OK
- loaded-from: (このSKILL.mdの絶対パス)
- 実行環境: (uname -s の結果。Darwin ならローカル、Linux ならクラウドの可能性)
```

続けて次を確認して報告する。

1. `.claude/skills/` に何件のスキルが配置されているか
   ```bash
   ls .claude/skills 2>/dev/null | wc -l
   ```
2. `.claude/.claude-kit-manifest` の内容（配布時の claude-kit のコミットと、配布したスキル一覧）
   ```bash
   cat .claude/.claude-kit-manifest 2>/dev/null || echo "マニフェストなし（未配布）"
   ```
3. リポジトリルートに `CLAUDE.md` があるか
4. スキル一覧に `hearing` `implementation-plan` `code-review-cc` が見えているか

## 判定

| 状況 | 意味 |
|---|---|
| このスキルが発火し、マニフェストもある | 正常。配布済みで読み込まれている |
| 発火したがマニフェストが無い | グローバル（`~/.claude/skills/`）から読まれている。ローカル実行 |
| そもそも発火しない | 未配布、または push 前のセッションを開いている |

3つ目の場合は、ローカルで配布スクリプトを実行し、`.claude/` と `CLAUDE.md` を
コミット・push してから、**新しいセッション**を開き直す必要がある。
クラウドはセッション開始時のディスク状態しか見ないため、push 前のセッションには反映されない。
