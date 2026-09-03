'use strict';
/**
 * queue.js — lead normalization, eligibility, prioritization, the 30/day cap,
 * and the stagger schedule.
 *
 * This is the single place where "who gets an email today" is decided, so the
 * daily cap and the safety guarantees are provable by reading one function.
 */

/* global zonedYMD, businessDaysSince, staggerSeconds */
// dates.js is inlined ahead of this file by build/build.js. Under Node (tests)
// the block below wires the same names up via require; the build strips it.
// ---8<--- node-only shim (stripped by build/build.js)
var __qDates = (typeof require === 'function' && typeof module !== 'undefined') ? require('./dates.js') : null;
var zonedYMD = __qDates ? __qDates.zonedYMD : zonedYMD;
var businessDaysSince = __qDates ? __qDates.businessDaysSince : businessDaysSince;
var staggerSeconds = __qDates ? __qDates.staggerSeconds : staggerSeconds;
// ---8<--- end node-only shim

var QUEUE_TERMINAL_STATUSES = ['replied', 'do not contact', 'invalid'];

var QUEUE_TOUCH_BY_STATUS = {
  '': 'email1',
  'new': 'email1',
  'queued': 'email1',
  'sent email 1': 'followup1',
  'sent follow-up 1': 'followup2'
};

/** Status -> the status we write after that touch commits. */
var QUEUE_NEXT_STATUS = {
  email1: 'Sent Email 1',
  followup1: 'Sent Follow-up 1',
  followup2: 'Sent Follow-up 2'
};

/** Business-day gates from the brief. */
var QUEUE_WAIT_BUSINESS_DAYS = {
  email1: 0,
  followup1: 3,
  followup2: 4
};

/** Send order. Follow-ups outrank cold opens: a live thread is worth more. */
var QUEUE_PRIORITY = { followup2: 0, followup1: 1, email1: 2 };

