'use strict';
/**
 * sequence.test.js — end-to-end simulation of the whole campaign.
 *
 * Runs a fake Airtable base through many simulated days, driving it with the
 * same libraries the n8n Code nodes run. This is where the properties that
 * matter get proven: nobody ever gets more than three emails, nobody who
 * replied or opted out ever gets another one, and the cap holds every day.
 */
const test = require('node:test');
const assert = require('node:assert');

const dates = require('../src/lib/dates.js');
const queue = require('../src/lib/queue.js');
const templates = require('../src/lib/templates.js');
const classify = require('../src/lib/classify.js');

const TZ = 'America/New_York';
const CFG = { senderName: 'Nat', senderCompany: 'Acme', senderPostalAddress: '1 Main St' };

/** A tiny in-memory stand-in for the Airtable table. */
function makeBase(count, seedFields = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: `rec${String(i).padStart(4, '0')}`,
    createdTime: '2026-08-01T00:00:00.000Z',
    fields: Object.assign({
      'First Name': `Lead${i}`,
      'Company Name': `Remodeler ${i}`,
      Email: `lead${i}@example.com`,
      City: 'Austin',
      Status: 'New'
    }, seedFields)
  }));
}

/**
 * Run one dispatcher day against the base, mutating records the way
 * Workflow 1's commit step does. Returns the emails "sent".
 */
function runDay(base, isoNoon, opts = {}) {
  const ymd = dates.zonedYMD(isoNoon, TZ);
  if (!dates.isBusinessDayYMD(ymd, opts.holidays)) return [];

  // Mirror the Airtable filterByFormula: terminal records never load.
  const candidates = base.filter((r) => {
    const s = String(r.fields.Status || '');
    return r.fields.Email && !['Replied', 'Do Not Contact', 'Invalid', 'Sent Follow-up 2'].includes(s);
  });

  const built = queue.buildQueue(candidates, {
    now: isoNoon,
    timeZone: TZ,
    holidays: opts.holidays,
    dailyCap: opts.dailyCap === undefined ? 30 : opts.dailyCap,
    rng: () => 0.5
  });

  const sent = [];
  for (const item of built.queue) {
    const record = base.find((r) => r.id === item.recordId);

    // The pre-send guard, against the record as it stands right now.
    const guard = queue.guardBeforeSend(record, { status: item.status, idempotencyTarget: item.idempotencyTarget }, {
      now: isoNoon, timeZone: TZ
    });
    if (!guard.proceed) continue;

    const msg = templates.buildMessage(item.touch, {
      firstName: item.firstName,
      companyName: item.companyName,
      threadSubject: item.threadSubject,
      messageId: item.messageId
    }, CFG);

    record.fields.Status = item.nextStatus;
    record.fields['Last Contacted Date'] = isoNoon;
    record.fields['Idempotency Key'] = item.idempotencyTarget;
    if (item.touch === 'email1') {
      record.fields['Message ID'] = `<${record.id}@mtasv.net>`;
      record.fields['Thread Subject'] = msg.subject;
    }
    sent.push({ day: ymd, recordId: record.id, email: item.email, touch: item.touch, subject: msg.subject });
  }
  return sent;
}

/** Business days at 12:00 local, starting from a Tuesday. */
function* days(startYMD, n) {
  let ymd = startYMD;
  for (let i = 0; i < n; i++) {
    yield { ymd, iso: `${ymd}T16:00:00.000Z` }; // 12:00 EDT
    ymd = dates.shiftYMD(ymd, 1);
  }
}

/* ===================================================================== */

test('a single lead receives exactly three emails on the brief cadence', () => {
  const base = makeBase(1);
  const sent = [];
  for (const day of days('2026-09-01', 20)) sent.push(...runDay(base, day.iso));

  assert.strictEqual(sent.length, 3, 'exactly three touches, ever');
  assert.deepStrictEqual(sent.map((s) => s.touch), ['email1', 'followup1', 'followup2']);
  // Tue 1 Sep -> Fri 4 Sep (3 business days) -> Thu 10 Sep (4 business days).
  assert.deepStrictEqual(sent.map((s) => s.day), ['2026-09-01', '2026-09-04', '2026-09-10']);
  assert.strictEqual(base[0].fields.Status, 'Sent Follow-up 2');
});

test('follow-ups thread onto touch 1', () => {
  const base = makeBase(1);
  const sent = [];
  for (const day of days('2026-09-01', 20)) sent.push(...runDay(base, day.iso));
  assert.strictEqual(sent[0].subject, 'quick question / Remodeler 0');
  assert.strictEqual(sent[1].subject, 'Re: quick question / Remodeler 0');
  assert.strictEqual(sent[2].subject, 'Re: quick question / Remodeler 0');
});

test('the 30/day cap holds on every single day of a 200-lead campaign', () => {
  const base = makeBase(200);
  const perDay = {};
  for (const day of days('2026-09-01', 40)) {
    const sent = runDay(base, day.iso);
    if (sent.length) perDay[day.ymd] = sent.length;
  }
  for (const [ymd, n] of Object.entries(perDay)) {
    assert.ok(n <= 30, `${ymd} sent ${n} emails, over the cap`);
    assert.ok(dates.isBusinessDayYMD(ymd), `${ymd} is not a business day`);
  }
});

