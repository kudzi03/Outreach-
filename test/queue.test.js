'use strict';
const test = require('node:test');
const assert = require('node:assert');
const q = require('../src/lib/queue.js');

const NOW = '2026-09-03T13:00:00Z';   // Thursday 09:00 America/New_York
const TZ = 'America/New_York';

let seq = 0;
function rec(fields, id, createdTime) {
  seq++;
  return {
    id: id || `rec${String(seq).padStart(3, '0')}`,
    createdTime: createdTime || '2026-08-01T00:00:00.000Z',
    fields: Object.assign({ Email: `lead${seq}@example.com` }, fields)
  };
}

const ctx = (over) => Object.assign({ now: NOW, timeZone: TZ, dailyCap: 30, rng: () => 0.5 }, over);

/* -------------------------------------------------------- state machine */

test('blank, New and Queued statuses all map to touch 1', () => {
  for (const status of ['', 'New', 'Queued', 'new', '  New  ']) {
    const v = q.evaluateLead(q.normalizeRecord(rec({ Status: status })), { now: NOW, timeZone: TZ });
    assert.strictEqual(v.eligible, true, `status "${status}"`);
    assert.strictEqual(v.touch, 'email1');
  }
});

test('follow-up 1 needs 3 business days, follow-up 2 needs 4', () => {
  const fu1Early = q.evaluateLead(q.normalizeRecord(rec({
    Status: 'Sent Email 1', 'Last Contacted Date': '2026-09-01T14:00:00Z' // Tue -> Thu = 2
  })), { now: NOW, timeZone: TZ });
  assert.strictEqual(fu1Early.eligible, false);
  assert.match(fu1Early.reason, /2 of 3/);

  const fu1Due = q.evaluateLead(q.normalizeRecord(rec({
    Status: 'Sent Email 1', 'Last Contacted Date': '2026-08-31T14:00:00Z' // Mon -> Thu = 3
  })), { now: NOW, timeZone: TZ });
  assert.strictEqual(fu1Due.eligible, true);
  assert.strictEqual(fu1Due.touch, 'followup1');

  const fu2Early = q.evaluateLead(q.normalizeRecord(rec({
    Status: 'Sent Follow-up 1', 'Last Contacted Date': '2026-08-31T14:00:00Z' // 3 < 4
  })), { now: NOW, timeZone: TZ });
  assert.strictEqual(fu2Early.eligible, false);

  const fu2Due = q.evaluateLead(q.normalizeRecord(rec({
    Status: 'Sent Follow-up 1', 'Last Contacted Date': '2026-08-28T14:00:00Z' // Fri -> Thu = 4
  })), { now: NOW, timeZone: TZ });
  assert.strictEqual(fu2Due.eligible, true);
  assert.strictEqual(fu2Due.touch, 'followup2');
});

test('the weekend never counts toward the follow-up gate', () => {
  // Sent Friday. Monday is 1 business day, not 3 — a naive day-diff would say 3.
  const v = q.evaluateLead(q.normalizeRecord(rec({
    Status: 'Sent Email 1', 'Last Contacted Date': '2026-08-28T14:00:00Z'
  })), { now: '2026-08-31T13:00:00Z', timeZone: TZ });
  assert.strictEqual(v.eligible, false);
  assert.match(v.reason, /1 of 3/);
});

test('holidays extend the gate', () => {
  const lead = q.normalizeRecord(rec({
    Status: 'Sent Email 1', 'Last Contacted Date': '2026-08-31T14:00:00Z'
  }));
  assert.strictEqual(q.evaluateLead(lead, { now: NOW, timeZone: TZ }).eligible, true);
  assert.strictEqual(
    q.evaluateLead(lead, { now: NOW, timeZone: TZ, holidays: ['2026-09-02'] }).eligible,
    false,
    'a mid-week holiday should push the follow-up out a day'
  );
});

/* -------------------------------------------------------------- safety */

test('SAFETY: Replied and Do Not Contact are never eligible, at any stage', () => {
  for (const status of ['Replied', 'Do Not Contact', 'replied', 'DO NOT CONTACT', 'Invalid']) {
    const v = q.evaluateLead(q.normalizeRecord(rec({
      Status: status, 'Last Contacted Date': '2026-01-01T00:00:00Z'
    })), { now: NOW, timeZone: TZ });
    assert.strictEqual(v.eligible, false, `status "${status}" must be terminal`);
    assert.strictEqual(v.touch, null);
  }
});

test('SAFETY: a follow-up status with no timestamp fails closed', () => {
  const v = q.evaluateLead(q.normalizeRecord(rec({ Status: 'Sent Email 1' })), { now: NOW, timeZone: TZ });
  assert.strictEqual(v.eligible, false, 'must not guess a send date');
  assert.match(v.reason, /refusing to guess/);
});

