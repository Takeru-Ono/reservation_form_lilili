// Code.gs - Reservation System Backend (Apps Script)

// TODO: スマホ向けにボタン/スロットのタップ領域を広げる
// TODO: 2つ選択時のアラートを削除（ロジック側で制御）
// TODO: セキュリティ対策
// TODO: 写真を受け取った時のフロー（AIで関係ない写真の判別までするべきかどうか→しなくていい気がする）
// TODO: アクセスが集中すると見えないことが多い

// ====== Script Properties 読み込み ======
const PROPS = PropertiesService.getScriptProperties();

const CONFIG = {
  CALENDAR_ID: PROPS.getProperty("CALENDAR_ID"),
  SHEET_ID: PROPS.getProperty("SHEET_ID"),
  TIMEZONE: "Asia/Tokyo",
  HOLIDAY_CALENDAR_ID: "ja.japanese#holiday@group.v.calendar.google.com",

  KEY_CODE: PROPS.getProperty("KEY_CODE"), // 固定鍵番号
  LINE_ACCESS_TOKEN: PROPS.getProperty("LINE_ACCESS_TOKEN"),
  LINE_BASIC_ID: PROPS.getProperty("LINE_BASIC_ID"),
};

// 時間帯パターン（フロントの index.html と同じ構成）
// 1コマ（2時間）3000円
// 2コマ（4時間）5000円
const SLOT_PATTERNS = [
  // 1コマ
  { id: "S_A", startHour: 9, startMinute: 0, endHour: 11, endMinute: 0 },
  { id: "S_B", startHour: 11, startMinute: 0, endHour: 13, endMinute: 0 },
  { id: "S_C", startHour: 13, startMinute: 30, endHour: 15, endMinute: 30 },
  { id: "S_D", startHour: 15, startMinute: 30, endHour: 17, endMinute: 30 },
  // 2コマ
  { id: "D_AB", startHour: 9, startMinute: 0, endHour: 13, endMinute: 0 },
  { id: "D_CD", startHour: 13, startMinute: 30, endHour: 17, endMinute: 30 },
];

function doGet() {
  return HtmlService.createTemplateFromFile("index")
    .evaluate()
    .setTitle("予約ページ");
}

// Utility: load HTML
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// =========================
// 月単位の空き状況（◎/△/×）取得
// =========================
// フロントから year, month(1-12) が渡される想定
// ※ Calendar API の呼び出し回数を減らすため、
//    - その月のイベントを一括取得
//    - その月の祝日を一括取得
//    - 結果を CacheService に数分キャッシュ
function getAvailability(year, month) {
  if (!year || !month) {
    throw new Error("getAvailability: year, month が必要です");
  }

  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!cal) {
    throw new Error(
      "CALENDAR_ID が不正か、アクセス権がありません: " + CONFIG.CALENDAR_ID
    );
  }

  const holidayCal = CONFIG.HOLIDAY_CALENDAR_ID
    ? CalendarApp.getCalendarById(CONFIG.HOLIDAY_CALENDAR_ID)
    : null;

  // --- 月ごとの結果をキャッシュ ---
  const cache = CacheService.getScriptCache();
  const cacheKey = "availability_" + year + "_" + month;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // パース失敗時は再計算
      Logger.log("availability cache parse error: " + e);
    }
  }

  const results = [];
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0); // month の最終日

  // その月のイベントをまとめて取得（終端を 23:59:59 まで広げる）
  const rangeEnd = new Date(lastDay);
  rangeEnd.setHours(23, 59, 59, 999);

  const monthlyEvents = cal.getEvents(firstDay, rangeEnd);
  const eventsByDate = {};
  monthlyEvents.forEach((ev) => {
    const start = ev.getStartTime();
    const key = formatDate_(start);
    if (!eventsByDate[key]) {
      eventsByDate[key] = [];
    }
    eventsByDate[key].push(ev);
  });

  // 祝日も月単位で取得
  const holidayMap = {};
  if (holidayCal) {
    const holidayEvents = holidayCal.getEvents(firstDay, rangeEnd);
    holidayEvents.forEach((ev) => {
      const start = ev.getStartTime();
      const key = formatDate_(start);
      holidayMap[key] = true;
    });
  }

  for (
    let d = new Date(firstDay);
    d.getTime() <= lastDay.getTime();
    d.setDate(d.getDate() + 1)
  ) {
    const dateKey = formatDate_(d);

    const isHol = !!holidayMap[dateKey];

    // 「営業日」かどうか判定（土日 or 祝日を営業日とみなしている）
    if (!isBusinessDay_(d, isHol)) continue;

    // その日のイベント一覧（事前にまとめて取得したものから取り出す）
    const eventsForDay = eventsByDate[dateKey] || [];

    // 1日分の枠のうち空きがいくつあるか
    const { freeCount, totalCount } = countFreeSlotsForDateFromEvents_(
      d,
      eventsForDay
    );

    let status = "×";
    if (totalCount > 0 && freeCount === totalCount) status = "◎";
    else if (freeCount > 0) status = "△";

    results.push({
      date: dateKey,
      status,
      isHoliday: isHol,
    });
  }

  // 計算結果を数分キャッシュ（例: 5分 = 300秒）
  cache.put(cacheKey, JSON.stringify(results), 300);

  return results;
}

