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

  KEY_CODE: PROPS.getProperty("KEY_CODE"), // 固定コード（内部用）
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

  // 🔑 トークン & 固定コード生成
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
内部コード: ${keyCode}
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
        keyCode, // 内部コード
        "", // line_user_id（LINEユーザーID）
        purpose, // 利用目的
        peopleCount, // 利用人数
        "", // link_status
        "", // link_updated_at
        "", // key_sent_at（案内送信日時）
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

  // 今回使うのは message イベント（ユーザーが token または確認の「はい」を送ってくる）
  if (
    event.type === "message" &&
    event.message &&
    event.message.type === "text"
  ) {
    const text = (event.message.text || "").trim();
    if (!text) return;

    // 「はい」での確認
    if (text === "はい") {
      confirmLinkForUser_(userId);
      return;
    }

    // text から token を抽出する
    // 例: "token=R-20251117-XXXXXX" または "R-20251117-XXXXXX" だけでもOK
    let token = null;
    const m = text.match(/token\s*[:=]\s*(R-\d{8}-[A-Za-z0-9]+)/i);
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
    }
  }
}

// token と userId をスプレッドシートで紐づけて、予約内容を確認（鍵番号はまだ送らない）
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
    // row = [timestamp, start, end, name, email, agree, token, keyCode, line_user_id, purpose, people_count, link_status, link_updated_at, key_sent_at]
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

  // すでに別のLINEユーザーと紐づいていないか確認
  const linkedToOther = rowsForToken.some((info) => {
    const row = info.row;
    const rowUserId = row[8];
    return rowUserId && rowUserId !== userId;
  });
  if (linkedToOther) {
    sendLineMessage_(
      userId,
      "この予約番号は、すでに別のLINEアカウントと紐づけられています。\n" +
        "心当たりがない場合は、公式LINEまたは運営までお問い合わせください。"
    );
    return;
  }

  const alreadyConfirmedForThisUser = rowsForToken.some((info) => {
    const row = info.row;
    const rowUserId = row[8];
    const linkStatus = row[11];
    return rowUserId === userId && linkStatus === "confirmed";
  });

  if (!alreadyConfirmedForThisUser) {
    // まだこのユーザーと確定紐づけされていない場合は pending として紐づけ
    const now = new Date();
    rowsForToken.forEach((info) => {
      sheet.getRange(info.index, 9).setValue(userId); // 9列目: line_user_id
      sheet.getRange(info.index, 12).setValue("pending"); // 12列目: link_status
      sheet.getRange(info.index, 13).setValue(now); // 13列目: link_updated_at
    });
  }

  // メッセージ用に、代表1行から情報を取得
  const firstRow = rowsForToken[0].row;
  const name = firstRow[3];
  const purpose = firstRow[9];
  const peopleCount = firstRow[10];
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

  const header =
    "【予約内容】\n" +
    `日付：${dateStr}\n` +
    `時間：${startStr} - ${endStr}\n` +
    (name ? `お名前：${name}\n` : "") +
    (peopleCount ? `利用人数：${peopleCount}人\n` : "") +
    (purpose ? `利用目的：${purpose}\n` : "") +
    "\n" +
    "※ご利用日の2週間前以降のキャンセルはできません（キャンセル料100%）。";

  let message;
  if (alreadyConfirmedForThisUser) {
    // すでにこのユーザーと紐づいている場合は案内のみ再送
    message =
      "この予約番号は、あなたのLINEアカウントがご予約者様と認識しております。\n\n" +
      header +
      "\n\n" +
      "ご利用日前日10時に、このトークに当日のご案内をお送りします。";
  } else {
    // 初回または pending 状態の場合は確認メッセージを送る
    message =
      "ご予約ありがとうございます！\n\n" +
      header +
      "\n\n" +
      "この予約されたのは、こちらのLINEアカウント本人で間違いないでしょうか？\n" +
      "内容に問題がなければ、「はい」と返信してください。\n" +
      "（※ご利用日前日10時に、このトークに当日のご案内をお送りします）";
  }

  sendLineMessage_(userId, message);
}

