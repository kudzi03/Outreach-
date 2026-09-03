'use strict';
const test = require('node:test');
const assert = require('node:assert');
const t = require('../src/lib/templates.js');

const CFG = {
  senderName: 'Nat Marlowe',
  senderCompany: 'Marlowe Automations',
  senderPostalAddress: '1200 W 6th St, Austin, TX 78703'
};

const lead = (over) => Object.assign({
  'First Name': 'Dana',
  'Company Name': 'Maple Ridge Kitchens'
}, over);

/* --------------------------------------------------- the brief's exact copy */

test('Email 1 subject follows the brief exactly', () => {
  assert.strictEqual(
    t.buildMessage('email1', lead(), CFG).subject,
    'quick question / Maple Ridge Kitchens'
  );
});

test('Email 1 body matches the brief verbatim', () => {
  const body = t.buildMessage('email1', lead(), CFG).textBody;
  assert.ok(body.startsWith(
    'Hey Dana, quick question: when you guys drop off a quote for a $20k+ kitchen ' +
    'or bath job, who usually handles chasing them down a few days later?'
  ), body.slice(0, 200));
});

test('Email 1 falls back to the company variant when there is no first name', () => {
  const body = t.buildMessage('email1', lead({ 'First Name': '' }), CFG).textBody;
  assert.ok(body.startsWith(
    'Quick question for the team at Maple Ridge Kitchens—when you guys send out a ' +
    'quote for a bigger remodel, who handles following up?'
  ), body.slice(0, 200));
});

test('Follow-up 1 carries the brief copy and asks the 48-hour question', () => {
  const body = t.buildMessage('followup1', lead(), CFG).textBody;
  assert.ok(body.startsWith('Hey Dana, reason I asked is most kitchen & bath guys I talk to'));
  assert.ok(body.includes('estimating a project on Tuesday'));
  assert.ok(body.includes('already signed with someone else who checked in first'));
  assert.ok(body.includes('automatically after 48 hours'));
});

test('Follow-up 2 carries the brief copy and the break-up line', () => {
  const body = t.buildMessage('followup2', lead(), CFG).textBody;
  assert.ok(body.includes('packed for the next 6 months'));
  assert.ok(body.includes('60-second video showing how two other remodelers automated it'));
  assert.ok(body.includes('Otherwise, I'));
  assert.ok(body.includes('stop bugging you!'));
});

/* -------------------------------------------------------------- threading */

test('follow-ups are threaded replies with In-Reply-To and References', () => {
  const msg = t.buildMessage('followup1', lead({
    threadSubject: 'quick question / Maple Ridge Kitchens',
    messageId: '<abc-123@mtasv.net>'
  }), CFG);
  assert.strictEqual(msg.isReply, true);
  assert.strictEqual(msg.subject, 'Re: quick question / Maple Ridge Kitchens');
  const byName = Object.fromEntries(msg.headers.map((h) => [h.Name, h.Value]));
  assert.strictEqual(byName['In-Reply-To'], '<abc-123@mtasv.net>');
  assert.strictEqual(byName['References'], '<abc-123@mtasv.net>');
});

test('References accumulates the whole chain', () => {
  const msg = t.buildMessage('followup2', lead({
    threadSubject: 'quick question / X',
    messageId: '<second@mtasv.net>',
    threadReferences: '<first@mtasv.net>'
  }), CFG);
  const refs = msg.headers.find((h) => h.Name === 'References').Value;
  assert.strictEqual(refs, '<first@mtasv.net> <second@mtasv.net>');
});

test('a missing Message-ID degrades to subject threading rather than blocking', () => {
  const msg = t.buildMessage('followup1', lead({ threadSubject: 'quick question / X' }), CFG);
  assert.deepStrictEqual(msg.headers, []);
  assert.strictEqual(msg.subject, 'Re: quick question / X');
});

test('"Re:" never stacks', () => {
  const msg = t.buildMessage('followup2', lead({ threadSubject: 'Re: quick question / X' }), CFG);
  assert.strictEqual(msg.subject, 'Re: quick question / X');
});

test('touch 1 is never a reply', () => {
  const msg = t.buildMessage('email1', lead({ messageId: '<x@y>' }), CFG);
  assert.strictEqual(msg.isReply, false);
  assert.deepStrictEqual(msg.headers, []);
});

