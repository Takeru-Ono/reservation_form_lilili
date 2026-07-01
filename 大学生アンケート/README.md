# 大学生アンケート

このフォルダは大学生用アンケートを単独の Apps Script プロジェクトとして使う前提の置き場です。

## 使い方

1. このフォルダの `Code.gs` を Apps Script プロジェクトへ貼り付ける
2. `CONFIG_UNIVERSITY` のプレースホルダーを実データに差し替える
3. `setupNewFormUniversity()` を実行する
4. フォーム送信トリガーを `onFormSubmitUniversity` に設定する

## 差し替えが必要な値

- `spreadsheetId`
- `questionBankSpreadsheetId`
- `sourceFormId`

## 保存先

- `質問ログ_大学生`
- `sessions`
- `question_sets`
- `responses`
- 回答者名ごとのシート
