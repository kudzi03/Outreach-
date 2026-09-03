'use strict';
/**
 * dates.js — timezone-aware business-day arithmetic.
 *
 * Every scheduling decision in this system is made in ONE configured IANA
 * timezone (CAMPAIGN_TIMEZONE). We never compare raw UTC timestamps, because
 * "3 business days ago" is a calendar question, not a duration question:
 * a lead contacted Friday 23:50 UTC and one contacted Friday 00:10 UTC are
 * both "contacted on Friday" and must both become due on Wednesday.
 */

var DATES_MAX_ITER = 4000; // hard stop so a bad date can never spin forever

/** Format a Date as 'YYYY-MM-DD' as observed in `timeZone`. */
function zonedYMD(date, timeZone) {
  var d = toDate(date);
  if (!d) return null;
  // en-CA renders as YYYY-MM-DD, which is exactly the shape we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/** Hour (0-23) as observed in `timeZone`. */
function zonedHour(date, timeZone) {
  var d = toDate(date);
  if (!d) return null;
  var parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'UTC',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d);
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type === 'hour') return parseInt(parts[i].value, 10);
  }
  return null;
}

/** Coerce ISO string / Date / epoch ms to a valid Date, or null. */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  var d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** 'YYYY-MM-DD' -> Date at UTC midnight (a pure calendar-day handle). */
function ymdToUTC(ymd) {
  if (typeof ymd !== 'string') return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** Date at UTC midnight -> 'YYYY-MM-DD'. */
function utcToYMD(date) {
  return date.toISOString().slice(0, 10);
}

/** Shift a 'YYYY-MM-DD' by n calendar days. */
function shiftYMD(ymd, days) {
  var d = ymdToUTC(ymd);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return utcToYMD(d);
}

/** Normalize a holiday list into a Set of 'YYYY-MM-DD'. */
function holidaySet(holidays) {
  var set = new Set();
  if (!holidays) return set;
  var list = Array.isArray(holidays)
    ? holidays
    : String(holidays).split(',');
  for (var i = 0; i < list.length; i++) {
    var v = String(list[i]).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) set.add(v);
  }
  return set;
}

/** Is this calendar day a business day (Mon-Fri, not a holiday)? */
function isBusinessDayYMD(ymd, holidays) {
  var d = ymdToUTC(ymd);
  if (!d) return false;
  var dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  if (dow === 0 || dow === 6) return false;
  return !holidaySet(holidays).has(ymd);
}

/** Is `date`, as observed in `timeZone`, on a business day? */
function isBusinessDay(date, timeZone, holidays) {
  var ymd = zonedYMD(date, timeZone);
  return ymd ? isBusinessDayYMD(ymd, holidays) : false;
}

/**
 * Signed count of business days strictly after `fromYMD` up to and including
 * `toYMD`. Same day -> 0. Fri -> Mon -> 1. Fri -> Wed -> 3.
 */
function businessDaysBetweenYMD(fromYMD, toYMD, holidays) {
  var from = ymdToUTC(fromYMD);
  var to = ymdToUTC(toYMD);
  if (!from || !to) return null;
  var sign = 1;
  if (to.getTime() < from.getTime()) {
    sign = -1;
    var swap = from; from = to; to = swap;
  }
  var hol = holidaySet(holidays);
  var count = 0;
  var cursor = new Date(from.getTime());
  var guard = 0;
  while (cursor.getTime() < to.getTime() && guard++ < DATES_MAX_ITER) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    var ymd = utcToYMD(cursor);
    var dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6 && !hol.has(ymd)) count++;
  }
  return sign * count;
}

/**
 * Business days elapsed since `fromIso` as of `nowIso`, both interpreted in
 * `timeZone`. This is the value the follow-up gates compare against.
 * Returns null when `fromIso` is missing/unparseable — callers MUST treat
 * null as "not due" rather than "due", so a corrupt date can never trigger
 * an unwanted send.
 */
function businessDaysSince(fromIso, nowIso, timeZone, holidays) {
  var fromYMD = zonedYMD(fromIso, timeZone);
  var nowYMD = zonedYMD(nowIso || new Date(), timeZone);
  if (!fromYMD || !nowYMD) return null;
  return businessDaysBetweenYMD(fromYMD, nowYMD, holidays);
}

/** Add n business days to a date, returning 'YYYY-MM-DD'. */
function addBusinessDays(date, n, timeZone, holidays) {
  var ymd = zonedYMD(date, timeZone);
  if (!ymd) return null;
  var remaining = Math.abs(n);
  var step = n < 0 ? -1 : 1;
  var guard = 0;
  while (remaining > 0 && guard++ < DATES_MAX_ITER) {
    ymd = shiftYMD(ymd, step);
    if (isBusinessDayYMD(ymd, holidays)) remaining--;
  }
  return ymd;
}

/** True when the local hour is inside [startHour, endHour). */
function isWithinSendWindow(date, timeZone, startHour, endHour) {
  var h = zonedHour(date, timeZone);
  if (h === null) return false;
  return h >= startHour && h < endHour;
}

/**
 * Seconds of runway left in today's send window. Used to refuse to start a
 * batch we cannot finish before the window closes.
 */
function secondsLeftInWindow(date, timeZone, endHour) {
  var d = toDate(date);
  if (!d) return 0;
  var h = zonedHour(d, timeZone);
  if (h === null) return 0;
  var minutes = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC', minute: '2-digit'
    }).format(d)
  );
  var elapsed = h * 3600 + minutes * 60;
  var closes = endHour * 3600;
  return Math.max(0, closes - elapsed);
}

/**
 * Deterministic-when-seeded randomized stagger, in seconds.
 * `rng` defaults to Math.random; tests inject a fixed value.
 */
function staggerSeconds(minMinutes, maxMinutes, rng) {
  var lo = Math.max(0, Number(minMinutes) || 0);
  var hi = Math.max(lo, Number(maxMinutes) || lo);
  var r = typeof rng === 'function' ? rng() : Math.random();
  if (!(r >= 0 && r < 1)) r = 0.5;
  return Math.round((lo + (hi - lo) * r) * 60);
}

// ---8<--- exports (stripped by build/build.js when inlining into n8n)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    zonedYMD: zonedYMD,
    zonedHour: zonedHour,
    toDate: toDate,
    ymdToUTC: ymdToUTC,
    utcToYMD: utcToYMD,
    shiftYMD: shiftYMD,
    holidaySet: holidaySet,
    isBusinessDayYMD: isBusinessDayYMD,
    isBusinessDay: isBusinessDay,
    businessDaysBetweenYMD: businessDaysBetweenYMD,
    businessDaysSince: businessDaysSince,
    addBusinessDays: addBusinessDays,
    isWithinSendWindow: isWithinSendWindow,
    secondsLeftInWindow: secondsLeftInWindow,
    staggerSeconds: staggerSeconds
  };
}
