'use strict';
const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/lib/dates.js');

test('zonedYMD resolves the calendar day in the campaign timezone, not UTC', () => {
  // 03:00 UTC on Sep 4 is still Sep 3 in New York. Getting this wrong makes a
  // Thursday send look like a Friday send and shifts every follow-up.
  assert.strictEqual(d.zonedYMD('2026-09-04T03:00:00Z', 'America/New_York'), '2026-09-03');
  assert.strictEqual(d.zonedYMD('2026-09-04T03:00:00Z', 'UTC'), '2026-09-04');
  assert.strictEqual(d.zonedYMD('2026-09-03T23:00:00Z', 'Australia/Sydney'), '2026-09-04');
});

test('zonedYMD returns null for junk instead of throwing', () => {
  assert.strictEqual(d.zonedYMD('', 'UTC'), null);
  assert.strictEqual(d.zonedYMD('not a date', 'UTC'), null);
  assert.strictEqual(d.zonedYMD(null, 'UTC'), null);
});

test('isBusinessDayYMD excludes weekends', () => {
  assert.strictEqual(d.isBusinessDayYMD('2026-09-04'), true);  // Friday
  assert.strictEqual(d.isBusinessDayYMD('2026-09-05'), false); // Saturday
  assert.strictEqual(d.isBusinessDayYMD('2026-09-06'), false); // Sunday
  assert.strictEqual(d.isBusinessDayYMD('2026-09-07'), true);  // Monday
});

test('isBusinessDayYMD honours the holiday list in both forms', () => {
  assert.strictEqual(d.isBusinessDayYMD('2026-09-07', ['2026-09-07']), false);
  assert.strictEqual(d.isBusinessDayYMD('2026-09-07', '2026-01-01,2026-09-07'), false);
  assert.strictEqual(d.isBusinessDayYMD('2026-09-08', '2026-09-07'), true);
});

test('businessDaysBetweenYMD counts weekdays after `from`, through `to`', () => {
  assert.strictEqual(d.businessDaysBetweenYMD('2026-09-01', '2026-09-01'), 0);
  assert.strictEqual(d.businessDaysBetweenYMD('2026-09-01', '2026-09-02'), 1);
  // Friday -> Monday is one business day, not three.
  assert.strictEqual(d.businessDaysBetweenYMD('2026-09-04', '2026-09-07'), 1);
  // Friday -> Wednesday is three: Mon, Tue, Wed.
  assert.strictEqual(d.businessDaysBetweenYMD('2026-09-04', '2026-09-09'), 3);
  // A whole week is exactly five.
  assert.strictEqual(d.businessDaysBetweenYMD('2026-09-01', '2026-09-08'), 5);
});

test('businessDaysBetweenYMD is signed and never loops forever', () => {
  assert.strictEqual(d.businessDaysBetweenYMD('2026-09-09', '2026-09-04'), -3);
  assert.strictEqual(d.businessDaysBetweenYMD('bad', '2026-09-04'), null);
});

test('the brief-specified cadence lands on the right days', () => {
  // Touch 1 Tuesday -> follow-up 1 needs 3 business days -> Friday.
  const t1 = '2026-09-01'; // Tuesday
  assert.strictEqual(d.businessDaysBetweenYMD(t1, '2026-09-03'), 2, 'Thursday is too early');
  assert.strictEqual(d.businessDaysBetweenYMD(t1, '2026-09-04'), 3, 'Friday is the earliest FU1');
  // Follow-up 1 Friday -> follow-up 2 needs 4 business days -> the next Thursday.
  const t2 = '2026-09-04';
  assert.strictEqual(d.businessDaysBetweenYMD(t2, '2026-09-09'), 3, 'Wednesday is too early');
  assert.strictEqual(d.businessDaysBetweenYMD(t2, '2026-09-10'), 4, 'Thursday is the earliest FU2');
});

test('businessDaysSince works across a timezone boundary', () => {
  // Sent 23:50 UTC Tuesday = 19:50 Tuesday in New York.
  const sent = '2026-09-01T23:50:00Z';
  assert.strictEqual(d.businessDaysSince(sent, '2026-09-04T13:00:00Z', 'America/New_York'), 3);
  // Same instant read as UTC: still Tuesday, still 3 by Friday.
  assert.strictEqual(d.businessDaysSince(sent, '2026-09-04T13:00:00Z', 'UTC'), 3);
});

test('businessDaysSince returns null for a missing timestamp (callers fail closed)', () => {
  assert.strictEqual(d.businessDaysSince('', '2026-09-04T13:00:00Z', 'UTC'), null);
  assert.strictEqual(d.businessDaysSince(undefined, '2026-09-04T13:00:00Z', 'UTC'), null);
});

test('addBusinessDays skips weekends and holidays', () => {
  assert.strictEqual(d.addBusinessDays('2026-09-04T12:00:00Z', 1, 'UTC'), '2026-09-07');
  assert.strictEqual(d.addBusinessDays('2026-09-04T12:00:00Z', 1, 'UTC', ['2026-09-07']), '2026-09-08');
  assert.strictEqual(d.addBusinessDays('2026-09-01T12:00:00Z', 3, 'UTC'), '2026-09-04');
});

test('send window and runway are computed in the campaign timezone', () => {
  const at9NY = '2026-09-03T13:00:00Z'; // 09:00 EDT
  assert.strictEqual(d.isWithinSendWindow(at9NY, 'America/New_York', 8, 18), true);
  assert.strictEqual(d.isWithinSendWindow(at9NY, 'America/New_York', 10, 18), false);
  assert.strictEqual(d.secondsLeftInWindow(at9NY, 'America/New_York', 18), 9 * 3600);
  assert.strictEqual(d.secondsLeftInWindow('2026-09-03T23:00:00Z', 'America/New_York', 18), 0);
});

test('staggerSeconds stays inside the configured band', () => {
  assert.strictEqual(d.staggerSeconds(15, 20, () => 0), 900);
  assert.strictEqual(d.staggerSeconds(15, 20, () => 0.5), 1050);
  assert.ok(d.staggerSeconds(15, 20, () => 0.999) <= 1200);
  for (let i = 0; i < 500; i++) {
    const s = d.staggerSeconds(15, 20);
    assert.ok(s >= 900 && s <= 1200, `stagger ${s} outside 900-1200s`);
  }
});

test('staggerSeconds survives a broken rng and an inverted band', () => {
  assert.strictEqual(d.staggerSeconds(15, 20, () => NaN), 1050);
  assert.strictEqual(d.staggerSeconds(20, 15, () => 0.5), 1200);
});
