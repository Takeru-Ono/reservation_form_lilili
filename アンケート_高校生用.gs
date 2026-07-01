/***************
 * 高校生用アンケート
 * このファイルは単体で Apps Script プロジェクトにコピーして使う想定です。
 * 下記の ID は実際のスプレッドシート / フォーム ID に置き換えてください。
 ***************/
const CONFIG_HIGH_SCHOOL = {
  questionBankSheetName: "説明資料用",
  logSheetName: "質問ログ_高校生",
  formTitle: "日々の自己評価アンケート（高校生用）",
  fixedQuestionTitles: ["Q1", "Q2", "Q3", "Q4"],
  entryFieldTitle: "名前",

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
 * 1) 初回セットアップ（既存フォーム更新）
 ***************/
function setupNewFormHighSchool() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 質問ログシート作成
  const logSheet =
    ss.getSheetByName(CONFIG_HIGH_SCHOOL.logSheetName) ||
    ss.insertSheet(CONFIG_HIGH_SCHOOL.logSheetName);
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow(["日付", "新分類", "小項目(質問文)", "質問集行番号"]);
  }

  const form = getHighSchoolForm_();
  form.setTitle(CONFIG_HIGH_SCHOOL.formTitle);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  const textItems = form.getItems(FormApp.ItemType.TEXT);
  if (textItems.length === 0) {
    throw new Error(
      "高校生用フォームに自由入力欄がありません。フォーム側に「名前」テキスト項目を1つ用意してください。"
    );
  }

  textItems[0]
    .asTextItem()
    .setTitle(CONFIG_HIGH_SCHOOL.entryFieldTitle)
    .setRequired(true);

  const mcItems = form.getItems(FormApp.ItemType.MULTIPLE_CHOICE);
  if (mcItems.length < 4) {
    throw new Error(
      "高校生用フォームに評価用の複数選択項目が4つありません。フォーム側に4項目用意してください。"
    );
  }

  CONFIG_HIGH_SCHOOL.fixedQuestionTitles.forEach((title, i) => {
    mcItems[i]
      .asMultipleChoiceItem()
      .setTitle(title)
      .setChoiceValues(CONFIG_HIGH_SCHOOL.scaleChoices)
      .setRequired(true);
  });

  // フォームID保存
  PropertiesService.getScriptProperties().setProperty("FORM_ID_HIGH_SCHOOL", form.getId());

  // 初回の質問更新
  refreshDailyQuestionsHighSchool();
  installHighSchoolQuestionRefreshTrigger_();
  installHighSchoolFormSubmitTrigger_();

  Logger.log("フォーム更新完了: " + form.getEditUrl());
}

/***************
 * 2) 質問入れ替え
 ***************/