// =========================
// 特定日付の空き枠リスト
// =========================
function getSlots(dateStr) {
  if (!dateStr) {
    throw new Error("getSlots: dateStr が渡されていません");
  }
  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!cal) {
    throw new Error(
      "カレンダーIDが不正か、アクセス権がありません: " + CONFIG.CALENDAR_ID
    );
  }

  const d = parseDate_(dateStr);
  // 1日分のイベントを一括取得（ここが高速化のポイント）
  const eventsForDay = cal.getEventsForDay(d);
  const freeSlots = buildFreeSlotsForDateFromEvents_(d, eventsForDay);

  return freeSlots.map((s) => ({
    start: s.start.toISOString(),
    end: s.end.toISOString(),
  }));
}

// =========================
// 予約処理
// =========================
function reserve(data) {
  if (
    !data ||
    !data.name ||
    !data.email ||
    !data.agree ||
    !data.slots ||
    !data.slots.length
  ) {
    throw new Error("入力が不足しています");
  }

  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!cal) {
    throw new Error(
      "カレンダーIDが不正か、アクセス権がありません: " + CONFIG.CALENDAR_ID
    );
  }

  const slots = data.slots.map((s) => ({
    start: new Date(s.start),
    end: new Date(s.end),
  }));

  // 利用目的・利用人数・LINE登録チェック
  const purpose = data.purpose;
  const peopleCount = Number(data.peopleCount);
  const lineRegistered = !!data.lineRegistered;

  if (!purpose) {
    throw new Error("利用目的が入力されていません");
  }
  if (!peopleCount || isNaN(peopleCount) || peopleCount <= 0) {
    throw new Error("利用人数が正しく入力されていません");
  }
  if (!lineRegistered) {
    throw new Error("公式LINEアカウント登録のチェックが必要です");
  }

  // 🔑 トークン & 鍵番号生成
  const token = generateToken_();
  const keyCode = CONFIG.KEY_CODE;

  // 二重予約チェック（ここは件数が少ないので getEvents でOK）
  slots.forEach((s) => {
    if (cal.getEvents(s.start, s.end).length > 0) {
      throw new Error("すでに予約が埋まりました");
    }
  });

  // イベント作成
  slots.forEach((s) => {
    cal.createEvent(`予約: ${data.name}`, s.start, s.end, {
      description: `名前: ${data.name}
メール: ${data.email}
鍵番号: ${keyCode}
トークン: ${token}`,
      guests: data.email, // カンマ区切り文字列で指定
      sendInvites: true,
    });
  });

  // Log (optional)
  if (CONFIG.SHEET_ID) {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const sheet = ss.getSheetByName("log") || ss.insertSheet("log");
    slots.forEach((s) => {
      sheet.appendRow([
        new Date(), // ログ記録時刻
        s.start,
        s.end,
        data.name,
        data.email,
        data.agree,
        token, // 予約トークン
        keyCode, // 鍵番号
        "", // line_user_id（LINEユーザーID）
        purpose, // 利用目的
        peopleCount, // 利用人数
        "", // link_status
        "", // link_updated_at
      ]);
    });
  }

  // フロントにトークンを返す
  return { ok: true, token: token };
}

