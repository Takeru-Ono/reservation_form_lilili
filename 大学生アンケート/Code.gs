/***************
 * 大学生用アンケート
 * このフォルダをそのまま Apps Script プロジェクトとして使う想定です。
 * 下記の ID は実際のスプレッドシート / フォーム ID に置き換えてください。
 ***************/
const CONFIG_UNIVERSITY = {
  spreadsheetId: "1BehqLRtWNl4J3hJw3L9lpRiHdTc_ukEiqtR1nkKgW1E",
  questionBankSpreadsheetId: "1o8Kh4tqDz9I0rcTQLYir3Iu7s0cMnaIoY6T0oSt0IS0",
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
};

/***************
 * 1) 初回セットアップ（新規フォーム作成）
 ***************/
function setupNewFormUniversity() {
  const ss = getUniversitySpreadsheet_();

  const logSheet =
    ss.getSheetByName(CONFIG_UNIVERSITY.logSheetName) ||
    ss.insertSheet(CONFIG_UNIVERSITY.logSheetName);
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow(["日付", "新分類", "小項目(質問文)", "質問集行番号"]);
  }

  const form = FormApp.create(CONFIG_UNIVERSITY.formTitle);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  form.addTextItem().setTitle("名前").setRequired(true);

  CONFIG_UNIVERSITY.fixedQuestionTitles.forEach((title) => {
    form
      .addMultipleChoiceItem()
      .setTitle(title)
      .setChoiceValues(CONFIG_UNIVERSITY.scaleChoices)
      .setRequired(true);
  });

  PropertiesService.getScriptProperties().setProperty(
    "FORM_ID_UNIVERSITY",
    form.getId()
  );

  refreshDailyQuestionsUniversity();

  Logger.log("新規フォーム作成完了: " + form.getEditUrl());
}

/***************
 * 2) 質問入れ替え
 ***************/
function refreshDailyQuestionsUniversity() {
  const form = getFormUniversity_();
  const selected = pickDailyQuestionsUniversity_();

  const mcItems = form.getItems(FormApp.ItemType.MULTIPLE_CHOICE);
  if (mcItems.length < 5) {
    throw new Error(
      "フォームに質問が5つありません。setupNewFormUniversity を実行してください。"
    );
  }

  selected.forEach((q, i) => {
    mcItems[i + 1]
      .asMultipleChoiceItem()
      .setTitle(CONFIG_UNIVERSITY.fixedQuestionTitles[i])
      .setChoiceValues(CONFIG_UNIVERSITY.scaleChoices)
      .setHelpText(q.text);
  });

  const ss = getUniversitySpreadsheet_();
  const logSheet =
    ss.getSheetByName(CONFIG_UNIVERSITY.logSheetName) ||
    ss.insertSheet(CONFIG_UNIVERSITY.logSheetName);

  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow([
      "日付",
      "自己有用感(小項目)",
      "経験・挑戦(小項目)",
      "協力・対話(小項目)",
      "社会とのつながり(小項目)",
    ]);
  }

  logSheet.appendRow([
    new Date(),
    selected[0]?.text || "",
    selected[1]?.text || "",
    selected[2]?.text || "",
    selected[3]?.text || "",
  ]);

  PropertiesService.getScriptProperties().setProperty(
    "TODAY_QUESTIONS_UNIVERSITY",
    JSON.stringify(selected)
  );
}

/***************
 * 3) 回答時に保存
 ***************/
