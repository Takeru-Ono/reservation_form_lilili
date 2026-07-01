/***************
 * CONFIG
 ***************/
const CONFIG = {
  questionBankSpreadsheetId: "1o8Kh4tqDz9I0rcTQLYir3Iu7s0cMnaIoY6T0oSt0IS0",
  questionBankSheetName: "説明資料用",
  logSheetName: "質問ログ",
  formTitle: "日々の自己評価アンケート",
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
};

/***************
 * 1) 初回セットアップ（新規フォーム作成）
 ***************/
function setupNewForm() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 質問ログシート作成
  const logSheet =
    ss.getSheetByName(CONFIG.logSheetName) ||
    ss.insertSheet(CONFIG.logSheetName);
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow(["日付", "新分類", "小項目(質問文)", "質問集行番号"]);
  }

  // 新規フォーム作成
  const form = FormApp.create(CONFIG.formTitle);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // Q1: 名前（自由入力）
  form.addTextItem().setTitle("名前").setRequired(true);

  // Q2-5: 固定タイトルの評価項目
  CONFIG.fixedQuestionTitles.forEach((title) => {
    form
      .addMultipleChoiceItem()
      .setTitle(title)
      .setChoiceValues(CONFIG.scaleChoices)
      .setRequired(true);
  });

  // フォームID保存
  PropertiesService.getScriptProperties().setProperty("FORM_ID", form.getId());

  // 初回の質問更新
  refreshDailyQuestions();

  Logger.log("新規フォーム作成完了: " + form.getEditUrl());
}

/***************
 * 2) 毎日質問入れ替え
 ***************/
function refreshDailyQuestions() {
  const form = getForm_();
  const selected = pickDailyQuestions_();

  // フォームの質問（Q2-5）にヘルプテキストで質問文を入れる
  const mcItems = form.getItems(FormApp.ItemType.MULTIPLE_CHOICE);
  Logger.log(
    "[refreshDailyQuestions] formId=" +
      form.getId() +
      " title=" +
      form.getTitle() +
      " multipleChoiceCount=" +
      mcItems.length,
  );
  mcItems.forEach((item, index) => {
    try {
      const mc = item.asMultipleChoiceItem();
      Logger.log(
        "[refreshDailyQuestions] item#" +
          index +
          " title=" +
          mc.getTitle() +
          " help=" +
          mc.getHelpText(),
      );
    } catch (err) {
      Logger.log(
        "[refreshDailyQuestions] item#" +
          index +
          " type=" +
          item.getType() +
          " title=" +
          item.getTitle(),
      );
    }
  });
  if (mcItems.length < 4)
    throw new Error(
      "フォームに評価用質問が4つありません。setupNewForm を実行してください。",
    );

  // 評価用4問を書き換え
  selected.forEach((q, i) => {
    mcItems[i]
      .asMultipleChoiceItem()
      .setTitle(CONFIG.fixedQuestionTitles[i]) // タイトル固定で列を変えない
      .setChoiceValues(CONFIG.scaleChoices)
      .setHelpText(q.text); // 質問文はヘルプテキストへ
  });

  // 質問ログに記録（横並び）
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet =
    ss.getSheetByName(CONFIG.logSheetName) ||
    ss.insertSheet(CONFIG.logSheetName);

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
    "TODAY_QUESTIONS",
    JSON.stringify(selected),
  );
}

/***************
 * 3) フォーム回答時に名前別シートへ整形
 ***************/
function onFormSubmit(e) {
  const namedValues = e.namedValues;
  const name = getHighSchoolSubmittedName_(namedValues);
  if (!name) return;

  const todayQuestions = JSON.parse(
    PropertiesService.getScriptProperties().getProperty("TODAY_QUESTIONS") ||
      "[]",
  );
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const personSheet = ss.getSheetByName(name) || ss.insertSheet(name);

  // 初回のみヘッダー
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
  CONFIG.fixedQuestionTitles.forEach((title, i) => {
    const choice = (namedValues[title] || [""])[0];
    scores.push(scoreMap[choice] || "");
    texts.push(todayQuestions[i] ? todayQuestions[i].text : "");
  });

  personSheet.appendRow([submittedAt, ...scores, ...texts]);
}