// ===== Utilities =====

// トークン生成（例: R-20251117-3F9KZ2）
function generateToken_() {
  const now = new Date();
  const ymd = Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyyMMdd");
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return "R-" + ymd + "-" + rand;
}

// 「営業日」判定（このシステムでは「土日 or 祝日」が営業日）
// isHoliday は事前に isHolidayCached_ で判定して渡す
function isBusinessDay_(d, isHoliday) {
  const day = d.getDay();
  // 土日
  if (day === 0 || day === 6) return true;
  // 平日の祝日
  if (isHoliday) return true;
  return false;
}

function formatDate_(d) {
  const y = d.getFullYear();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  const dd = ("0" + d.getDate()).slice(-2);
  return `${y}-${m}-${dd}`;
}

function parseDate_(str) {
  if (!str) {
    throw new Error("parseDate_: 不正な引数です: " + str);
  }
  const parts = str.split("-");
  return new Date(
    Number(parts[0]),
    Number(parts[1]) - 1,
    Number(parts[2]),
    0,
    0,
    0,
    0
  );
}

// 祝日判定（getEventsForDay + キャッシュ）
function isHolidayCached_(holidayCal, d, cache) {
  if (!holidayCal) return false;
  const key = formatDate_(d);
  if (key in cache) return cache[key];

  const events = holidayCal.getEventsForDay(d);
  const isHoliday = events.length > 0;
  cache[key] = isHoliday;
  return isHoliday;
}

// 1日分のイベント取得（getEventsForDay + キャッシュ）
function getEventsForDayCached_(cal, d, cache) {
  const key = formatDate_(d);
  if (key in cache) return cache[key];
  const events = cal.getEventsForDay(d);
  cache[key] = events;
  return events;
}

// パターン定義からその日のスロット時刻を生成
function buildSlotRange_(d, pattern) {
  const start = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    pattern.startHour,
    pattern.startMinute,
    0,
    0
  );
  const end = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    pattern.endHour,
    pattern.endMinute,
    0,
    0
  );
  return { start, end };
}

// イベントとスロットの時間が重なっているかどうかを判定
function hasOverlap_(slotStart, slotEnd, events) {
  for (var i = 0; i < events.length; i++) {
    const ev = events[i];
    const evStart = ev.getStartTime();
    const evEnd = ev.getEndTime();
    // 重ならない条件の否定： (evEnd <= slotStart || evStart >= slotEnd)
    if (!(evEnd <= slotStart || evStart >= slotEnd)) {
      return true;
    }
  }
  return false;
}

// 1日分のイベントから、freeCount / totalCount を算出
function countFreeSlotsForDateFromEvents_(d, eventsForDay) {
  let totalCount = 0;
  let freeCount = 0;

  SLOT_PATTERNS.forEach((pattern) => {
    const { start, end } = buildSlotRange_(d, pattern);
    totalCount += 1;
    if (!hasOverlap_(start, end, eventsForDay)) {
      freeCount += 1;
    }
  });

  return { freeCount, totalCount };
}

// 1日分のイベントから「空きスロット」だけを配列で返す
function buildFreeSlotsForDateFromEvents_(d, eventsForDay) {
  const result = [];

  SLOT_PATTERNS.forEach((pattern) => {
    const { start, end } = buildSlotRange_(d, pattern);
    if (!hasOverlap_(start, end, eventsForDay)) {
      result.push({ start, end });
    }
  });

  return result;
}
// =========================
// LINE Webhook 入口
// =========================
function doPost(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      const json = JSON.parse(e.postData.contents);
      // 受信内容をログに出しておく（デバッグ用）
      Logger.log(JSON.stringify(json, null, 2));
      const events = json.events || [];
      events.forEach(handleLineEvent_);
    } else {
      Logger.log("no postData");
    }

    return ContentService.createTextOutput("OK").setMimeType(
      ContentService.MimeType.TEXT_PLAIN
    );
  } catch (err) {
    Logger.log("ERROR in doPost: " + err);
    return ContentService.createTextOutput("NG").setMimeType(
      ContentService.MimeType.TEXT_PLAIN
    );
  }
}

