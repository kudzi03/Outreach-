'use strict';
const test = require('node:test');
const assert = require('node:assert');
const t = require('../src/lib/templates.js');

// The shipped default: a sender with no track record yet.
const CFG = {
  senderName: 'Nat Marlowe',
  senderCompany: 'Marlowe Automations',
  senderPostalAddress: '1200 W 6th St, Austin, TX 78703',
  remodelersInterviewed: 0,
  remodelerClients: 0
};

/** A sender who has done the conversations and has customers. */
const PROVEN = Object.assign({}, CFG, { remodelersInterviewed: 12, remodelerClients: 2 });

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

test('Follow-up 1 keeps the Tuesday/Wednesday/Friday detail whatever the claims', () => {
  for (const cfg of [CFG, PROVEN]) {
    const body = t.buildMessage('followup1', lead(), cfg).textBody;
    assert.ok(body.startsWith('Hey Dana — reason I ask:'), body.slice(0, 60));
    // The one line a remodeler recognizes as their own week.
    assert.ok(body.includes('Tuesday'));
    assert.ok(body.includes('job site Wednesday'));
    assert.ok(body.includes('by Friday'));
  }
});

test('Follow-up 1 asks rather than asserts when there are no interviews behind it', () => {
  const body = t.buildMessage('followup1', lead(), CFG).textBody;
  assert.ok(body.includes("I'd guess"), 'the detail must be framed as a guess');
  assert.ok(body.includes('Wrong, or about right?'));
  assert.strictEqual(/most guys/i.test(body), false, 'that claim is not earned yet');
});

test('Follow-up 1 speaks with authority once the conversations are real', () => {
  const body = t.buildMessage('followup1', lead(), PROVEN).textBody;
  assert.ok(body.includes('most guys I talk to say'));
  assert.ok(body.includes('Is that you, or have you got it handled?'));
});

test('Follow-up 2 breaks up without the two most-recognized closers', () => {
  for (const cfg of [CFG, PROVEN]) {
    const body = t.buildMessage('followup2', lead(), cfg).textBody;
    assert.ok(body.startsWith('Hey Dana — last one from me.'));
    assert.ok(body.includes('60-second video'));
    assert.strictEqual(/guessing (either )?your pipeline/i.test(body), false,
      'the false either/or is a template tell');
    assert.strictEqual(/stop bugging you/i.test(body), false,
      'the single most-used closer in cold email');
  }
});

test('Follow-up 2 names exactly as many customers as there are', () => {
  const offer = (clients) => t.buildMessage('followup2', lead(),
    Object.assign({}, CFG, { remodelerClients: clients })).textBody;

  assert.ok(offer(0).includes('video of how it works'));
  assert.strictEqual(/remodeler[s]? set up/.test(offer(0)), false,
    'with no customers the copy must not reference any');

  assert.ok(offer(1).includes('what another remodeler set up'));
  assert.ok(offer(2).includes('what two other remodelers set up'));
  assert.ok(offer(7).includes('what a few other remodelers set up'));
});

test('a garbled claim count is treated as zero, never as proof', () => {
  for (const value of [undefined, null, '', 'lots', -3, NaN, 'two']) {
    const body = t.buildMessage('followup2', lead(),
      Object.assign({}, CFG, { remodelerClients: value })).textBody;
    assert.ok(body.includes('how it works'), `remodelerClients=${String(value)} must claim nothing`);
  }
  const fu1 = t.buildMessage('followup1', lead(),
    Object.assign({}, CFG, { remodelersInterviewed: 'a bunch' })).textBody;
  assert.ok(fu1.includes("I'd guess"));
});

test('a follow-up is SHORTER than the opener — the thread already has the context', () => {
  const strip = (touch) => t.buildMessage(touch, lead({
    threadSubject: 'quick question / Maple Ridge Kitchens', messageId: '<a@b>'
  }), CFG).textBody.split('\n\n--')[0];

  const t1 = strip('email1').length;
  const fu1 = strip('followup1').length;
  const fu2 = strip('followup2').length;

  assert.ok(fu1 < 260, `follow-up 1 is ${fu1} chars — a bump must stay short`);
  assert.ok(fu2 < 200, `follow-up 2 is ${fu2} chars`);
  assert.ok(fu2 < fu1, 'the break-up should be the shortest message of the three');
  assert.ok(t1 < 200, `the opener is ${t1} chars`);
});

