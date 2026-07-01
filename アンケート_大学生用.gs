/***************
 * 大学生用アンケート
 * このファイルは単体で Apps Script プロジェクトにコピーして使う想定です。
 * 下記の ID は実際のスプレッドシート / フォーム ID に置き換えてください。
 ***************/
const CONFIG_UNIVERSITY = {
  questionBankSpreadsheetId: "PASTE_UNIVERSITY_QUESTION_BANK_SPREADSHEET_ID",
  questionBankSheetName: "説明資料用",
  logSheetName: "質問ログ_大学生",
  formTitle: "日々の自己評価アンケート（大学生用）",
  fixedQuestionTitles: ["Q1", "Q2", "Q3", "Q4"],

  categories: ["自己有用感", "経験・挑戦", "協力・対話", "社会とのつながり"],
  scaleChoices: [
    "まったくそう思わない",
    "あまりそう思わない",
    "ときどきそう思う",
    "少しそう思う",
    "とてもそう思う",
  ],
  useStarOnly: true,

  sourceFormId: "PASTE_UNIVERSITY_SOURCE_FORM_ID",
  nameQuestionTitle: "おなまえ",
};

/***************
 * 1) 初回セットアップ（新規フォーム作成）
 ***************/
function setupNewFormUniversity() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 質問ログシート作成
  const logSheet =
    ss.getSheetByName(CONFIG_UNIVERSITY.logSheetName) ||
    ss.insertSheet(CONFIG_UNIVERSITY.logSheetName);
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow(["日付", "新分類", "小項目(質問文)", "質問集行番号"]);
  }

  // 新規フォーム作成
  const form = FormApp.create(CONFIG_UNIVERSITY.formTitle);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // Q1: 名前（ラジオボタン）
  const nameChoices = getNameChoicesUniversity_();
  form
    .addMultipleChoiceItem()
    .setTitle("名前")
    .setChoiceValues(nameChoices)
    .setRequired(true);

  // Q2-5: 固定タイトルの評価項目
  CONFIG_UNIVERSITY.fixedQuestionTitles.forEach((title) => {
    form
      .addMultipleChoiceItem()
      .setTitle(title)
      .setChoiceValues(CONFIG_UNIVERSITY.scaleChoices)
      .setRequired(true);
  });

  // フォームID保存
  PropertiesService.getScriptProperties().setProperty(
    "FORM_ID_UNIVERSITY",
    form.getId()
  );

  // 初回の質問更新
  refreshDailyQuestionsUniversity();

  Logger.log("新規フォーム作成完了: " + form.getEditUrl());
}

/***************
 * 2) 毎日質問入れ替え
 ***************/
function refreshDailyQuestionsUniversity() {
  const form = getFormUniversity_();
  const selected = pickDailyQuestionsUniversity_();

  // フォームの質問（Q2-5）にヘルプテキストで質問文を入れる
  const mcItems = form.getItems(FormApp.ItemType.MULTIPLE_CHOICE);
  if (mcItems.length < 5) {
    throw new Error(
      "フォームに質問が5つありません。setupNewFormUniversity を実行してください。"
    );
  }

  // 2〜5番目のみ書き換え
  selected.forEach((q, i) => {
    mcItems[i + 1]
      .asMultipleChoiceItem()
      .setTitle(CONFIG_UNIVERSITY.fixedQuestionTitles[i])
      .setChoiceValues(CONFIG_UNIVERSITY.scaleChoices)
      .setHelpText(q.text);
  });

  // 質問ログに記録（横並び）
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet =
    ss.getSheetByName(CONFIG_UNIVERSITY.logSheetName) ||
    ss.insertSheet(CONFIG_UNIVERSITY.logSheetName);

  // ヘッダーが無ければ作成
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow([
      "日付",
      "自己有用感(小項目)",
      "経験・挑戦(小項目)",
      "協力・対話(小項目)",
      "社会とのつながり(小項目)",
    ]);
  }

  const today = new Date();
  logSheet.appendRow([
    today,
    selected[0]?.text || "",
    selected[1]?.text || "",
    selected[2]?.text || "",
    selected[3]?.text || "",
  ]);

  // 現在の質問をプロパティにも保存（onFormSubmit用）
  PropertiesService.getScriptProperties().setProperty(
    "TODAY_QUESTIONS_UNIVERSITY",
    JSON.stringify(selected)
  );
}

/***************
 * 3) フォーム回答時に名前別シートへ整形
 ***************/