// 各イベントの処理
function handleLineEvent_(event) {
  if (!event || !event.source || !event.source.userId) {
    return;
  }
  const userId = event.source.userId;

  // 今回使うのは message イベント（ユーザーが token または利用情報を送ってくる）
  if (
    event.type === "message" &&
    event.message &&
    event.message.type === "text"
  ) {
    const text = (event.message.text || "").trim();
    if (!text) return;

    // text から token を抽出する
    // 例: "token=R-20251117-XXXXXX" または "R-20251117-XXXXXX" だけでもOK
    let token = null;
    const m = text.match(/token\s*[:=]\s*([A-Za-z0-9\-]+)/i);
    if (m && m[1]) {
      token = m[1];
    } else {
      // "R-YYYYMMDD-XXXXXX" 形式だけが送られてきた場合
      const m2 = text.match(/R-\d{8}-[A-Za-z0-9]+/);
      if (m2 && m2[0]) {
        token = m2[0];
      }
    }

    if (token) {
      linkTokenAndSendKey_(userId, token);
    } else {
      // token が含まれていない場合は、利用者数・利用目的の登録とみなす
      handleUsageInfo_(userId, text);
    }
  }
}

// 利用者数 / 利用目的 メッセージの処理
function handleUsageInfo_(userId, text) {
  if (!CONFIG.SHEET_ID) {
    sendLineMessage_(
      userId,
      "内部エラー：予約ログ用のシートが設定されていません。"
    );
    return;
  }

  const numMatch = text.match(/利用者数\s*[:：]\s*(\d+)/);
  const purposeMatch = text.match(/利用目的\s*[:：]\s*([\s\S]+)/);

  if (!numMatch || !purposeMatch) {
    sendLineMessage_(
      userId,
      "メッセージの形式を認識できませんでした。\n\n" +
        "次の形式で送信してください。\n\n" +
        "利用者数 : （数字のみ）\n" +
        "利用目的 : （自由記述）"
    );
    return;
  }

  const numUsers = Number(numMatch[1]);
  const purpose = purposeMatch[1].trim();

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName("log") || ss.insertSheet("log");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    sendLineMessage_(userId, "予約情報が見つかりませんでした。");
    return;
  }

  const now = new Date();
  let target = null;

  // userId が一致し、かつこれからの予約の中で一番近いものを探す
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rowUserId = row[8]; // line_user_id
    const start = row[1]; // start
    if (!rowUserId || rowUserId !== userId) continue;
    if (!(start instanceof Date)) continue;
    if (start.getTime() <= now.getTime()) continue;

    // すでに利用者数/目的が入っている場合はスキップ
    if (row[9] || row[10]) continue;

    if (!target || start.getTime() < target.start.getTime()) {
      target = { index: i + 1, row: row, start: start };
    }
  }

  if (!target) {
    sendLineMessage_(
      userId,
      "これからの予約で、まだ利用者数・利用目的が登録されているものが見つかりませんでした。"
    );
    return;
  }

  // シートに反映
  sheet.getRange(target.index, 10).setValue(numUsers); // 利用者数
  sheet.getRange(target.index, 11).setValue(purpose); // 利用目的

  const dateStr = Utilities.formatDate(
    target.start,
    CONFIG.TIMEZONE,
    "yyyy/MM/dd（E）"
  );
  const startStr = Utilities.formatDate(target.start, CONFIG.TIMEZONE, "HH:mm");

  sendLineMessage_(
    userId,
    "以下の予約に、利用者数と利用目的を登録しました。\n\n" +
      `日付：${dateStr}\n` +
      `開始時間：${startStr}\n` +
      `利用者数：${numUsers}人\n` +
      `利用目的：${purpose}\n\n` +
      "ご利用開始の24時間前に暗証番号をお送りします。"
  );
}

