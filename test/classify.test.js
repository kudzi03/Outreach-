'use strict';
const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/lib/classify.js');

const reply = (over) => Object.assign({
  fromEmail: 'dana@mapleridgekitchens.com',
  subject: 'Re: quick question / Maple Ridge Kitchens',
  text: 'Sounds fine.',
  headers: {}
}, over);

/* ---------------------------------------------------------------- parsing */

test('extractEmail handles display names, angle brackets and casing', () => {
  assert.strictEqual(c.extractEmail('"Dana Ruiz" <Dana@Example.COM>'), 'dana@example.com');
  assert.strictEqual(c.extractEmail('dana@example.com'), 'dana@example.com');
  assert.strictEqual(c.extractEmail('Dana Ruiz'), null);
  assert.strictEqual(c.extractEmail(''), null);
});

test('matchKey strips plus-addressing but never Gmail dots', () => {
  assert.strictEqual(c.matchKey('dana+leads@example.com'), 'dana@example.com');
  // Dot-folding is a Gmail-only rule; applying it elsewhere matches the wrong
  // person, so first.last stays intact.
  assert.strictEqual(c.matchKey('first.last@example.com'), 'first.last@example.com');
});

test('stripQuoted removes the quoted history under a reply', () => {
  const body = [
    'We handle it ourselves, mostly.',
    '',
    'On Tue, Sep 1, 2026 at 9:04 AM Nat M <nat@acme.com> wrote:',
    '> Hey Dana, quick question: when you guys drop off a quote...',
    '> Not the right person? Just reply "stop" and I will close the loop.'
  ].join('\n');
  assert.strictEqual(c.stripQuoted(body), 'We handle it ourselves, mostly.');
});

test('stripQuoted handles Outlook and mobile-client separators', () => {
  assert.strictEqual(
    c.stripQuoted('Not for us.\n\n-----Original Message-----\nFrom: Nat\nstop'),
    'Not for us.'
  );
  assert.strictEqual(
    c.stripQuoted('Interesting.\n\n________________________________\nFrom: Nat M'),
    'Interesting.'
  );
  assert.strictEqual(c.stripQuoted('Sure thing\n\nSent from my iPhone'), 'Sure thing');
});

test('stripQuoted keeps the original when stripping would empty the message', () => {
  assert.strictEqual(c.stripQuoted('> only quoted text'), '> only quoted text');
  assert.strictEqual(c.stripQuoted(''), '');
});

/* ------------------------------------------------------- the critical case */

test('our own signature quoted back does NOT opt the prospect out', () => {
  // The single most dangerous false positive in the system: every reply
  // quotes our footer, and our footer contains the word "stop".
  const r = c.classifyInbound(reply({
    text: [
      'Yeah, honestly it is manual right now. What did you have in mind?',
      '',
      'On Tue, Sep 1, 2026, Nat M <nat@acme.com> wrote:',
      '> Hey Dana, quick question...',
      '> --',
      '> Nat M',
      '> Not the right person? Just reply "stop" and I will close the loop.'
    ].join('\n')
  }));
  assert.strictEqual(r.verdict, 'replied');
  assert.strictEqual(r.nextStatus, 'Replied');
  assert.deepStrictEqual(r.matchedOptOut, []);
});

test('a bare "stop" is an opt-out', () => {
  const r = c.classifyInbound(reply({ text: 'stop' }));
  assert.strictEqual(r.verdict, 'optout');
  assert.strictEqual(r.nextStatus, 'Do Not Contact');
});

test('"stop" inside a warm sentence is NOT an opt-out', () => {
  const r = c.classifyInbound(reply({
    text: 'Sure — stop by the showroom Thursday afternoon and we can talk it through.'
  }));
  assert.strictEqual(r.verdict, 'replied', 'a booking must never be read as an opt-out');
  assert.strictEqual(r.nextStatus, 'Replied');
});

test('"remove" inside a sentence about a job is not an opt-out', () => {
  const r = c.classifyInbound(reply({
    text: 'We remove the old cabinets first, then template the counters. Why do you ask?'
  }));
  assert.strictEqual(r.verdict, 'replied');
});

/* ------------------------------------------------- every brief-named phrase */