// userId に対して pending の予約リンクを confirmed に更新
function confirmLinkForUser_(userId) {
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

  const now = new Date();
  let hasPending = false;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    // row = [timestamp, start, end, name, email, agree, token, keyCode, line_user_id, purpose, people_count, link_status, link_updated_at, key_sent_at]
    const rowUserId = row[8];
    const linkStatus = row[11];
    if (!rowUserId || rowUserId !== userId) continue;
    if (linkStatus !== "pending") continue;

    hasPending = true;
    sheet.getRange(i + 1, 12).setValue("confirmed"); // link_status
    sheet.getRange(i + 1, 13).setValue(now); // link_updated_at
  }

  if (!hasPending) {
    sendLineMessage_(
      userId,
      "紐づけ待ちの予約が見つかりませんでした。\n" +
        "予約完了画面のボタンから、もう一度予約番号を送信してください。"
    );
    return;
  }

  sendLineMessage_(
    userId,
    "ご予約ありがとうございます。\n\n" +
      "このLINEに当日のご案内をお送りします。\n" +
      "※ご利用日前日10時ごろにお送りする予定です。"
  );
}

// 予約日の前日の朝10時に当日のご案内を送信する想定の処理
// （時間主導型トリガーで毎日10:00ごろに実行する）
function sendKeysForTomorrow() {
  if (!CONFIG.SHEET_ID) {
    Logger.log("SHEET_ID が設定されていません。");
    return;
  }

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName("log") || ss.insertSheet("log");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  const now = new Date();
  const tomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  );
  const tomorrowYmd = Utilities.formatDate(
    tomorrow,
    CONFIG.TIMEZONE,
    "yyyyMMdd"
  );

  // token ごとにまとめて1通だけ送る
  const groupsByToken = {};

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    // row = [timestamp, start, end, name, email, agree, token, keyCode, line_user_id, purpose, people_count, link_status, link_updated_at, key_sent_at]
    const start = row[1];
    const name = row[3];
    const token = row[6];
    const keyCodeFromRow = row[7] || CONFIG.KEY_CODE;
    const userId = row[8];
    const purpose = row[9];
    const peopleCount = row[10];
    const linkStatus = row[11];
    const keySentAt = row[13];

    if (!userId) continue;
    if (!(start instanceof Date)) continue;
    if (linkStatus && linkStatus !== "confirmed") continue; // pending のままなどは送らない
    if (keySentAt) continue; // すでに送信済み

    const startYmd = Utilities.formatDate(start, CONFIG.TIMEZONE, "yyyyMMdd");
    if (startYmd !== tomorrowYmd) continue; // 明日以外の予約は対象外

    if (!groupsByToken[token]) {
      groupsByToken[token] = {
        rows: [],
        userId,
        name,
        purpose,
        peopleCount,
        keyCode: keyCodeFromRow,
      };
    }
    groupsByToken[token].rows.push({ index: i + 1, row: row });
  }

  Object.keys(groupsByToken).forEach((token) => {
    const group = groupsByToken[token];
    const rows = group.rows;
    if (!rows.length) return;

    const userId = group.userId;
    const name = group.name;
    const purpose = group.purpose;
    const peopleCount = group.peopleCount;
    const keyCode = group.keyCode;

    // 最小開始・最大終了を計算
    const startTimes = rows.map((info) => new Date(info.row[1]));
    const endTimes = rows.map((info) => new Date(info.row[2]));

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
      "明日のご利用ありがとうございます。\n\n" +
      "【予約内容】\n" +
      `日付：${dateStr}\n` +
      `時間：${startStr} - ${endStr}\n` +
      (name ? `お名前：${name}\n` : "") +
      (peopleCount ? `利用人数：${peopleCount}人\n` : "") +
      (purpose ? `利用目的：${purpose}\n` : "") +
      "\n" +
      "【当日のご案内】\n" +
      "・ご利用内容の確認と入退室の流れについて、事前にこのメッセージを保管しておいてください。\n\n" +
      "※ご利用日の2週間前以降のキャンセルはできません（キャンセル料100%）。\n" +
      "何かございましたら公式LINEにご連絡ください。\n" +
      "ご利用後は、このトークに片付け後の写真を送信してください。";

    sendLineMessage_(userId, message);

    // 鍵送信済みフラグをセット
    rows.forEach((info) => {
      sheet.getRange(info.index, 14).setValue(new Date()); // key_sent_at
    });
  });
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
