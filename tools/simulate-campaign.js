#!/usr/bin/env node
'use strict';
/**
 * simulate-campaign.js — run the real scheduling logic over a synthetic list
 * and print the day-by-day plan, without touching Airtable or sending anything.
 *
 *   npm run dry-run
 *   npm run dry-run -- --leads=250 --days=45 --cap=30 --start=2026-09-01
 *
 * Use it to answer "how long will 500 leads take?" and to sanity-check a
 * holiday list before it goes live.
 */
const dates = require('../src/lib/dates.js');
const queue = require('../src/lib/queue.js');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const LEADS = Number(arg('leads', 120));
const DAYS = Number(arg('days', 40));
const CAP = Number(arg('cap', 30));
const START = arg('start', '2026-09-01');
const TZ = arg('tz', process.env.CAMPAIGN_TIMEZONE || 'America/New_York');
const HOLIDAYS = arg('holidays', process.env.CAMPAIGN_HOLIDAYS || '');

const base = Array.from({ length: LEADS }, (_, i) => ({
  id: `rec${String(i).padStart(4, '0')}`,
  createdTime: '2026-08-01T00:00:00.000Z',
  fields: {
    'First Name': `Lead${i}`,
    'Company Name': `Remodeler ${i}`,
    Email: `lead${i}@example.com`,
    Status: 'New'
  }
}));

console.log(`Simulating ${LEADS} leads · cap ${CAP}/day · ${TZ} · from ${START}`);
if (HOLIDAYS) console.log(`Holidays: ${HOLIDAYS}`);
console.log('');
console.log('  date         dow  touch1  fu1  fu2  total  finishes');
console.log('  ' + '-'.repeat(56));

let ymd = START;
let grandTotal = 0;
let workingDays = 0;

for (let i = 0; i < DAYS; i++) {
  const iso = `${ymd}T12:00:00.000Z`;
  const dow = new Date(`${ymd}T00:00:00Z`).toUTCString().slice(0, 3);

  if (dates.isBusinessDayYMD(ymd, HOLIDAYS)) {
    const candidates = base.filter((r) => {
      const s = String(r.fields.Status || '');
      return !['Replied', 'Do Not Contact', 'Invalid', 'Sent Follow-up 2'].includes(s);
    });
    const built = queue.buildQueue(candidates, {
      now: iso, timeZone: 'UTC', holidays: HOLIDAYS, dailyCap: CAP, rng: () => 0.5
    });

    for (const item of built.queue) {
      const rec = base.find((r) => r.id === item.recordId);
      rec.fields.Status = item.nextStatus;
      rec.fields['Last Contacted Date'] = iso;
      if (item.touch === 'email1') rec.fields['Message ID'] = `<${rec.id}@mtasv.net>`;
    }

    const t = built.stats.byTouch;
    const total = built.queue.length;
    grandTotal += total;
    if (total) workingDays++;

    const finishHour = 8 + built.stats.totalStaggerSeconds / 3600;
    const finish = total ? `${String(Math.floor(finishHour)).padStart(2, '0')}:${String(Math.round((finishHour % 1) * 60)).padStart(2, '0')}` : '—';
    const flag = finishHour > 18 ? '  <-- OVERRUNS THE 18:00 WINDOW' : '';

    console.log(
      `  ${ymd}  ${dow}  ${String(t.email1).padStart(6)}  ${String(t.followup1).padStart(3)}  ` +
      `${String(t.followup2).padStart(3)}  ${String(total).padStart(5)}  ${finish}${flag}`
    );
  } else {
    console.log(`  ${ymd}  ${dow}       —    —    —      —  (no send)`);
  }
  ymd = dates.shiftYMD(ymd, 1);
}

const done = base.filter((r) => r.fields.Status === 'Sent Follow-up 2').length;
const started = base.filter((r) => r.fields.Status !== 'New').length;

console.log('  ' + '-'.repeat(56));
console.log(`\n  emails sent          ${grandTotal}`);
console.log(`  sending days         ${workingDays}`);
console.log(`  leads contacted      ${started} / ${LEADS}`);
console.log(`  sequences completed  ${done} / ${LEADS}`);
if (done < LEADS) {
  console.log(`\n  ${LEADS - done} leads unfinished after ${DAYS} days — raise --days or lower --leads.`);
}
console.log(`\n  At ${CAP}/day a lead costs 3 emails, so throughput is ~${(CAP / 3).toFixed(1)} new leads/day.`);