test('every opt-out keyword named in the brief is matched', () => {
  const phrases = {
    'stop': 'Please stop emailing me.',
    'unsubscribe': 'unsubscribe',
    'not interested': 'Thanks, but not interested.',
    'remove': 'Please remove me from your list.',
    'wrong person': 'You have the wrong person, I do not work here.'
  };
  for (const [label, text] of Object.entries(phrases)) {
    const r = c.classifyInbound(reply({ text }));
    assert.strictEqual(r.verdict, 'optout', `"${label}" should opt out (got ${r.verdict})`);
    assert.strictEqual(r.nextStatus, 'Do Not Contact');
  }
});

test('common opt-out variants are matched too', () => {
  const variants = [
    'Take me off your list please.',
    'Do not contact us again.',
    'no thanks',
    'This is spam.',
    'Dave is no longer with the company.',
    'Please delete my email from your database.'
  ];
  for (const text of variants) {
    assert.strictEqual(c.classifyInbound(reply({ text })).verdict, 'optout', text);
  }
});

/* --------------------------------------------------- auto-replies & bounces */

test('an out-of-office is not a reply and changes nothing', () => {
  const r = c.classifyInbound(reply({
    subject: 'Automatic reply: quick question / Maple Ridge Kitchens',
    text: 'I am out of the office until September 14 with limited access to email.'
  }));
  assert.strictEqual(r.verdict, 'auto');
  assert.strictEqual(r.nextStatus, null, 'an OOO must not kill a live sequence');
  assert.strictEqual(r.notify, false);
});

test('auto-replies are detected from headers even with an innocent subject', () => {
  const r = c.classifyInbound(reply({
    subject: 'Re: quick question',
    text: 'Thanks for your message, someone will be in touch.',
    headers: { 'Auto-Submitted': 'auto-replied' }
  }));
  assert.strictEqual(r.verdict, 'auto');
});

test('"Auto-Submitted: no" is a real human reply', () => {
  const r = c.classifyInbound(reply({ headers: { 'Auto-Submitted': 'no' } }));
  assert.strictEqual(r.verdict, 'replied');
});

test('bounces mark the address Invalid, not Replied', () => {
  const r = c.classifyInbound(reply({
    fromEmail: 'MAILER-DAEMON@mx.example.com',
    subject: 'Undeliverable: quick question',
    text: '550 5.1.1 The email account that you tried to reach does not exist.'
  }));
  assert.strictEqual(r.verdict, 'bounce');
  assert.strictEqual(r.nextStatus, 'Invalid');
});

test('a DSN is detected from its content-type even without a telltale subject', () => {
  const r = c.classifyInbound(reply({
    subject: 'Re: quick question',
    headers: { 'Content-Type': 'multipart/report; report-type=delivery-status; boundary=x' }
  }));
  assert.strictEqual(r.verdict, 'bounce');
});

test('a bounce quoting our own body is still a bounce, not an opt-out', () => {
  // Ordering matters: bounce is tested before opt-out precisely because a DSN
  // quotes the original message, footer and all.
  const r = c.classifyInbound(reply({
    fromEmail: 'postmaster@mx.example.com',
    subject: 'Delivery Status Notification (Failure)',
    text: 'Delivery failed.\n\n--- Original message ---\nJust reply "stop" and I will close the loop.'
  }));
  assert.strictEqual(r.verdict, 'bounce');
});

/* ------------------------------------------------------------- sentiment */

test('positive intent is flagged for a louder notification', () => {
  const r = c.classifyInbound(reply({ text: 'Yes please send over the video — how much does it cost?' }));
  assert.strictEqual(r.verdict, 'replied');
  assert.strictEqual(r.sentiment, 'positive');
  assert.ok(r.matchedPositive.length > 0);
});

test('a neutral reply is still a reply', () => {
  const r = c.classifyInbound(reply({ text: 'Who is this?' }));
  assert.strictEqual(r.verdict, 'replied');
  assert.strictEqual(r.sentiment, 'neutral');
  assert.strictEqual(r.nextStatus, 'Replied');
});

test('an empty body still yields a safe verdict', () => {
  const r = c.classifyInbound({ fromEmail: 'a@b.com', subject: 'Re: x', text: '' });
  assert.strictEqual(r.verdict, 'replied');
  assert.strictEqual(r.nextStatus, 'Replied');
});

test('classifyInbound tolerates a completely empty input', () => {
  const r = c.classifyInbound();
  assert.strictEqual(r.verdict, 'replied');
});

test('word-boundary matching does not fire on substrings', () => {
  assert.strictEqual(c.containsPhrase('nothing to report', 'no'), false);
  assert.strictEqual(c.containsPhrase('no thanks', 'no thanks'), true);
  assert.strictEqual(c.containsPhrase('stopwatch', 'stop'), false);
});