function onFormSubmitUniversity(e) {
  const namedValues = e.namedValues;
  const name = getUniversitySubmittedName_(namedValues);
  if (!name) return;

  const todayQuestions = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(
      "TODAY_QUESTIONS_UNIVERSITY"
    ) || "[]"
  );

  const ss = getUniversitySpreadsheet_();
  const personSheet = ss.getSheetByName(name) || ss.insertSheet(name);

  if (personSheet.getLastRow() === 0) {
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
  const data = getUniversityQuestionBankRows_();

  const selected = [];
  CONFIG_UNIVERSITY.categories.forEach((cat) => {
    const candidates = data.filter((r) => {
      const category = r[1];
      const text = r[3];
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

/***************
 * Web App Routing
 ***************/
function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || "survey";
  const templateName = page === "admin" ? "admin" : "survey";
  const tpl = HtmlService.createTemplateFromFile(templateName);
  tpl.appUrl = getUniversityAppUrl_();
  tpl.debugInfo = getUniversityDebugInfo_();
  tpl.initialParams = {
    page,
    sessionId: (e && e.parameter && e.parameter.session) || "",
    phase: (e && e.parameter && e.parameter.phase) || "pre",
  };
  return tpl
    .evaluate()
    .setTitle(
      page === "admin" ? "大学生アンケート 管理画面" : "大学生アンケート"
    )
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getUniversityAppUrl_() {
  return (
    PropertiesService.getScriptProperties().getProperty("APP_URL") ||
    ScriptApp.getService().getUrl() ||
    ""
  );
}

function getUniversityDebugInfo_() {
  return {
    version: "2026-06-30-01",
    appUrl: getUniversityAppUrl_(),
    spreadsheetId: String(CONFIG_UNIVERSITY.spreadsheetId || "").trim(),
    questionBankSpreadsheetId: String(
      CONFIG_UNIVERSITY.questionBankSpreadsheetId || ""
    ).trim(),
    fixedQuestionTitles: CONFIG_UNIVERSITY.fixedQuestionTitles || [],
    categories: CONFIG_UNIVERSITY.categories || [],
    sheetNames: [
      CONFIG_UNIVERSITY.logSheetName,
      "sessions",
      "question_sets",
      "responses",
    ],
    formId: PropertiesService.getScriptProperties().getProperty(
      "FORM_ID_UNIVERSITY"
    ),
  };
}

/***************
 * Survey / Admin Data API
 ***************/
function getUniversitySurveyData(sessionId, phase, respondentKey) {
  try {
    const normalizedPhase = normalizeUniversityPhase_(phase);
    const normalizedRespondentKey = normalizeUniversityRespondentKey_(respondentKey);
    const configError = getUniversityConfigError_();
    if (configError) {
      return {
        ok: false,
        error: configError,
        debug: buildUniversityRuntimeDebug_({
          sessionId,
          phase: normalizedPhase,
          respondentKey: normalizedRespondentKey,
        }),
      };
    }

    ensureUniversityStorage_();
    if (!sessionId) {
      return {
        ok: false,
        error: "sessionId が必要です",
        debug: buildUniversityRuntimeDebug_({
          sessionId,
          phase: normalizedPhase,
          respondentKey: normalizedRespondentKey,
        }),
      };
    }

    if (!normalizedRespondentKey) {
      return {
        ok: false,
        error: "respondentKey が必要です",
        debug: buildUniversityRuntimeDebug_({
          sessionId,
          phase: normalizedPhase,
        }),
      };
    }

    const session = findUniversitySession_(sessionId);
    if (!session) {
      return {
        ok: false,
        error: "session が見つかりません",
        debug: {
          ...buildUniversityRuntimeDebug_({
            sessionId,
            phase: normalizedPhase,
            respondentKey: normalizedRespondentKey,
          }),
          knownSessions: listUniversitySessions_().map((item) => item.session_id),
        },
      };
    }

    const questionSet = getOrCreateUniversityQuestionSetForRespondent_(
      sessionId,
      normalizedPhase,
      normalizedRespondentKey
    );
    if (!questionSet) {
      return {
        ok: false,
        error: "質問セットを生成できませんでした",
        debug: {
          ...buildUniversityRuntimeDebug_({
            sessionId,
            phase: normalizedPhase,
            respondentKey: normalizedRespondentKey,
          }),
          session,
        },
      };
    }

    return {
      ok: true,
      session,
      phase: normalizedPhase,
      respondentKey: normalizedRespondentKey,
      phaseLabel: normalizedPhase === "post" ? "授業後" : "授業前",
      questionSet,
      questions: questionSet.questions || [],
      debug: {
        ...buildUniversityRuntimeDebug_({
          sessionId,
          phase: normalizedPhase,
          respondentKey: normalizedRespondentKey,
        }),
        questionSetId: questionSet.setId,
        questionCount: (questionSet.questions || []).length,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      debug: {
        ...buildUniversityRuntimeDebug_({ sessionId, phase, respondentKey }),
        stack: err && err.stack ? err.stack : "",
      },
    };
  }
}

function createUniversitySession(payload) {
  ensureUniversityStorage_();

  const title = String((payload && payload.title) || "").trim();
  const eventDate = String((payload && payload.eventDate) || "").trim();
  const note = String((payload && payload.note) || "").trim();

  if (!title) {
    return { ok: false, error: "授業名を入力してください" };
  }
  if (!eventDate) {
    return { ok: false, error: "実施日を入力してください" };
  }

  const sessionId = buildUniversitySessionId_();
  const preQuestionSet = createUniversityQuestionSet_(sessionId, "pre");
  const postQuestionSet = createUniversityQuestionSet_(sessionId, "post");
  const baseUrl = getUniversityAppUrl_();
  const preUrl = buildUniversitySurveyUrl_(baseUrl, sessionId, "pre");
  const postUrl = buildUniversitySurveyUrl_(baseUrl, sessionId, "post");

  const sessionsSheet = getUniversitySheet_("sessions");
  sessionsSheet.appendRow([
    new Date(),
    sessionId,
    title,
    eventDate,
    note,
    preQuestionSet.setId,
    postQuestionSet.setId,
    preUrl,
    postUrl,
  ]);

  return {
    ok: true,
    session: {
      session_id: sessionId,
      title,
      event_date: eventDate,
      note,
      pre_question_set_id: preQuestionSet.setId,
      post_question_set_id: postQuestionSet.setId,
      pre_url: preUrl,
      post_url: postUrl,
    },
  };
}

function getUniversityDashboardData(selectedSessionId) {
  try {
    const configError = getUniversityConfigError_();
    if (configError) {
      return { ok: false, error: configError, debug: buildUniversityRuntimeDebug_() };
    }

    ensureUniversityStorage_();
    const sessions = listUniversitySessions_();
    const pickedSessionId =
      selectedSessionId || (sessions[0] && sessions[0].session_id) || "";

    return {
      ok: true,
      sessions,
      selectedSessionId: pickedSessionId,
      selected: pickedSessionId ? getUniversitySessionDetail_(pickedSessionId) : null,
      trend: buildUniversityTrendRows_(sessions),
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      debug: {
        ...buildUniversityRuntimeDebug_(),
        stack: err && err.stack ? err.stack : "",
      },
    };
  }
}

function submitUniversitySurveyResponse(payload) {
  try {
    const configError = getUniversityConfigError_();
    if (configError) return { ok: false, error: configError, debug: buildUniversityRuntimeDebug_() };

    ensureUniversityStorage_();

    const sessionId = String((payload && payload.sessionId) || "").trim();
    const phase = normalizeUniversityPhase_(payload && payload.phase);
    const respondentKey = normalizeUniversityRespondentKey_(
      payload && payload.respondentKey
    );
    const name = String((payload && payload.name) || "").trim();
    const studentId = String((payload && payload.studentId) || "").trim();
    const answers = Array.isArray(payload && payload.answers) ? payload.answers : [];
    const questionSetId = String((payload && payload.questionSetId) || "").trim();

    if (!sessionId) return { ok: false, error: "sessionId が必要です" };
    if (!respondentKey) return { ok: false, error: "respondentKey が必要です" };
    if (!studentId)
      return { ok: false, error: "学生IDが必要です" };
    if (answers.length !== 4) return { ok: false, error: "回答は4項目必要です" };

    const session = findUniversitySession_(sessionId);
    if (!session) return { ok: false, error: "session が見つかりません" };

    const questionSet =
      findUniversityQuestionSet_(questionSetId) ||
      findUniversityQuestionSetForRespondent_(sessionId, phase, respondentKey);
    if (!questionSet) return { ok: false, error: "質問セットが見つかりません" };

    const normalizedAnswers = answers.map((value) => Number(value) || "");
    if (normalizedAnswers.some((v) => v === "")) {
      return { ok: false, error: "回答に未入力があります" };
    }

    const scoreTotal = normalizedAnswers.reduce((sum, value) => sum + Number(value), 0);
    const now = new Date();
    const responseSheet = getUniversitySheet_("responses");
    responseSheet.appendRow([
      now,
      sessionId,
      session.title,
      session.event_date,
      phase,
      name,
      studentId,
      respondentKey,
      questionSet.setId,
      normalizedAnswers[0],
      normalizedAnswers[1],
      normalizedAnswers[2],
      normalizedAnswers[3],
      scoreTotal,
      questionSet.questions[0] ? questionSet.questions[0].text : "",
      questionSet.questions[1] ? questionSet.questions[1].text : "",
      questionSet.questions[2] ? questionSet.questions[2].text : "",
      questionSet.questions[3] ? questionSet.questions[3].text : "",
    ]);

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      debug: {
        ...buildUniversityRuntimeDebug_(),
        stack: err && err.stack ? err.stack : "",
      },
    };
  }
}

/***************
 * University Storage Helpers
 ***************/
function ensureUniversityStorage_() {
  const sessionsSheet = getUniversitySheet_("sessions");
  if (sessionsSheet.getLastRow() === 0) {
    sessionsSheet.appendRow([
      "created_at",
      "session_id",
      "title",
      "event_date",
      "note",
      "pre_question_set_id",
      "post_question_set_id",
      "pre_url",
      "post_url",
    ]);
  }

  const setsSheet = getUniversitySheet_("question_sets");
  if (setsSheet.getLastRow() === 0) {
    setsSheet.appendRow([
      "created_at",
      "set_id",
      "session_id",
      "phase",
      "payload_json",
    ]);
  }

  const responsesSheet = getUniversitySheet_("responses");
  if (responsesSheet.getLastRow() === 0) {
    responsesSheet.appendRow([
      "submitted_at",
      "session_id",
      "session_title",
      "event_date",
      "phase",
      "name",
      "student_id",
      "respondent_key",
      "question_set_id",
      "q1_score",
      "q2_score",
      "q3_score",
      "q4_score",
      "total_score",
      "q1_text",
      "q2_text",
      "q3_text",
      "q4_text",
    ]);
  }
}

function getUniversitySheet_(name) {
  const ss = getUniversitySpreadsheet_();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getUniversitySpreadsheet_() {
  const spreadsheetId = String(CONFIG_UNIVERSITY.spreadsheetId || "").trim();
  if (spreadsheetId && !/^PASTE_/.test(spreadsheetId)) {
    return SpreadsheetApp.openById(spreadsheetId);
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  throw new Error(
    "大学生用の保存先スプレッドシートIDが未設定です。CONFIG_UNIVERSITY.spreadsheetId を設定してください。"
  );
}

function getUniversityConfigError_() {
  const spreadsheetId = String(CONFIG_UNIVERSITY.spreadsheetId || "").trim();
  const questionBankSpreadsheetId = String(
    CONFIG_UNIVERSITY.questionBankSpreadsheetId || ""
  ).trim();
  if (!spreadsheetId || /^PASTE_/.test(spreadsheetId)) {
    return "CONFIG_UNIVERSITY.spreadsheetId が未設定です";
  }
  if (!questionBankSpreadsheetId || /^PASTE_/.test(questionBankSpreadsheetId)) {
    return "CONFIG_UNIVERSITY.questionBankSpreadsheetId が未設定です";
  }
  return "";
}

function buildUniversityRuntimeDebug_(extra) {
  return {
    version: "2026-06-30-01",
    appUrl: getUniversityAppUrl_(),
    spreadsheetId: String(CONFIG_UNIVERSITY.spreadsheetId || "").trim(),
    questionBankSpreadsheetId: String(
      CONFIG_UNIVERSITY.questionBankSpreadsheetId || ""
    ).trim(),
    formId: PropertiesService.getScriptProperties().getProperty("FORM_ID_UNIVERSITY"),
    sessionCount: readUniversitySheetObjects_("sessions").length,
    questionSetCount: readUniversitySheetObjects_("question_sets").length,
    responseCount: readUniversitySheetObjects_("responses").length,
    ...(extra || {}),
  };
}

function buildUniversitySessionId_() {
  return "S-" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss") + "-" + Utilities.getUuid().slice(0, 8);
}

function buildUniversityQuestionSetId_() {
  return "QS-" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss") + "-" + Utilities.getUuid().slice(0, 8);
}

function createUniversityQuestionSet_(sessionId, phase) {
  const questions = pickDailyQuestionsUniversity_();
  const setId = buildUniversityQuestionSetId_();
  const sheet = getUniversitySheet_("question_sets");
  sheet.appendRow([
    new Date(),
    setId,
    sessionId,
    phase,
    JSON.stringify({ sessionId, phase, questions }),
  ]);
  return { setId, questions };
}

function findUniversitySession_(sessionId) {
  const rows = readUniversitySheetObjects_("sessions");
  return rows.find((row) => row.session_id === sessionId) || null;
}

function findUniversityQuestionSet_(setId) {
  const rows = readUniversitySheetObjects_("question_sets");
  const row = rows.find((item) => item.set_id === setId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json || "{}");
    return {
      setId: row.set_id,
      sessionId: row.session_id,
      phase: row.phase,
      respondentKey: parsed.respondentKey || "",
      questions: parsed.questions || [],
    };
  } catch (err) {
    return null;
  }
}

function findUniversityQuestionSetForRespondent_(sessionId, phase, respondentKey) {
  const rows = readUniversitySheetObjects_("question_sets");
  const normalizedPhase = normalizeUniversityPhase_(phase);
  const normalizedRespondentKey = normalizeUniversityRespondentKey_(respondentKey);
  const row = rows.find((item) => {
    if (String(item.session_id) !== String(sessionId)) return false;
    if (normalizeUniversityPhase_(item.phase) !== normalizedPhase) return false;
    try {
      const parsed = JSON.parse(item.payload_json || "{}");
      return (
        normalizeUniversityRespondentKey_(parsed.respondentKey) === normalizedRespondentKey
      );
    } catch (err) {
      return false;
    }
  });
  if (!row) return null;
  return findUniversityQuestionSet_(row.set_id);
}

function getOrCreateUniversityQuestionSetForRespondent_(sessionId, phase, respondentKey) {
  return withUniversityScriptLock_(function () {
    const existing = findUniversityQuestionSetForRespondent_(
      sessionId,
      phase,
      respondentKey
    );
    if (existing) return existing;

    const questions = pickUniqueQuestionsForRespondent_(respondentKey);
    const setId = buildUniversityQuestionSetId_();
    const normalizedRespondentKey = normalizeUniversityRespondentKey_(
      respondentKey
    );
    const sheet = getUniversitySheet_("question_sets");
    sheet.appendRow([
      new Date(),
      setId,
      sessionId,
      phase,
      JSON.stringify({
        sessionId,
        phase,
        respondentKey: normalizedRespondentKey,
        questions,
      }),
    ]);
    return {
      setId,
      sessionId,
      phase,
      respondentKey: normalizedRespondentKey,
      questions,
    };
  });
}

function pickUniqueQuestionsForRespondent_(respondentKey) {
  const normalizedRespondentKey = normalizeUniversityRespondentKey_(respondentKey);
  const usedQuestions = new Set(
    getUniversityUsedQuestionTextsForRespondent_(normalizedRespondentKey)
  );
  const data = getUniversityQuestionBankRows_();

  const selected = [];
  const chosenTexts = new Set();
  CONFIG_UNIVERSITY.categories.forEach((cat) => {
    const candidates = data.filter((r) => {
      const category = r[1];
      const text = String(r[3] || "");
      if (category !== cat) return false;
      if (CONFIG_UNIVERSITY.useStarOnly && text.indexOf("★") === -1) return false;
      if (usedQuestions.has(text)) return false;
      if (chosenTexts.has(text)) return false;
      return true;
    });

    if (candidates.length === 0) {
      throw new Error(
        `回答者 ${normalizedRespondentKey} に対してカテゴリ「${cat}」の未使用問題が足りません`
      );
    }

    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    const text = String(picked[3] || "");
    selected.push({
      category: picked[1],
      text,
      rowNumber: picked[0],
    });
    chosenTexts.add(text);
  });

  return selected;
}

function getUniversityUsedQuestionTextsForRespondent_(respondentKey) {
  const normalizedRespondentKey = normalizeUniversityRespondentKey_(respondentKey);
  if (!normalizedRespondentKey) return [];
  const rows = readUniversitySheetObjects_("responses").filter(
    (row) => normalizeUniversityRespondentKey_(row.respondent_key) === normalizedRespondentKey
  );
  const used = [];
  rows.forEach((row) => {
    [row.q1_text, row.q2_text, row.q3_text, row.q4_text].forEach((text) => {
      if (text) used.push(String(text));
    });
  });
  return used;
}

function getUniversityQuestionBankRows_() {
  const cache = CacheService.getScriptCache();
  const cacheKey =
    "university_question_bank_rows_" +
    normalizeUniversityHeader_(CONFIG_UNIVERSITY.questionBankSpreadsheetId) +
    "_" +
    normalizeUniversityHeader_(CONFIG_UNIVERSITY.questionBankSheetName);
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (err) {
      // Cache miss fallthrough.
    }
  }

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

  const data = sheet
    .getRange(3, 1, lastRow - 2, sheet.getLastColumn())
    .getValues();
  cache.put(cacheKey, JSON.stringify(data), 600);
  return data;
}

function listUniversitySessions_() {
  const rows = readUniversitySheetObjects_("sessions");
  return rows
    .map((row) => {
      const detail = getUniversitySessionDetail_(row.session_id);
      return {
        session_id: row.session_id,
        title: row.title,
        event_date: row.event_date,
        note: row.note,
        pre_url: row.pre_url,
        post_url: row.post_url,
        pre_question_set_id: row.pre_question_set_id,
        post_question_set_id: row.post_question_set_id,
        counts: detail.counts,
        averages: detail.averages,
      };
    })
    .sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
}

function getUniversitySessionDetail_(sessionId) {
  const rows = readUniversitySheetObjects_("responses").filter(
    (row) => row.session_id === sessionId
  );

  const byPhase = {
    pre: { count: 0, scoreSum: 0, categorySums: [0, 0, 0, 0] },
    post: { count: 0, scoreSum: 0, categorySums: [0, 0, 0, 0] },
  };
  const byPerson = {};

  rows.forEach((row) => {
    const phase = normalizeUniversityPhase_(row.phase);
    const scores = [
      Number(row.q1_score) || 0,
      Number(row.q2_score) || 0,
      Number(row.q3_score) || 0,
      Number(row.q4_score) || 0,
    ];
    const total = Number(row.total_score) || scores.reduce((a, b) => a + b, 0);
    const target = byPhase[phase];
    target.count += 1;
    target.scoreSum += total;
    scores.forEach((value, index) => {
      target.categorySums[index] += value;
    });

    const key = row.respondent_key;
    byPerson[key] = byPerson[key] || {};
    byPerson[key][phase] = {
      submitted_at: row.submitted_at,
      name: row.name,
      student_id: row.student_id,
      scores,
      total,
    };
  });

  const averages = {
    pre: calcUniversityAverages_(byPhase.pre),
    post: calcUniversityAverages_(byPhase.post),
  };

  const comparisons = Object.keys(byPerson)
    .map((key) => {
      const pre = byPerson[key].pre || null;
      const post = byPerson[key].post || null;
      if (!pre && !post) return null;

      const preTotal = pre ? pre.total : null;
      const postTotal = post ? post.total : null;
      return {
        respondent_key: key,
        name: (post && post.name) || (pre && pre.name) || "",
        student_id: (post && post.student_id) || (pre && pre.student_id) || "",
        pre_total: preTotal,
        post_total: postTotal,
        delta_total:
          preTotal !== null && postTotal !== null ? postTotal - preTotal : null,
        pre_scores: pre ? pre.scores : null,
        post_scores: post ? post.scores : null,
        delta_scores:
          pre && post ? post.scores.map((v, i) => v - pre.scores[i]) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));

  return {
    session_id: sessionId,
    counts: {
      pre: byPhase.pre.count,
      post: byPhase.post.count,
    },
    averages,
    comparisons,
  };
}

function buildUniversityTrendRows_(sessions) {
  return sessions.map((session) => {
    const detail = getUniversitySessionDetail_(session.session_id);
    return {
      session_id: session.session_id,
      title: session.title,
      event_date: session.event_date,
      pre_avg: detail.averages.pre.total,
      post_avg: detail.averages.post.total,
      delta:
        detail.averages.pre.total !== null && detail.averages.post.total !== null
          ? detail.averages.post.total - detail.averages.pre.total
          : null,
    };
  });
}

function calcUniversityAverages_(bucket) {
  if (!bucket.count) {
    return { total: null, categories: [null, null, null, null] };
  }
  return {
    total: roundUniversity_(bucket.scoreSum / bucket.count),
    categories: bucket.categorySums.map((sum) => roundUniversity_(sum / bucket.count)),
  };
}

function roundUniversity_(value) {
  return Math.round(value * 10) / 10;
}

function readUniversitySheetObjects_(sheetName) {
  const sheet = getUniversitySheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const headers = values[0].map((h) => String(h));
  return values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[normalizeUniversityHeader_(header)] = normalizeUniversityValue_(row[index]);
    });
    return obj;
  });
}

function normalizeUniversityValue_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd'T'HH:mm:ss"
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeUniversityValue_(item));
  }
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value).forEach((key) => {
      out[key] = normalizeUniversityValue_(value[key]);
    });
    return out;
  }
  return value;
}