// token と userId をスプレッドシートで紐づけて、鍵番号を送信
function linkTokenAndSendKey_(userId, token) {
  if (!token) {
    sendLineMessage_(
      userId,
      "予約トークンが読み取れませんでした。もう一度お試しください。"
    );
    return;
  }

  if (!CONFIG.SHEET_ID) {
    sendLineMessage_(
      userId,
      "内部エラー：予約ログ用のシートが設定されていません。"
    );
    return;
  }

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName("log") || ss.insertSheet("log");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    sendLineMessage_(userId, "予約情報が見つかりませんでした。");
    return;
  }

  // 1行目はヘッダ想定の場合があるので、2行目から検索
  const rowsForToken = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    // row = [timestamp, start, end, name, email, agree, token, keyCode, line_user_id, num_users, purpose, key_sent_at, reminder_sent_at]
    const rowToken = row[6];
    if (rowToken === token) {
      rowsForToken.push({ index: i + 1, row: row }); // index は 1-based
    }
  }

  if (rowsForToken.length === 0) {
    sendLineMessage_(
      userId,
      "ご入力いただいたトークンに一致する予約が見つかりませんでした。"
    );
    return;
  }

  // 該当する全行に userId をセット
  rowsForToken.forEach((info) => {
    sheet.getRange(info.index, 9).setValue(userId); // 9列目: line_user_id
  });

  // メッセージ用に、代表1行から情報を取得
  const firstRow = rowsForToken[0].row;
  const name = firstRow[3];
  const startTimes = rowsForToken.map((info) => new Date(info.row[1]));
  const endTimes = rowsForToken.map((info) => new Date(info.row[2]));

  // まとめて表示用に最小開始・最大終了を計算
  let minStart = startTimes[0];
  let maxEnd = endTimes[0];
  startTimes.forEach((d) => {
    if (d < minStart) minStart = d;
  });
  endTimes.forEach((d) => {
    if (d > maxEnd) maxEnd = d;
  });

  const dateStr = Utilities.formatDate(
    minStart,
    CONFIG.TIMEZONE,
    "yyyy/MM/dd（E）"
  );
  const startStr = Utilities.formatDate(minStart, CONFIG.TIMEZONE, "HH:mm");
  const endStr = Utilities.formatDate(maxEnd, CONFIG.TIMEZONE, "HH:mm");

  const message =
    "ご予約ありがとうございます！\n\n" +
    "【予約内容】\n" +
    `日付：${dateStr}\n` +
    `時間：${startStr} - ${endStr}\n` +
    (name ? `お名前：${name}\n` : "") +
    "\n" +
    "【ご利用前のお願い】\n" +
    "この予約番号に対応するご利用内容を、次のフォーマットに沿ってこのトークに送ってください。\n\n" +
    "利用者数 : \n" +
    "利用目的 : \n\n" +
    "※ご利用開始の24時間前までに上記のフォーマットで送信してください。\n" +
    "　内容を確認後、ご利用開始の24時間前に暗証番号をお送りします。\n" +
    "\n" +
    "ご利用後は、このトークに片付け後の写真を送信してください。";

  sendLineMessage_(userId, message);
}

// 24時間以内に利用開始となる予約に暗証番号を送信する
// 時間主導型トリガー（例: 1時間ごと）から呼び出す想定
function sendKeysForUpcomingReservations() {
  if (!CONFIG.SHEET_ID) {
    Logger.log("SHEET_ID が設定されていません。");
    return;
  }

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName("log") || ss.insertSheet("log");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  const now = new Date();
  const oneDayMs = 24 * 60 * 60 * 1000;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    // row = [timestamp, start, end, name, email, agree, token, keyCode, line_user_id, num_users, purpose, key_sent_at, reminder_sent_at]
    const start = row[1];
    const name = row[3];
    const userId = row[8];
    const numUsers = row[9];
    const purpose = row[10];
    const keySentAt = row[11];

    if (!userId) continue;
    if (!(start instanceof Date)) continue;
    if (!numUsers || !purpose) continue;
    if (keySentAt) continue; // すでに送信済み

    const diff = start.getTime() - now.getTime();
    if (diff <= 0) continue; // すでに開始時刻を過ぎている
    if (diff > oneDayMs) continue; // 24時間より先の予約

    const keyCodeFromRow = row[7] || CONFIG.KEY_CODE;

    const dateStr = Utilities.formatDate(
      start,
      CONFIG.TIMEZONE,
      "yyyy/MM/dd（E）"
    );
    const startStr = Utilities.formatDate(start, CONFIG.TIMEZONE, "HH:mm");

    const message =
      "ご利用開始まで24時間を切りましたので、暗証番号をお送りします。\n\n" +
      "【予約内容】\n" +
      `日付：${dateStr}\n` +
      `時間：${startStr} - （2時間または4時間）\n` +
      (name ? `お名前：${name}\n` : "") +
      `利用者数：${numUsers}人\n` +
      `利用目的：${purpose}\n\n` +
      "【暗証番号】\n" +
      `${keyCodeFromRow}\n\n` +
      "ご利用後は、このトークに片付け後の写真を送信してください。";

    sendLineMessage_(userId, message);

    // 鍵送信済みフラグをセット
    sheet.getRange(i + 1, 12).setValue(new Date());
  }
}