function onFormSubmitUniversity(e) {
  const namedValues = e.namedValues;
  const name = (namedValues["おなまえ"] || [""])[0].trim();
  if (!name) return;

  const todayQuestions = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(
      "TODAY_QUESTIONS_UNIVERSITY"
    ) || "[]"
  );
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const personSheet = ss.getSheetByName(name) || ss.insertSheet(name);

  // 初回のみヘッダー（1行目に名前、2行目にヘッダー）
  if (personSheet.getLastRow() === 0) {
    personSheet.getRange(1, 1).setValue(name);
    personSheet.appendRow([
      "日付",
      "自己有用感(数値)",
      "経験・挑戦(数値)",
      "協力・対話(数値)",
      "社会とのつながり(数値)",
      "自己有用感(小項目)",
      "経験・挑戦(小項目)",
      "協力・対話(小項目)",
      "社会とのつながり(小項目)",
    ]);
  }

  const submittedAt = e.values[0] ? new Date(e.values[0]) : new Date();
  const scoreMap = {
    とてもそう思う: 5,
    少しそう思う: 4,
    ときどきそう思う: 3,
    あまりそう思わない: 2,
    まったくそう思わない: 1,
  };

  // Q1〜Q4 の評価と質問文を整形
  const scores = [];
  const texts = [];
  CONFIG_UNIVERSITY.fixedQuestionTitles.forEach((title, i) => {
    const choice = (namedValues[title] || [""])[0];
    scores.push(scoreMap[choice] || "");
    texts.push(todayQuestions[i] ? todayQuestions[i].text : "");
  });

  personSheet.appendRow([submittedAt, ...scores, ...texts]);
}

/***************
 * Helper: 質問抽出
 ***************/
function pickDailyQuestionsUniversity_() {
  const bankSS = SpreadsheetApp.openById(
    CONFIG_UNIVERSITY.questionBankSpreadsheetId
  );
  const sheet = bankSS.getSheetByName(CONFIG_UNIVERSITY.questionBankSheetName);
  if (!sheet) {
    throw new Error(
      "質問集シートが見つかりません: " + CONFIG_UNIVERSITY.questionBankSheetName
    );
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 3) {
    throw new Error(
      "質問集のデータが不足しています（A3以降に質問が必要です）。"
    );
  }

  // A3から最終行まで
  const data = sheet
    .getRange(3, 1, lastRow - 2, sheet.getLastColumn())
    .getValues();

  const selected = [];
  CONFIG_UNIVERSITY.categories.forEach((cat) => {
    const candidates = data.filter((r) => {
      const category = r[1]; // B列: 新分類
      const text = r[3]; // D列: 小項目（質問文）
      if (category !== cat) return false;
      if (CONFIG_UNIVERSITY.useStarOnly && String(text).indexOf("★") === -1)
        return false;
      return true;
    });

    if (candidates.length === 0) {
      selected.push({ category: cat, text: "", rowNumber: "" });
      return;
    }
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    selected.push({
      category: picked[1],
      text: picked[3],
      rowNumber: picked[0],
    });
  });

  return selected;
}

/***************
 * Helper: 名前一覧取得
 ***************/
function getNameChoicesUniversity_() {
  const sourceForm = FormApp.openById(CONFIG_UNIVERSITY.sourceFormId);
  const items = sourceForm.getItems();

  for (const item of items) {
    if (item.getTitle() !== CONFIG_UNIVERSITY.nameQuestionTitle) continue;

    const type = item.getType();
    if (type === FormApp.ItemType.MULTIPLE_CHOICE) {
      return item
        .asMultipleChoiceItem()
        .getChoices()
        .map((c) => c.getValue());
    }
    if (type === FormApp.ItemType.LIST) {
      return item
        .asListItem()
        .getChoices()
        .map((c) => c.getValue());
    }
    throw new Error(
      "おなまえの質問が選択式ではありません。ラジオまたはプルダウンにしてください。"
    );
  }

  throw new Error("既存フォームに「おなまえ」質問が見つかりません。");
}

/***************
 * Helper: フォーム取得
 ***************/
function getFormUniversity_() {
  const formId = PropertiesService.getScriptProperties().getProperty(
    "FORM_ID_UNIVERSITY"
  );
  if (!formId) {
    throw new Error(
      "フォームIDが未設定です。setupNewFormUniversity を実行してください。"
    );
  }
  return FormApp.openById(formId);
}
