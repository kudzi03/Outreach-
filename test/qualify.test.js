'use strict';
const test = require('node:test');
const assert = require('node:assert');
const q = require('../src/lib/qualify.js');

/* ------------------------------------------------------- finding the site */

test('a Website column wins, and is normalized to a URL', () => {
  assert.strictEqual(q.resolveUrl({ Website: 'mapleridge.com' }).url, 'https://mapleridge.com');
  assert.strictEqual(q.resolveUrl({ Website: 'http://mapleridge.com' }).url, 'http://mapleridge.com');
  assert.strictEqual(q.resolveUrl({ Website: 'www.mapleridge.com/about' }).url, 'https://www.mapleridge.com/about');
  assert.strictEqual(q.resolveUrl({ Website: 'mapleridge.com/a#top' }).url, 'https://mapleridge.com/a');
});

test('the email domain is the fallback', () => {
  const r = q.resolveUrl({ Email: 'Dana@MapleRidgeKitchens.com' });
  assert.strictEqual(r.url, 'https://mapleridgekitchens.com');
  assert.strictEqual(r.source, 'email-domain');
});

test('a free mailbox is not guessable and is never treated as a rejection', () => {
  for (const email of ['a@gmail.com', 'a@yahoo.com', 'a@outlook.com', 'a@aol.com', 'a@comcast.net']) {
    const r = q.resolveUrl({ Email: email });
    assert.strictEqual(r.url, null, email);
    assert.strictEqual(r.source, 'freemail');
    assert.match(r.reason, /Free mailbox/);
  }
  assert.strictEqual(q.isFreemail('dana@mapleridgekitchens.com'), false);
});

test('junk in the Website column falls back cleanly rather than fetching nonsense', () => {
  assert.strictEqual(q.resolveUrl({ Website: 'n/a' }).url, null);
  assert.strictEqual(q.resolveUrl({ Website: 'none' }).url, null);
  assert.strictEqual(q.resolveUrl({}).url, null);
  assert.strictEqual(q.resolveUrl({ Email: 'not-an-email' }).url, null);
});

/* ------------------------------------------------------------ page reading */

test('HTML is reduced to the text that carries signal', () => {
  const page = q.htmlToText(`
    <html><head>
      <title>Maple Ridge Kitchens</title>
      <meta name="description" content="Full kitchen and bath remodels in Austin">
      <style>body{color:red}</style>
    </head><body>
      <script>window.analytics = 1;</script>
      <svg><path d="M0 0"/></svg>
      <h1>Kitchen &amp; Bath Remodeling</h1>
      <p>We handle design through install.</p>
      <!-- a comment -->
    </body></html>`);

  assert.strictEqual(page.title, 'Maple Ridge Kitchens');
  assert.strictEqual(page.description, 'Full kitchen and bath remodels in Austin');
  assert.ok(page.text.includes('Kitchen & Bath Remodeling'));
  assert.ok(page.text.includes('design through install'));
  // The bytes that are all cost and no signal must be gone.
  assert.strictEqual(page.text.includes('window.analytics'), false);
  assert.strictEqual(page.text.includes('color:red'), false);
  assert.strictEqual(page.text.includes('M0 0'), false);
  assert.strictEqual(page.text.includes('a comment'), false);
});

test('page text is truncated to the configured budget', () => {
  const page = q.htmlToText('<p>' + 'word '.repeat(5000) + '</p>', 500);
  assert.strictEqual(page.text.length, 500);
  assert.strictEqual(page.truncated, true);
});

test('parked, empty and placeholder pages are not sent to the model', () => {
  assert.strictEqual(q.isUsablePage(q.htmlToText('<p>hi</p>')), false);
  assert.strictEqual(q.isUsablePage(q.htmlToText('')), false);
  assert.strictEqual(q.isUsablePage(null), false);
  assert.strictEqual(
    q.isUsablePage(q.htmlToText('<p>' + 'This domain is for sale. '.repeat(20) + '</p>')),
    false
  );
  assert.strictEqual(
    q.isUsablePage(q.htmlToText('<p>' + 'We remodel kitchens and bathrooms in Austin. '.repeat(10) + '</p>')),
    true
  );
});

/* -------------------------------------------------------------- the prompt */

test('the prompt asks only factual questions and forbids invention', () => {
  const p = q.QL_SYSTEM_PROMPT;
  assert.ok(p.includes('KITCHEN AND BATH REMODELING CONTRACTORS'));
  assert.ok(/never invent details/i.test(p));
  assert.ok(/Judge ONLY from the text shown/i.test(p));
  assert.ok(/wrong "Yes" wastes a send/i.test(p));
  // It must never be asked to write anything that reaches a prospect.
  assert.strictEqual(/write|draft|compose|personali[sz]e|subject line|opening line/i.test(p), false,
    'the qualifier must never be asked to produce copy');
});