/* ------------------------------------------------------- personalization */

test('messy first names are cleaned up', () => {
  assert.strictEqual(t.firstNameOf({ 'First Name': '  john ' }), 'John');
  assert.strictEqual(t.firstNameOf({ 'First Name': 'MARY ANN SMITH' }), 'Mary');
  assert.strictEqual(t.firstNameOf({ 'First Name': "o'brien" }), "O'Brien");
  assert.strictEqual(t.firstNameOf({ 'First Name': 'José' }), 'José');
});

test('junk first names are rejected so the fallback copy is used', () => {
  const junk = ['', '   ', 'info', 'Sales', 'A', 'j@example.com', 'Kitchen Design LLC',
    'Team', '1234', 'Maple Ridge Kitchens', 'a-very-long-scraped-string-here'];
  for (const value of junk) {
    assert.strictEqual(t.firstNameOf({ 'First Name': value }), null, `"${value}" should be rejected`);
  }
});

test('a first name equal to the company name is rejected', () => {
  assert.strictEqual(t.firstNameOf({ 'First Name': 'Acme', 'Company Name': 'Acme' }), null);
});

test('legal suffixes are stripped from the subject line', () => {
  assert.strictEqual(t.companyOf({ 'Company Name': 'Maple Ridge Kitchens, LLC' }), 'Maple Ridge Kitchens');
  assert.strictEqual(t.companyOf({ 'Company Name': 'Bath Pros Inc.' }), 'Bath Pros');
  assert.strictEqual(t.companyOf({ 'Company Name': 'Cucina Ltd' }), 'Cucina');
  assert.strictEqual(t.companyOf({ 'Company Name': 'Kitchens & Baths' }), 'Kitchens & Baths');
});

test('with neither name the copy still reads like a sentence', () => {
  const body = t.buildMessage('email1', {}, CFG).textBody;
  assert.ok(body.startsWith('Quick question for your team—when you guys send out a quote'), body.slice(0, 120));
  assert.strictEqual(t.buildMessage('email1', {}, CFG).subject, 'quick question');
});

test('follow-ups greet generically when there is no usable first name', () => {
  assert.ok(t.buildMessage('followup1', { 'Company Name': 'X' }, CFG).textBody.startsWith('Hey there,'));
  assert.ok(t.buildMessage('followup2', { 'Company Name': 'X' }, CFG).textBody.startsWith('Hey there,'));
});

/* ---------------------------------------------------- compliance & hygiene */

test('every touch carries the sender identity and postal address (CAN-SPAM)', () => {
  for (const touch of ['email1', 'followup1', 'followup2']) {
    const body = t.buildMessage(touch, lead({ threadSubject: 'x', messageId: '<a@b>' }), CFG).textBody;
    assert.ok(body.includes(CFG.senderName), `${touch} is missing the sender name`);
    assert.ok(body.includes(CFG.senderCompany), `${touch} is missing the company`);
    assert.ok(body.includes(CFG.senderPostalAddress), `${touch} is missing the postal address`);
    assert.ok(/reply "stop"/i.test(body), `${touch} is missing the opt-out instruction`);
  }
});

test('no touch contains a link or an HTML tag', () => {
  for (const touch of ['email1', 'followup1', 'followup2']) {
    const body = t.buildMessage(touch, lead({ threadSubject: 'x' }), CFG).textBody;
    assert.strictEqual(/https?:\/\//.test(body), false, `${touch} must not contain a URL`);
    assert.strictEqual(/<[a-z][^>]*>/i.test(body), false, `${touch} must be plain text`);
  }
});

test('bodies stay short enough to read on a phone on a job site', () => {
  for (const touch of ['email1', 'followup1', 'followup2']) {
    const body = t.buildMessage(touch, lead({ threadSubject: 'x' }), CFG).textBody;
    assert.ok(body.length < 900, `${touch} is ${body.length} chars — too long for cold outreach`);
  }
});

test('an unknown touch is a hard error, never a silently blank email', () => {
  assert.throws(() => t.buildMessage('followup3', lead(), CFG), /Unknown touch/);
});

test('quotes in a sender name cannot break the From header', () => {
  const msg = t.buildMessage('email1', lead(), Object.assign({}, CFG, { senderName: 'Nat "The Closer" M' }));
  assert.ok(msg.textBody.includes('Nat "The Closer" M'));
});