test('every lead in a large campaign ends with at most three emails', () => {
  const base = makeBase(200);
  const counts = {};
  for (const day of days('2026-09-01', 60)) {
    for (const s of runDay(base, day.iso)) {
      counts[s.recordId] = (counts[s.recordId] || 0) + 1;
    }
  }
  for (const [id, n] of Object.entries(counts)) {
    assert.ok(n <= 3, `${id} received ${n} emails`);
  }
});

test('no lead ever receives two emails on the same day', () => {
  const base = makeBase(120);
  for (const day of days('2026-09-01', 40)) {
    const sent = runDay(base, day.iso);
    const ids = sent.map((s) => s.recordId);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate send on ${day.ymd}`);
  }
});

test('SAFETY: a reply mid-sequence stops all further email, forever', () => {
  const base = makeBase(1);
  runDay(base, '2026-09-01T16:00:00.000Z');
  assert.strictEqual(base[0].fields.Status, 'Sent Email 1');

  // Workflow 2 processes an inbound reply.
  const verdict = classify.classifyInbound({
    fromEmail: 'lead0@example.com',
    subject: 'Re: quick question / Remodeler 0',
    text: 'We handle it manually. What did you have in mind?'
  });
  assert.strictEqual(verdict.nextStatus, 'Replied');
  base[0].fields.Status = verdict.nextStatus;

  const later = [];
  for (const day of days('2026-09-02', 40)) later.push(...runDay(base, day.iso));
  assert.deepStrictEqual(later, [], 'a replied lead must never be emailed again');
});

test('SAFETY: an opt-out stops all further email, forever', () => {
  const base = makeBase(1);
  runDay(base, '2026-09-01T16:00:00.000Z');

  const verdict = classify.classifyInbound({
    fromEmail: 'lead0@example.com',
    subject: 'Re: quick question',
    text: 'Please remove me from your list.'
  });
  assert.strictEqual(verdict.nextStatus, 'Do Not Contact');
  base[0].fields.Status = verdict.nextStatus;

  const later = [];
  for (const day of days('2026-09-02', 60)) later.push(...runDay(base, day.iso));
  assert.deepStrictEqual(later, []);
});

test('SAFETY: an out-of-office does NOT stop the sequence', () => {
  const base = makeBase(1);
  runDay(base, '2026-09-01T16:00:00.000Z');

  const verdict = classify.classifyInbound({
    fromEmail: 'lead0@example.com',
    subject: 'Automatic reply: quick question',
    text: 'I am on site until Monday.'
  });
  assert.strictEqual(verdict.nextStatus, null);
  // Workflow 2 writes nothing, so the sequence continues.

  const later = [];
  for (const day of days('2026-09-02', 20)) later.push(...runDay(base, day.iso));
  assert.deepStrictEqual(later.map((s) => s.touch), ['followup1', 'followup2']);
});

test('SAFETY: a reply arriving between queue-build and send is caught by the guard', () => {
  const base = makeBase(1, { Status: 'Sent Email 1', 'Last Contacted Date': '2026-08-31T16:00:00.000Z' });
  const now = '2026-09-03T16:00:00.000Z';

  const built = queue.buildQueue(base, { now, timeZone: TZ, dailyCap: 30, rng: () => 0.5 });
  assert.strictEqual(built.queue.length, 1, 'the follow-up is due');

  // ...and now, during the stagger wait, the prospect replies.
  base[0].fields.Status = 'Replied';

  const item = built.queue[0];
  const guard = queue.guardBeforeSend(base[0], { status: item.status, idempotencyTarget: item.idempotencyTarget }, {
    now, timeZone: TZ
  });
  assert.strictEqual(guard.proceed, false);
  assert.strictEqual(guard.code, 'terminal');
});

test('nothing is sent on weekends or configured holidays', () => {
  const base = makeBase(60);
  const holidays = ['2026-09-07']; // Labor Day, a Monday
  const sentDays = new Set();
  for (const day of days('2026-09-01', 21)) {
    if (runDay(base, day.iso, { holidays }).length) sentDays.add(day.ymd);
  }
  assert.ok(!sentDays.has('2026-09-05') && !sentDays.has('2026-09-06'), 'weekend send detected');
  assert.ok(!sentDays.has('2026-09-07'), 'holiday send detected');
  assert.ok(sentDays.has('2026-09-08'), 'the day after the holiday should still run');
});

test('a backlog drains without ever starving follow-ups', () => {
  const base = makeBase(90);
  const daily = [];
  for (const day of days('2026-09-01', 30)) {
    const sent = runDay(base, day.iso);
    if (sent.length) {
      daily.push({
        ymd: day.ymd,
        total: sent.length,
        followUps: sent.filter((s) => s.touch !== 'email1').length
      });
    }
  }
  // From day 4 on there is always follow-up work, and it is never postponed
  // behind fresh cold opens.
  const day4 = daily[3];
  assert.ok(day4.followUps > 0, 'follow-ups must be sent as soon as they are due');
  const totalSent = daily.reduce((n, d) => n + d.total, 0);
  assert.strictEqual(totalSent, 90 * 3, 'every lead completes all three touches');
});

test('a full campaign never contacts an address more than three times', () => {
  const base = makeBase(150);
  const byEmail = {};
  for (const day of days('2026-09-01', 60)) {
    for (const s of runDay(base, day.iso)) {
      byEmail[s.email] = (byEmail[s.email] || 0) + 1;
    }
  }
  const over = Object.entries(byEmail).filter(([, n]) => n > 3);
  assert.deepStrictEqual(over, []);
});