function qTrim(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Flatten one Airtable record into the shape the rest of the code expects. */
function normalizeRecord(record) {
  var f = (record && record.fields) || {};
  return {
    recordId: record && record.id,
    createdTime: record && record.createdTime,
    firstName: qTrim(f['First Name']),
    companyName: qTrim(f['Company Name']),
    email: qTrim(f['Email']).toLowerCase(),
    city: qTrim(f['City']),
    status: qTrim(f['Status']),
    lastContactedDate: qTrim(f['Last Contacted Date']),
    verificationStatus: qTrim(f['Verification Status']),
    messageId: qTrim(f['Message ID']),
    threadSubject: qTrim(f['Thread Subject']),
    idempotencyKey: qTrim(f['Idempotency Key']),
    fit: qTrim(f['Fit']),
    // Keep the raw fields so nothing downstream has to re-fetch.
    _fields: f
  };
}

/** Terminal statuses can never be re-entered. This is Safety Guarantee #1. */
function isTerminal(status) {
  return QUEUE_TERMINAL_STATUSES.indexOf(qTrim(status).toLowerCase()) !== -1;
}

/**
 * Decide what (if anything) this lead is owed right now.
 *
 * @returns {{eligible:boolean, touch:string|null, reason:string, waitedBusinessDays:number|null}}
 */
function evaluateLead(lead, ctx) {
  var c = ctx || {};
  var now = c.now || new Date().toISOString();
  var tz = c.timeZone || 'UTC';
  var holidays = c.holidays;

  var status = qTrim(lead.status);
  var statusKey = status.toLowerCase();

  if (isTerminal(status)) {
    return { eligible: false, touch: null, reason: 'Terminal status "' + status + '".', waitedBusinessDays: null };
  }

  if (statusKey === 'sent follow-up 2') {
    return { eligible: false, touch: null, reason: 'Sequence complete.', waitedBusinessDays: null };
  }

  var touch = QUEUE_TOUCH_BY_STATUS[statusKey];
  if (!touch) {
    return { eligible: false, touch: null, reason: 'Unrecognized status "' + status + '" — left for a human.', waitedBusinessDays: null };
  }

  if (!lead.email) {
    return { eligible: false, touch: touch, reason: 'No email address.', waitedBusinessDays: null };
  }

  // Workflow 3's verdict. FAIL-OPEN: only an explicit "No" is skipped, so a
  // blank column (never qualified) or "Unsure" is contacted exactly as before.
  // A lead already mid-sequence is not pulled out — a fit verdict is a list
  // decision, and only a reply or an opt-out stops a live thread.
  if (qTrim(lead.fit).toLowerCase() === 'no' && touch === 'email1') {
    return { eligible: false, touch: touch, reason: 'Disqualified by the qualification pass (Fit = No).', waitedBusinessDays: null };
  }

  var required = QUEUE_WAIT_BUSINESS_DAYS[touch];
  if (required > 0) {
    var waited = businessDaysSince(lead.lastContactedDate, now, tz, holidays);
    if (waited === null) {
      // A follow-up status with no usable timestamp is a data problem, not a
      // licence to email. Fail closed.
      return {
        eligible: false,
        touch: touch,
        reason: 'Status is "' + status + '" but Last Contacted Date is missing/unparseable — refusing to guess.',
        waitedBusinessDays: null
      };
    }
    if (waited < required) {
      return {
        eligible: false,
        touch: touch,
        reason: 'Only ' + waited + ' of ' + required + ' business days elapsed.',
        waitedBusinessDays: waited
      };
    }
    return { eligible: true, touch: touch, reason: 'Due: ' + waited + ' business days elapsed (needs ' + required + ').', waitedBusinessDays: waited };
  }

  // Touch 1: never email the same record twice in one calendar day, even if a
  // partial write left Status behind.
  if (lead.lastContactedDate) {
    var lastYMD = zonedYMD(lead.lastContactedDate, tz);
    var todayYMD = zonedYMD(now, tz);
    if (lastYMD && lastYMD === todayYMD) {
      return { eligible: false, touch: touch, reason: 'Already contacted today.', waitedBusinessDays: 0 };
    }
  }
  return { eligible: true, touch: touch, reason: 'New lead.', waitedBusinessDays: null };
}

/**
 * Build today's send queue.
 *
 * @param {Array}  records Airtable records (raw API shape)
 * @param {object} ctx     { now, timeZone, holidays, dailyCap, staggerMinMinutes,
 *                           staggerMaxMinutes, sendWindowEndHour, rng }
 * @returns {{queue:Array, skipped:Array, stats:object}}
 */
function buildQueue(records, ctx) {
  var c = ctx || {};
  var now = c.now || new Date().toISOString();
  var tz = c.timeZone || 'UTC';
  var cap = Number(c.dailyCap) > 0 ? Math.floor(Number(c.dailyCap)) : 30;
  var minM = c.staggerMinMinutes === undefined ? 15 : Number(c.staggerMinMinutes);
  var maxM = c.staggerMaxMinutes === undefined ? 20 : Number(c.staggerMaxMinutes);
  var rng = c.rng;

  var eligible = [];
  var skipped = [];

  var list = records || [];
  for (var i = 0; i < list.length; i++) {
    var lead = normalizeRecord(list[i]);
    var verdict = evaluateLead(lead, { now: now, timeZone: tz, holidays: c.holidays });
    if (verdict.eligible) {
      lead.touch = verdict.touch;
      lead.nextStatus = QUEUE_NEXT_STATUS[verdict.touch];
      lead.dueReason = verdict.reason;
      lead.waitedBusinessDays = verdict.waitedBusinessDays;
      eligible.push(lead);
    } else {
      skipped.push({ recordId: lead.recordId, email: lead.email, status: lead.status, reason: verdict.reason });
    }
  }

  // Deduplicate by email. Duplicate rows are the #1 way a "30/day" campaign
  // quietly sends the same person three emails in one morning.
  var seen = {};
  var deduped = [];
  for (var d = 0; d < eligible.length; d++) {
    var key = eligible[d].email;
    if (key && seen[key]) {
      skipped.push({
        recordId: eligible[d].recordId,
        email: key,
        status: eligible[d].status,
        reason: 'Duplicate email in today\'s queue (kept record ' + seen[key] + ').'
      });
      continue;
    }
    if (key) seen[key] = eligible[d].recordId;
    deduped.push(eligible[d]);
  }

  // Follow-ups first, then oldest-waiting, then stable by record id.
  deduped.sort(function (a, b) {
    var pa = QUEUE_PRIORITY[a.touch], pb = QUEUE_PRIORITY[b.touch];
    if (pa !== pb) return pa - pb;
    var wa = a.waitedBusinessDays === null ? -1 : a.waitedBusinessDays;
    var wb = b.waitedBusinessDays === null ? -1 : b.waitedBusinessDays;
    if (wa !== wb) return wb - wa;
    var ca = String(a.createdTime || ''), cb = String(b.createdTime || '');
    if (ca !== cb) return ca < cb ? -1 : 1;
    return String(a.recordId) < String(b.recordId) ? -1 : 1;
  });

  var overflow = deduped.slice(cap);
  for (var o = 0; o < overflow.length; o++) {
    skipped.push({
      recordId: overflow[o].recordId,
      email: overflow[o].email,
      status: overflow[o].status,
      reason: 'Over the ' + cap + '/day cap — rolls to the next business day.'
    });
  }

  var queue = deduped.slice(0, cap);

  // Stagger. Item 0 goes immediately; each subsequent item waits 15-20 min.
  var cumulative = 0;
  for (var q = 0; q < queue.length; q++) {
    var wait = q === 0 ? 0 : staggerSeconds(minM, maxM, rng);
    cumulative += wait;
    queue[q].position = q + 1;
    queue[q].queueSize = queue.length;
    queue[q].waitSeconds = wait;
    queue[q].offsetSeconds = cumulative;
    queue[q].plannedSendAt = new Date(new Date(now).getTime() + cumulative * 1000).toISOString();
    queue[q].idempotencyTarget = queue[q].recordId + ':' + queue[q].touch;
    queue[q].runDate = zonedYMD(now, tz);
  }

  var byTouch = { email1: 0, followup1: 0, followup2: 0 };
  for (var t = 0; t < queue.length; t++) byTouch[queue[t].touch]++;

  return {
    queue: queue,
    skipped: skipped,
    stats: {
      fetched: list.length,
      eligible: eligible.length,
      deduped: deduped.length,
      queued: queue.length,
      skipped: skipped.length,
      cap: cap,
      byTouch: byTouch,
      totalStaggerSeconds: cumulative,
      projectedFinishAt: new Date(new Date(now).getTime() + cumulative * 1000).toISOString()
    }
  };
}

/**
 * Airtable filterByFormula for the fetch.
 *
 * Two jobs: (a) never even LOAD a terminal record, and (b) keep the payload
 * small. The real safety guarantee is enforced again per-record right before
 * sending — this formula is the cheap first line, not the only one.
 */
function fetchFormula(opts) {
  var o = opts || {};
  // Only added when the Fit column actually exists — referencing a missing
  // field makes Airtable reject the whole formula.
  var fitClause = o.excludeUnfit ? '  {Fit} != "No",' : '';
  return [
    'AND(',
    '  {Email} != "",',
    fitClause,
    '  NOT(OR(',
    '    {Status} = "Replied",',
    '    {Status} = "Do Not Contact",',
    '    {Status} = "Invalid",',
    '    {Status} = "Sent Follow-up 2"',
    '  )),',
    '  OR(',
    '    {Status} = "",',
    '    {Status} = "New",',
    '    {Status} = "Queued",',
    '    {Status} = "Sent Email 1",',
    '    {Status} = "Sent Follow-up 1"',
    '  )',
    ')'
  ].join('').replace(/\s+/g, ' ');
}

/**
 * Final pre-send guard, run against a FRESHLY re-read record.
 *
 * The queue is built at 08:00 but the last email goes out ~9 hours later. In
 * that window a prospect can reply, or an operator can mark Do Not Contact.
 * This is Safety Guarantee #2 and the reason Workflow 1 re-reads every record
 * immediately before it sends.
 */
function guardBeforeSend(freshRecord, intent, ctx) {
  var c = ctx || {};
  var lead = normalizeRecord(freshRecord);
  var tz = c.timeZone || 'UTC';
  var now = c.now || new Date().toISOString();

  if (!lead.recordId) {
    return { proceed: false, code: 'gone', reason: 'Record no longer exists.' };
  }
  if (isTerminal(lead.status)) {
    return { proceed: false, code: 'terminal', reason: 'Status changed to "' + lead.status + '" while queued.' };
  }
  if (lead.idempotencyKey && lead.idempotencyKey === intent.idempotencyTarget) {
    return { proceed: false, code: 'duplicate', reason: 'This exact touch already committed (idempotency key match).' };
  }
  if (qTrim(lead.status).toLowerCase() !== qTrim(intent.status).toLowerCase()) {
    return {
      proceed: false,
      code: 'moved',
      reason: 'Status moved from "' + intent.status + '" to "' + lead.status + '" while queued.'
    };
  }
  if (!lead.email) {
    return { proceed: false, code: 'no-email', reason: 'Email was cleared while queued.' };
  }
  if (qTrim(lead.fit).toLowerCase() === 'no' && intent.touch === 'email1') {
    return { proceed: false, code: 'unfit', reason: 'Marked Fit = No while queued.' };
  }
  var lastYMD = lead.lastContactedDate ? zonedYMD(lead.lastContactedDate, tz) : null;
  if (lastYMD && lastYMD === zonedYMD(now, tz)) {
    return { proceed: false, code: 'sent-today', reason: 'Already contacted today (another run or a manual send).' };
  }
  return { proceed: true, code: 'ok', reason: 'Guard passed.', lead: lead };
}

// ---8<--- exports (stripped by build/build.js when inlining into n8n)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QUEUE_TERMINAL_STATUSES: QUEUE_TERMINAL_STATUSES,
    QUEUE_TOUCH_BY_STATUS: QUEUE_TOUCH_BY_STATUS,
    QUEUE_NEXT_STATUS: QUEUE_NEXT_STATUS,
    QUEUE_WAIT_BUSINESS_DAYS: QUEUE_WAIT_BUSINESS_DAYS,
    normalizeRecord: normalizeRecord,
    isTerminal: isTerminal,
    evaluateLead: evaluateLead,
    buildQueue: buildQueue,
    fetchFormula: fetchFormula,
    guardBeforeSend: guardBeforeSend
  };
}
