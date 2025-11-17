// Code.gs - Reservation System Backend (Apps Script)

// CONFIG: 必要に応じて書き換え
const CONFIG = {
  CALENDAR_ID:
    "a4ed87307ab06b345c403972316685e56ec1dc6f5e90e87bf871315c7cc8f441@group.calendar.google.com",
  SHEET_ID: "1BTvhL9WKzcjnzALnnwZD92T9uzhzlnyDmOpllHK3DBA",
  TIMEZONE: "Asia/Tokyo",
  // 日本の祝日カレンダー（必要に応じて変更可）
  HOLIDAY_CALENDAR_ID: "ja.japanese#holiday@group.v.calendar.google.com",
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

  const results = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0); // month の最終日

  // 1日分のイベント/祝日をキャッシュするマップ
  const dayEventCache = {};
  const holidayCache = {};

  for (
    let d = new Date(firstDay);
    d.getTime() <= lastDay.getTime();
    d.setDate(d.getDate() + 1)
  ) {
    const dateKey = formatDate_(d);

    // 祝日判定（キャッシュ付き）
    const isHol = isHolidayCached_(holidayCal, d, holidayCache);

    // 「営業日」かどうか判定（土日 or 祝日を営業日とみなしている）
    if (!isBusinessDay_(d, isHol)) continue;

    // その日のイベント一覧（キャッシュ付き）
    const eventsForDay = getEventsForDayCached_(cal, d, dayEventCache);

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
メール: ${data.email}`,
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
        new Date(),
        s.start,
        s.end,
        data.name,
        data.email,
        data.agree,
      ]);
    });
  }

  return { ok: true };
}

// ===== Utilities =====

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