/***************
 * Helper: 質問抽出
 ***************/
function pickDailyQuestions_() {
  const bankSS = SpreadsheetApp.openById(CONFIG.questionBankSpreadsheetId);
  const sheet = bankSS.getSheetByName(CONFIG.questionBankSheetName);
  if (!sheet)
    throw new Error(
      "質問集シートが見つかりません: " + CONFIG.questionBankSheetName,
    );

  const lastRow = sheet.getLastRow();
  if (lastRow < 3)
    throw new Error(
      "質問集のデータが不足しています（A3以降に質問が必要です）。",
    );

  // A3から最終行まで
  const data = sheet
    .getRange(3, 1, lastRow - 2, sheet.getLastColumn())
    .getValues();

  const selected = [];
  CONFIG.categories.forEach((cat) => {
    const candidates = data.filter((r) => {
      const category = r[1]; // B列: 新分類
      const text = r[3]; // D列: 小項目（質問文）
      if (category !== cat) return false;
      if (CONFIG.useStarOnly && String(text).indexOf("★") === -1) return false;
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
 * Helper: フォーム取得
 ***************/
function getForm_() {
  const formId = PropertiesService.getScriptProperties().getProperty("FORM_ID");
  if (!formId)
    throw new Error(
      "フォームIDが未設定です。setupNewForm を実行してください。",
    );
  return FormApp.openById(formId);
}

function getHighSchoolSubmittedName_(namedValues) {
  const keys = ["名前", "入力", "おなまえ", "name"];
  for (const key of keys) {
    const value = (namedValues && namedValues[key] ? namedValues[key] : [""])[0];
    const trimmed = String(value || "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/***************
 * Debug: 現在のフォーム状態をログに出す
 ***************/
function debugFormState() {
  const formId = PropertiesService.getScriptProperties().getProperty("FORM_ID");
  if (!formId) {
    Logger.log("[debugFormState] FORM_ID が未設定です");
    return;
  }

  const form = FormApp.openById(formId);
  const items = form.getItems();

  Logger.log("[debugFormState] FORM_ID=" + formId);
  Logger.log("[debugFormState] formTitle=" + form.getTitle());
  Logger.log("[debugFormState] itemCount=" + items.length);

  items.forEach((item, index) => {
    Logger.log(
      "[debugFormState] #" +
        index +
        " type=" +
        item.getType() +
        " title=" +
        item.getTitle(),
    );
  });
}

/***************
 * Debug: 質問バンク側の候補を確認する
 ***************/
function debugQuestionBankState() {
  const bankSS = SpreadsheetApp.openById(CONFIG.questionBankSpreadsheetId);
  const sheet = bankSS.getSheetByName(CONFIG.questionBankSheetName);
  if (!sheet) {
    Logger.log(
      "[debugQuestionBankState] 質問集シートが見つかりません: " +
        CONFIG.questionBankSheetName,
    );
    return;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  Logger.log(
    "[debugQuestionBankState] sheet=" +
      sheet.getName() +
      " lastRow=" +
      lastRow +
      " lastCol=" +
      lastCol,
  );

  const data = sheet
    .getRange(3, 1, Math.max(0, lastRow - 2), lastCol)
    .getValues();
  CONFIG.categories.forEach((cat) => {
    const candidates = data.filter((r) => {
      const category = r[1];
      const text = r[3];
      if (category !== cat) return false;
      if (CONFIG.useStarOnly && String(text).indexOf("★") === -1) return false;
      return true;
    });
    Logger.log(
      "[debugQuestionBankState] category=" +
        cat +
        " candidates=" +
        candidates.length,
    );
  });
}