function normalizeUniversityHeader_(header) {
  return String(header)
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
}

function normalizeUniversityPhase_(phase) {
  return String(phase || "pre").toLowerCase() === "post" ? "post" : "pre";
}

function getUniversityRespondentKey_(name, studentId) {
  return normalizeUniversityStudentId_(studentId);
}

function getUniversitySubmittedName_(namedValues) {
  const keys = ["名前", "おなまえ", "name"];
  for (const key of keys) {
    const value = (namedValues && namedValues[key] ? namedValues[key] : [""])[0];
    const trimmed = String(value || "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizeUniversityRespondentKey_(value) {
  return normalizeUniversityStudentId_(value);
}

function normalizeUniversityStudentId_(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function buildUniversitySurveyUrl_(baseUrl, sessionId, phase) {
  const query = [
    "page=survey",
    "session=" + encodeURIComponent(sessionId),
    "phase=" + encodeURIComponent(phase),
  ].join("&");
  if (!baseUrl) {
    return "?" + query;
  }
  return baseUrl + (baseUrl.indexOf("?") >= 0 ? "&" : "?") + query;
}

function debugUniversityEcho() {
  return {
    ok: true,
    version: "2026-06-30-01",
    debug: buildUniversityRuntimeDebug_(),
  };
}

function withUniversityScriptLock_(callback, timeoutMs) {
  const lock = LockService.getScriptLock();
  const waitMs = typeof timeoutMs === "number" ? timeoutMs : 20000;
  lock.waitLock(waitMs);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}