test('the request is built for a cheap classification, not a reasoning task', () => {
  const page = q.htmlToText('<p>' + 'We remodel kitchens. '.repeat(30) + '</p>');
  const req = q.buildClaudeRequest(page, {
    'Company Name': 'Maple Ridge Kitchens', City: 'Austin', qualifyUrl: 'https://x.com'
  }, {});
  assert.strictEqual(req.model, 'claude-sonnet-5');
  assert.strictEqual(req.output_config.effort, 'low');
  assert.ok(req.max_tokens >= 1000);
  assert.strictEqual(req.messages.length, 1);
  assert.strictEqual(req.messages[0].role, 'user');
  assert.ok(req.messages[0].content.includes('Maple Ridge Kitchens'));
  assert.ok(req.messages[0].content.includes('--- BEGIN PAGE TEXT ---'));
});

test('the model can be overridden', () => {
  const page = q.htmlToText('<p>' + 'x '.repeat(200) + '</p>');
  const req = q.buildClaudeRequest(page, {}, { model: 'claude-haiku-4-5', effort: 'medium' });
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.strictEqual(req.output_config.effort, 'medium');
});

/* ------------------------------------------------------ reading the answer */

const reply = (obj, extra) => Object.assign({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  usage: { input_tokens: 1500, output_tokens: 80 }
}, extra);

test('a clean verdict is parsed in full', () => {
  const v = q.parseVerdict(reply({
    fit: 'Yes', category: 'kitchen_bath_remodeler', size: 'small_team',
    does_kitchens: true, does_baths: true, has_existing_crm: false,
    reason: 'Site advertises full kitchen and bath remodels with install'
  }));
  assert.strictEqual(v.fit, 'Yes');
  assert.strictEqual(v.category, 'kitchen_bath_remodeler');
  assert.strictEqual(v.size, 'small_team');
  assert.strictEqual(v.doesKitchens, true);
  assert.strictEqual(v.hasExistingCrm, false);
  assert.strictEqual(v.inputTokens, 1500);
  assert.strictEqual(v.ok, true);
});

test('thinking blocks and code fences do not break parsing', () => {
  const v = q.parseVerdict({
    content: [
      { type: 'thinking', thinking: 'Let me consider the page...' },
      { type: 'text', text: '```json\n{"fit":"No","category":"other_trade","reason":"Roofing company"}\n```' }
    ],
    usage: { input_tokens: 900, output_tokens: 40 }
  });
  assert.strictEqual(v.fit, 'No');
  assert.strictEqual(v.category, 'other_trade');
});

test('JSON wrapped in prose is still extracted', () => {
  const v = q.parseVerdict({
    content: [{ type: 'text', text: 'Here is my answer:\n{"fit":"Unsure","reason":"Thin page"}\nHope that helps.' }]
  });
  assert.strictEqual(v.fit, 'Unsure');
});

test('nested braces inside strings do not confuse the extractor', () => {
  const v = q.parseVerdict({
    content: [{ type: 'text', text: '{"fit":"Yes","reason":"Page says \\"we handle {everything}\\" end to end"}' }]
  });
  assert.strictEqual(v.fit, 'Yes');
  assert.ok(v.reason.includes('everything'));
});

test('unknown enum values degrade to "unknown" without losing the verdict', () => {
  const v = q.parseVerdict(reply({ fit: 'Yes', category: 'space_pirate', size: 'enormous', reason: 'x' }));
  assert.strictEqual(v.fit, 'Yes');
  assert.strictEqual(v.category, 'unknown');
  assert.strictEqual(v.size, 'unknown');
});

/* ------------------------------------------ FAIL-OPEN: never a false "No" */