function refreshDailyQuestionsHighSchool() {
  const form = getFormHighSchool_();
  const selected = pickDailyQuestionsHighSchool_();

  // フォームの評価項目（4問）にヘルプテキストで質問文を入れる
  const mcItems = form.getItems(FormApp.ItemType.MULTIPLE_CHOICE);
  if (mcItems.length < 4) {
    throw new Error(
      "フォームに評価用質問が4つありません。setupNewFormHighSchool を実行してください。"
    );
  }

  // 先頭から4問を書き換える
  selected.forEach((q, i) => {
    mcItems[i]
      .asMultipleChoiceItem()
      .setTitle(CONFIG_HIGH_SCHOOL.fixedQuestionTitles[i])
      .setChoiceValues(CONFIG_HIGH_SCHOOL.scaleChoices)
      .setHelpText(q.text);
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet =
    ss.getSheetByName(CONFIG_HIGH_SCHOOL.logSheetName) ||
    ss.insertSheet(CONFIG_HIGH_SCHOOL.logSheetName);

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
    "HIGH_SCHOOL_CURRENT_QUESTIONS",
    JSON.stringify(selected)
  );
}

/***************
 * 3) フォーム回答時に名前別シートへ整形
 ***************/
function onFormSubmitHighSchool(e) {
  const namedValues = e.namedValues;
  const entry =
    (namedValues[CONFIG_HIGH_SCHOOL.entryFieldTitle] || [""])[0].trim() ||
    (namedValues["入力"] || [""])[0].trim() ||
    (namedValues["おなまえ"] || [""])[0].trim();
  if (!entry) return;

  const submittedAt = e.values[0] ? new Date(e.values[0]) : new Date();
  const dailySheet = getDailySheetHighSchool_(submittedAt);
  const todayQuestions = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(
      "HIGH_SCHOOL_CURRENT_QUESTIONS"
    ) || "[]"
  );
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const responseSheet =
    ss.getSheetByName(dailySheet) || ss.insertSheet(dailySheet);

  // 日付ごとのシートは、1枚にその日の回答を集約する
  if (responseSheet.getLastRow() === 0) {
    responseSheet.appendRow([
      "日付",
      "名前",
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
  CONFIG_HIGH_SCHOOL.fixedQuestionTitles.forEach((title, i) => {
    const choice = (namedValues[title] || [""])[0];
    scores.push(scoreMap[choice] || "");
    texts.push(todayQuestions[i] ? todayQuestions[i].text : "");
  });

  responseSheet.appendRow([submittedAt, entry, ...scores, ...texts]);
}

/***************
 * Helper: 質問抽出
 ***************/
function pickDailyQuestionsHighSchool_() {
  const questionBankSpreadsheetId = getHighSchoolQuestionBankSpreadsheetId_();
  const bankSS = SpreadsheetApp.openById(questionBankSpreadsheetId);
  const sheet = bankSS.getSheetByName(CONFIG_HIGH_SCHOOL.questionBankSheetName);
  if (!sheet) {
    throw new Error(
      "質問集シートが見つかりません: " + CONFIG_HIGH_SCHOOL.questionBankSheetName
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
  CONFIG_HIGH_SCHOOL.categories.forEach((cat) => {
    const candidates = data.filter((r) => {
      const category = r[1]; // B列: 新分類
      const text = r[3]; // D列: 小項目（質問文）
      if (category !== cat) return false;
      if (CONFIG_HIGH_SCHOOL.useStarOnly && String(text).indexOf("★") === -1)
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
 * Helper: 日付別シート名
 ***************/
function getDailySheetHighSchool_(date) {
  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    "yyyy-MM-dd"
  );
}

function installHighSchoolFormSubmitTrigger_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const existing = ScriptApp.getProjectTriggers().filter((trigger) => {
    return (
      trigger.getHandlerFunction() === "onFormSubmitHighSchool" &&
      trigger.getEventType() === ScriptApp.EventType.ON_FORM_SUBMIT &&
      trigger.getTriggerSourceId() === ss.getId()
    );
  });

  if (existing.length > 0) return;

  ScriptApp.newTrigger("onFormSubmitHighSchool")
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();
}

function installHighSchoolQuestionRefreshTrigger_() {
  const existing = ScriptApp.getProjectTriggers().filter((trigger) => {
    return (
      trigger.getHandlerFunction() === "runHighSchoolScheduledRefresh" &&
      trigger.getEventType() === ScriptApp.EventType.CLOCK
    );
  });

  if (existing.length > 0) return;

  ScriptApp.newTrigger("runHighSchoolScheduledRefresh")
    .timeBased()
    .everyDays(1)
    .atHour(5)
    .create();
}

function runHighSchoolScheduledRefresh() {
  const props = PropertiesService.getScriptProperties();
  const today = new Date();
  const dayKey = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyyMMdd");
  const lastRunDayKey = props.getProperty("HIGH_SCHOOL_LAST_REFRESH_DAY_KEY");
  const shouldRefresh = shouldRefreshHighSchoolEvery4Days_(today);

  if (!shouldRefresh) return;
  if (lastRunDayKey === dayKey) return;

  refreshDailyQuestionsHighSchool();
  props.setProperty("HIGH_SCHOOL_LAST_REFRESH_DAY_KEY", dayKey);
}

function runHighSchoolScheduledRefresh_() {
  runHighSchoolScheduledRefresh();
}

function shouldRefreshHighSchoolEvery4Days_(date) {
  const anchor = new Date("2026-06-29T00:00:00");
  const normalizedDate = new Date(date);
  normalizedDate.setHours(0, 0, 0, 0);
  anchor.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((normalizedDate.getTime() - anchor.getTime()) / (24 * 60 * 60 * 1000));
  return diffDays >= 0 && diffDays % 4 === 0;
}

/***************
 * Helper: フォーム取得
 ***************/
function getHighSchoolForm_() {
  const storedFormId = PropertiesService.getScriptProperties().getProperty("FORM_ID_HIGH_SCHOOL");
  if (storedFormId && !/^PASTE_/.test(String(storedFormId).trim())) {
    return FormApp.openById(String(storedFormId).trim());
  }

  throw new Error(
    "高校生用フォームIDが未設定です。ScriptProperties の FORM_ID_HIGH_SCHOOL を設定してください。"
  );
}

function getFormHighSchool_() {
  return getHighSchoolForm_();
}

function getHighSchoolQuestionBankSpreadsheetId_() {
  const stored = PropertiesService.getScriptProperties().getProperty(
    "HIGH_SCHOOL_QUESTION_BANK_SPREADSHEET_ID"
  );
  const trimmedStored = String(stored || "").trim();
  if (trimmedStored && !/^PASTE_/.test(trimmedStored)) {
    return trimmedStored;
  }

  throw new Error(
    "高校生用質問バンクIDが未設定です。ScriptProperties の HIGH_SCHOOL_QUESTION_BANK_SPREADSHEET_ID を設定してください。"
  );
}