test('SAFETY: an unparseable timestamp fails closed too', () => {
  const v = q.evaluateLead(q.normalizeRecord(rec({
    Status: 'Sent Email 1', 'Last Contacted Date': 'last tuesday'
  })), { now: NOW, timeZone: TZ });
  assert.strictEqual(v.eligible, false);
});

test('an unrecognized status is left alone for a human', () => {
  const v = q.evaluateLead(q.normalizeRecord(rec({ Status: 'Meeting Booked' })), { now: NOW, timeZone: TZ });
  assert.strictEqual(v.eligible, false);
  assert.match(v.reason, /Unrecognized status/);
});

test('a lead already contacted today is not contacted again', () => {
  const v = q.evaluateLead(q.normalizeRecord(rec({
    Status: 'New', 'Last Contacted Date': '2026-09-03T11:00:00Z'
  })), { now: NOW, timeZone: TZ });
  assert.strictEqual(v.eligible, false);
  assert.match(v.reason, /Already contacted today/);
});

test('the sequence ends after follow-up 2', () => {
  const v = q.evaluateLead(q.normalizeRecord(rec({
    Status: 'Sent Follow-up 2', 'Last Contacted Date': '2026-01-01T00:00:00Z'
  })), { now: NOW, timeZone: TZ });
  assert.strictEqual(v.eligible, false);
  assert.match(v.reason, /Sequence complete/);
});

/* ---------------------------------------------------------------- queue */

test('the daily cap is enforced exactly', () => {
  const records = Array.from({ length: 100 }, () => rec({ Status: 'New' }));
  const out = q.buildQueue(records, ctx());
  assert.strictEqual(out.queue.length, 30);
  assert.strictEqual(out.stats.queued, 30);
  assert.strictEqual(out.skipped.filter((s) => /Over the 30\/day cap/.test(s.reason)).length, 70);
});

test('a custom cap is honoured', () => {
  const records = Array.from({ length: 40 }, () => rec({ Status: 'New' }));
  assert.strictEqual(q.buildQueue(records, ctx({ dailyCap: 12 })).queue.length, 12);
  assert.strictEqual(q.buildQueue(records, ctx({ dailyCap: 0 })).queue.length, 30, 'a 0 cap falls back to 30');
});

test('follow-ups outrank new leads when the cap bites', () => {
  const records = [
    ...Array.from({ length: 25 }, () => rec({ Status: 'New' })),
    ...Array.from({ length: 5 }, () => rec({ Status: 'Sent Email 1', 'Last Contacted Date': '2026-08-27T14:00:00Z' })),
    ...Array.from({ length: 5 }, () => rec({ Status: 'Sent Follow-up 1', 'Last Contacted Date': '2026-08-26T14:00:00Z' }))
  ];
  const out = q.buildQueue(records, ctx({ dailyCap: 10 }));
  assert.strictEqual(out.queue.length, 10);
  assert.deepStrictEqual(out.stats.byTouch, { email1: 0, followup1: 5, followup2: 5 });
  assert.strictEqual(out.queue[0].touch, 'followup2', 'the most advanced thread goes first');
});

test('duplicate email addresses are collapsed to one send', () => {
  const records = [
    rec({ Status: 'New', Email: 'dupe@example.com' }, 'recA'),
    rec({ Status: 'New', Email: 'DUPE@example.com' }, 'recB'),
    rec({ Status: 'New', Email: 'other@example.com' }, 'recC')
  ];
  const out = q.buildQueue(records, ctx());
  assert.strictEqual(out.queue.length, 2);
  assert.strictEqual(out.skipped.filter((s) => /Duplicate email/.test(s.reason)).length, 1);
});

test('the stagger is cumulative, and the first lead sends immediately', () => {
  const records = Array.from({ length: 5 }, () => rec({ Status: 'New' }));
  const out = q.buildQueue(records, ctx({ rng: () => 0.5 })); // 1050s each
  assert.strictEqual(out.queue[0].waitSeconds, 0);
  assert.strictEqual(out.queue[0].offsetSeconds, 0);
  assert.strictEqual(out.queue[1].waitSeconds, 1050);
  assert.strictEqual(out.queue[4].offsetSeconds, 4200);
  assert.strictEqual(out.stats.totalStaggerSeconds, 4200);
});

test('a full 30-lead day fits inside a ten-hour window', () => {
  const records = Array.from({ length: 30 }, () => rec({ Status: 'New' }));
  const out = q.buildQueue(records, ctx({ rng: () => 1 - 1e-9 })); // worst case 20 min
  assert.strictEqual(out.stats.totalStaggerSeconds, 29 * 1200);
  assert.ok(out.stats.totalStaggerSeconds <= 10 * 3600, 'must fit an 08:00-18:00 window');
});