test('FAIL-OPEN: every failure path resolves to Unsure, never No', () => {
  const failures = [
    ['API unreachable', q.parseVerdict(null, { httpError: 'ETIMEDOUT' })],
    ['API error object', q.parseVerdict({ type: 'error', error: { message: 'overloaded' } })],
    ['model refusal', q.parseVerdict({ stop_reason: 'refusal', content: [] })],
    ['no JSON at all', q.parseVerdict({ content: [{ type: 'text', text: 'I cannot tell.' }] })],
    ['malformed JSON', q.parseVerdict({ content: [{ type: 'text', text: '{"fit": ' }] })],
    ['unknown verdict', q.parseVerdict(reply({ fit: 'Maybe', reason: 'x' }))],
    ['empty content', q.parseVerdict({ content: [] })],
    ['thinking only', q.parseVerdict({ content: [{ type: 'thinking', thinking: 'hmm' }] })]
  ];
  for (const [label, v] of failures) {
    assert.strictEqual(v.fit, 'Unsure', `${label} must not produce a verdict`);
    assert.notStrictEqual(v.fit, 'No', `${label} must never reject a lead`);
    assert.strictEqual(v.ok, false);
    assert.ok(v.reason.length > 0, `${label} should say why`);
  }
});

test('a rejection is only ever produced by an explicit model "No"', () => {
  assert.strictEqual(q.parseVerdict(reply({ fit: 'No', category: 'handyman', reason: 'Odd jobs' })).fit, 'No');
  assert.strictEqual(q.parseVerdict(reply({ fit: 'no', reason: 'x' })).fit, 'No', 'case-insensitive');
});

/* ---------------------------------------------------------------- queueing */

let seq = 0;
const rec = (fields, id) => ({
  id: id || `rec${++seq}`,
  fields: Object.assign({ Email: `lead${seq}@company${seq}.com` }, fields)
});

test('the per-run cap is enforced', () => {
  const records = Array.from({ length: 200 }, () => rec({}));
  const out = q.buildQualifyQueue(records, { perRunCap: 50 });
  assert.strictEqual(out.queue.length, 50);
  assert.strictEqual(out.skipped.filter((s) => /per-run cap/.test(s.reason)).length, 150);
});

test('two contacts at one company cost one page fetch, not two', () => {
  const out = q.buildQualifyQueue([
    rec({ Email: 'dana@mapleridge.com' }, 'recA'),
    rec({ Email: 'sam@mapleridge.com' }, 'recB'),
    rec({ Email: 'lee@other.com' }, 'recC')
  ], {});
  assert.strictEqual(out.queue.length, 2);
  const dupe = out.skipped.find((s) => s.recordId === 'recB');
  assert.strictEqual(dupe.duplicateOf, 'recA');
});

test('free-mailbox leads are flagged unresolvable, not queued or rejected', () => {
  const out = q.buildQualifyQueue([rec({ Email: 'dana@gmail.com' }, 'recX')], {});
  assert.strictEqual(out.queue.length, 0);
  const skip = out.skipped[0];
  assert.strictEqual(skip.recordId, 'recX');
  assert.strictEqual(skip.unresolvable, true);
  assert.strictEqual(skip.fit, 'Unsure', 'must be recorded as Unsure, never No');
});

test('the queue carries everything the fetch and the prompt need', () => {
  const out = q.buildQualifyQueue([rec({
    Email: 'dana@mapleridge.com', 'Company Name': 'Maple Ridge', City: 'Austin'
  })], {});
  const item = out.queue[0];
  assert.strictEqual(item.qualifyUrl, 'https://mapleridge.com');
  assert.strictEqual(item.host, 'mapleridge.com');
  assert.strictEqual(item.companyName, 'Maple Ridge');
  assert.strictEqual(item.city, 'Austin');
  assert.strictEqual(item.position, 1);
});

test('an empty input is not an error', () => {
  assert.deepStrictEqual(q.buildQualifyQueue([], {}).queue, []);
  assert.deepStrictEqual(q.buildQualifyQueue(null, {}).queue, []);
});

/* ------------------------------------------------------- fetch formula */

test('only unjudged AND uncontacted leads are fetched', () => {
  const f = q.qualifyFetchFormula();
  assert.ok(f.includes('{Fit} = ""'));
  assert.ok(f.includes('{Fit} = "Unchecked"'));
  // Re-judging someone mid-sequence changes nothing and costs money.
  assert.ok(f.includes('{Status} = "New"'));
  assert.strictEqual(f.includes('Sent Email 1'), false);
});

/* ------------------------------------------------------------------ cost */

test('the cost estimate matches published Sonnet 5 rates', () => {
  // 1M input + 1M output at $2 / $10.
  assert.strictEqual(q.estimateCost(1e6, 0), 2);
  assert.strictEqual(q.estimateCost(0, 1e6), 10);
  // A realistic page: ~1.5k in, ~80 out.
  const per1000 = q.estimateCost(1500, 80) * 1000;
  assert.ok(per1000 > 3 && per1000 < 5, `$${per1000.toFixed(2)} per 1,000 leads`);
});