test('HONESTY: with nothing to point to, no touch asserts a track record', () => {
  // The default configuration. If a future rewrite slips an unearned claim
  // into any of the three emails, this fails before it reaches a prospect.
  const UNSUPPORTED = [
    /most (guys|of the|remodelers|contractors)/i,
    /(other|another) remodeler/i,
    /\b(two|three|several|dozens|hundreds) of (my|our)\b/i,
    /(my|our) (clients|customers)\b/i,
    /we('ve| have) (helped|worked with|built)/i,
    /i('ve| have) (helped|worked with|built) \d/i,
    /case study|testimonial/i,
    /trusted by/i,
    /\d+\s*(\+)?\s*(remodelers|contractors|companies|clients|customers)/i,
    /guarantee/i,
    /proven/i,
    /\d+% (more|increase|growth|of)/i
  ];
  for (const touch of ['email1', 'followup1', 'followup2']) {
    const body = t.buildMessage(touch, lead({ threadSubject: 'x', messageId: '<a@b>' }), CFG).textBody;
    for (const pattern of UNSUPPORTED) {
      assert.strictEqual(pattern.test(body), false,
        `${touch} makes an unsupported claim (${pattern}):\n${body}`);
    }
  }
});

test('HONESTY: the opener never claimed anything, at any setting', () => {
  // Touch 1 only asks a question, so it must be byte-identical either way.
  assert.strictEqual(
    t.buildMessage('email1', lead(), CFG).textBody,
    t.buildMessage('email1', lead(), PROVEN).textBody
  );
});

test('proofOf floors, truncates and rejects nonsense', () => {
  assert.deepStrictEqual(t.proofOf({ remodelersInterviewed: 3.9, remodelerClients: '2' }),
    { interviewed: 3, clients: 2 });
  assert.deepStrictEqual(t.proofOf({}), { interviewed: 0, clients: 0 });
  assert.deepStrictEqual(t.proofOf(), { interviewed: 0, clients: 0 });
  assert.deepStrictEqual(t.proofOf({ remodelersInterviewed: -5, remodelerClients: 'many' }),
    { interviewed: 0, clients: 0 });
});

test('no touch uses a phrase that reads as template filler', () => {
  // If a rewrite ever reintroduces one of these, this fails. They are the
  // phrases a contractor who gets ten of these a week recognizes instantly.
  const SLOP = [
    /hope (this|you)('| a)?\s*(email|message)?\s*finds you/i,
    /i wanted to reach out/i,
    /i came across/i,
    /i noticed (that )?your/i,
    /circling back/i,
    /bumping this/i,
    /just following up/i,
    /touch(ing)? base/i,
    /at your earliest convenience/i,
    /game.?changer/i,
    /revolutioni[sz]e/i,
    /seamless/i,
    /leverage/i,
    /in today'?s (fast|competitive|digital)/i,
    /impressed by/i,
    /love what you'?re doing/i,
    /i'?m guessing (either )?your/i,
    /synerg/i,
    /cutting.?edge/i,
    /best.?in.?class/i
  ];
  for (const touch of ['email1', 'followup1', 'followup2']) {
    const body = t.buildMessage(touch, lead({ threadSubject: 'x', messageId: '<a@b>' }), CFG).textBody;
    for (const pattern of SLOP) {
      assert.strictEqual(pattern.test(body), false, `${touch} contains template filler: ${pattern}`);
    }
  }
});

test('follow-ups read as a thread reply, not a fresh mail merge', () => {
  // With no usable first name a bump must NOT open on a generic greeting —
  // "Hey there," on a reply is the giveaway. It opens on the sentence instead.
  for (const touch of ['followup1', 'followup2']) {
    const body = t.buildMessage(touch, { 'Company Name': 'X', threadSubject: 'x' }, CFG).textBody;
    assert.strictEqual(/^hey there/i.test(body), false, `${touch} falls back to "Hey there,"`);
    assert.strictEqual(/^(hi|hello|dear)\b/i.test(body), false, `${touch} opens on a generic greeting`);
    assert.ok(/^[A-Z]/.test(body), `${touch} should start with a capital: ${body.slice(0, 40)}`);
  }
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

test('follow-ups use the first name when there is one', () => {
  assert.ok(t.buildMessage('followup1', lead(), CFG).textBody.startsWith('Hey Dana — '));
  assert.ok(t.buildMessage('followup2', lead(), CFG).textBody.startsWith('Hey Dana — '));
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
    assert.ok(body.length < 500, `${touch} is ${body.length} chars including the footer`);
  }
});

test('an unknown touch is a hard error, never a silently blank email', () => {
  assert.throws(() => t.buildMessage('followup3', lead(), CFG), /Unknown touch/);
});

test('quotes in a sender name cannot break the From header', () => {
  const msg = t.buildMessage('email1', lead(), Object.assign({}, CFG, { senderName: 'Nat "The Closer" M' }));
  assert.ok(msg.textBody.includes('Nat "The Closer" M'));
});