test('every queued item carries a unique idempotency target', () => {
  const records = Array.from({ length: 10 }, () => rec({ Status: 'New' }));
  const out = q.buildQueue(records, ctx());
  const keys = new Set(out.queue.map((i) => i.idempotencyTarget));
  assert.strictEqual(keys.size, out.queue.length);
  assert.match(out.queue[0].idempotencyTarget, /^rec\d+:email1$/);
});

test('an empty input produces an empty queue, not an error', () => {
  const out = q.buildQueue([], ctx());
  assert.deepStrictEqual(out.queue, []);
  assert.strictEqual(out.stats.queued, 0);
  assert.deepStrictEqual(q.buildQueue(null, ctx()).queue, []);
});

test('leads with no email address never reach the queue', () => {
  const out = q.buildQueue([rec({ Status: 'New', Email: '' })], ctx());
  assert.strictEqual(out.queue.length, 0);
  assert.match(out.skipped[0].reason, /No email address/);
});

/* --------------------------------------------------------------- formula */

test('the fetch formula excludes every terminal status', () => {
  const f = q.fetchFormula();
  for (const s of ['Replied', 'Do Not Contact', 'Invalid', 'Sent Follow-up 2']) {
    assert.ok(f.includes(`{Status} = "${s}"`), `formula must mention ${s}`);
  }
  assert.ok(f.startsWith('AND('));
  assert.ok(f.includes('NOT(OR('));
  assert.ok(f.includes('{Email} != ""'));
});

/* ---------------------------------------------------------- send guard */

test('GUARD: a reply that lands during the stagger cancels the send', () => {
  const intent = { status: 'Sent Email 1', idempotencyTarget: 'rec1:followup1' };
  const fresh = { id: 'rec1', fields: { Email: 'a@b.com', Status: 'Replied' } };
  const g = q.guardBeforeSend(fresh, intent, { now: NOW, timeZone: TZ });
  assert.strictEqual(g.proceed, false);
  assert.strictEqual(g.code, 'terminal');
});

test('GUARD: an opt-out that lands during the stagger cancels the send', () => {
  const g = q.guardBeforeSend(
    { id: 'rec1', fields: { Email: 'a@b.com', Status: 'Do Not Contact' } },
    { status: 'New', idempotencyTarget: 'rec1:email1' },
    { now: NOW, timeZone: TZ }
  );
  assert.strictEqual(g.proceed, false);
  assert.strictEqual(g.code, 'terminal');
});

test('GUARD: a matching idempotency key blocks a duplicate send on retry', () => {
  const g = q.guardBeforeSend(
    { id: 'rec1', fields: { Email: 'a@b.com', Status: 'New', 'Idempotency Key': 'rec1:email1' } },
    { status: 'New', idempotencyTarget: 'rec1:email1' },
    { now: NOW, timeZone: TZ }
  );
  assert.strictEqual(g.proceed, false);
  assert.strictEqual(g.code, 'duplicate');
});

test('GUARD: a status that advanced underneath us blocks the send', () => {
  const g = q.guardBeforeSend(
    { id: 'rec1', fields: { Email: 'a@b.com', Status: 'Sent Email 1' } },
    { status: 'New', idempotencyTarget: 'rec1:email1' },
    { now: NOW, timeZone: TZ }
  );
  assert.strictEqual(g.proceed, false);
  assert.strictEqual(g.code, 'moved');
});

test('GUARD: a record contacted today by anything else blocks the send', () => {
  const g = q.guardBeforeSend(
    { id: 'rec1', fields: { Email: 'a@b.com', Status: 'New', 'Last Contacted Date': '2026-09-03T11:00:00Z' } },
    { status: 'New', idempotencyTarget: 'rec1:email1' },
    { now: NOW, timeZone: TZ }
  );
  assert.strictEqual(g.proceed, false);
  assert.strictEqual(g.code, 'sent-today');
});

test('GUARD: a deleted or unreadable record blocks the send', () => {
  const g = q.guardBeforeSend({}, { status: 'New', idempotencyTarget: 'x:email1' }, { now: NOW, timeZone: TZ });
  assert.strictEqual(g.proceed, false);
  assert.strictEqual(g.code, 'gone');
});

test('GUARD: an unchanged record passes and returns the fresh lead', () => {
  const g = q.guardBeforeSend(
    { id: 'rec1', fields: { Email: 'A@B.com', Status: 'New', 'First Name': 'Dana' } },
    { status: 'New', idempotencyTarget: 'rec1:email1' },
    { now: NOW, timeZone: TZ }
  );
  assert.strictEqual(g.proceed, true);
  assert.strictEqual(g.lead.email, 'a@b.com');
  assert.strictEqual(g.lead.firstName, 'Dana');
});