// 利用者数・利用目的が未登録の予約に対して、開始約25時間前にリマインドを送信する
// 時間主導型トリガー（例: 1時間ごと）から呼び出す想定
function sendUsageInfoReminders() {
  if (!CONFIG.SHEET_ID) {
    Logger.log("SHEET_ID が設定されていません。");
    return;
  }

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName("log") || ss.insertSheet("log");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  const now = new Date();
  const oneHourMs = 60 * 60 * 1000;
  const twentyFourHoursMs = 24 * oneHourMs;
  const twentyFiveHoursMs = 25 * oneHourMs;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    // row = [timestamp, start, end, name, email, agree, token, keyCode, line_user_id, num_users, purpose, key_sent_at, reminder_sent_at]
    const start = row[1];
    const name = row[3];
    const userId = row[8];
    const numUsers = row[9];
    const purpose = row[10];
    const reminderSentAt = row[12];

    if (!userId) continue;
    if (!(start instanceof Date)) continue;
    if (numUsers || purpose) continue; // すでに登録済み
    if (reminderSentAt) continue; // すでにリマインド済み

    const diff = start.getTime() - now.getTime();
    if (diff <= twentyFourHoursMs) continue; // すでに24時間を切っている
    if (diff > twentyFiveHoursMs) continue; // 25時間より先

    const dateStr = Utilities.formatDate(
      start,
      CONFIG.TIMEZONE,
      "yyyy/MM/dd（E）"
    );
    const startStr = Utilities.formatDate(start, CONFIG.TIMEZONE, "HH:mm");

    const message =
      "【ご予約内容のご確認】\n\n" +
      `日付：${dateStr}\n` +
      `開始時間：${startStr}\n` +
      (name ? `お名前：${name}\n` : "") +
      "\n" +
      "ご利用開始の24時間前までに、以下のフォーマットで\n" +
      "「利用者数」と「利用目的」をこのトークにご返信ください。\n\n" +
      "利用者数 : \n" +
      "利用目的 : \n\n" +
      "まだご入力が確認できていません。このまま24時間前までにご連絡がない場合、\n" +
      "予約がキャンセルされる場合があります。";

    sendLineMessage_(userId, message);

    // リマインド送信済みフラグをセット
    sheet.getRange(i + 1, 13).setValue(new Date());
  }
}

// LINE への push メッセージ送信
function sendLineMessage_(userId, text) {
  if (!CONFIG.LINE_ACCESS_TOKEN) {
    Logger.log("LINE_ACCESS_TOKEN が設定されていません。");
    return;
  }
  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to: userId,
    messages: [{ type: "text", text: text }],
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + CONFIG.LINE_ACCESS_TOKEN,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const res = UrlFetchApp.fetch(url, options);
  Logger.log(
    "LINE push response: " + res.getResponseCode() + " " + res.getContentText()
  );
}

function pushTest() {
  const userId = "U68a910db5be118849f479d4a8ed57351";
  const token = CONFIG.LINE_ACCESS_TOKEN; // Messaging API設定で発行したやつ

  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      to: userId,
      messages: [
        { type: "text", text: "学びのかまくらテスト：push 通知成功！" },
      ],
    }),
  });
}
