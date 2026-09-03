'use strict';
const test = require('node:test');
const assert = require('node:assert');
const v = require('../src/lib/verify.js');

test('the request URL is well-formed and escapes the address', () => {
  const url = v.verifyUrl('KEY 1', 'a+b@example.com', 20);
  assert.ok(url.startsWith('https://api.millionverifier.com/api/v3/?api=KEY%201'));
  assert.ok(url.includes('email=a%2Bb%40example.com'));
  assert.ok(url.includes('timeout=20'));
});

test('looksLikeEmail rejects the junk that would waste a credit', () => {
  assert.strictEqual(v.looksLikeEmail('dana@example.com'), true);
  for (const bad of ['', 'dana', 'dana@', '@example.com', 'dana @example.com', 'dana@example', null]) {
    assert.strictEqual(v.looksLikeEmail(bad), false, `${bad} should be rejected`);
  }
});

test('"ok" is Valid and sends', () => {
  const r = v.mapVerification({ result: 'ok', resultcode: 1 }, {});
  assert.strictEqual(r.verificationStatus, 'Valid');
  assert.strictEqual(r.decision, 'send');
});

test('catch_all and unknown are Risky and halt by default', () => {
  for (const result of ['catch_all', 'unknown']) {
    const r = v.mapVerification({ result }, {});
    assert.strictEqual(r.verificationStatus, 'Risky');
    assert.strictEqual(r.decision, 'halt', 'the brief halts on Risky');
  }
});

test('ALLOW_RISKY=true sends to Risky addresses but still records them as Risky', () => {
  const r = v.mapVerification({ result: 'catch_all' }, { allowRisky: true });
  assert.strictEqual(r.verificationStatus, 'Risky');
  assert.strictEqual(r.decision, 'send');
});

test('invalid and disposable are Invalid and halt', () => {
  for (const result of ['invalid', 'disposable']) {
    const r = v.mapVerification({ result }, { allowRisky: true });
    assert.strictEqual(r.verificationStatus, 'Invalid');
    assert.strictEqual(r.decision, 'halt');
  }
});

test('an unrecognized result fails closed', () => {
  const r = v.mapVerification({ result: 'something_new' }, {});
  assert.strictEqual(r.verificationStatus, 'Invalid');
  assert.strictEqual(r.decision, 'halt');
});

test('a verifier OUTAGE defers the lead and never marks it Invalid', () => {
  // The expensive failure mode: an API blip burning good leads permanently.
  const cases = [
    v.mapVerification(null, { httpError: 'ECONNRESET' }),
    v.mapVerification({ error: 'Not enough credits' }, {}),
    v.mapVerification({ result: 'error' }, {}),
    v.mapVerification({}, {}),
    v.mapVerification('garbage', {})
  ];
  for (const r of cases) {
    assert.strictEqual(r.decision, 'pending', JSON.stringify(r));
    assert.strictEqual(r.verificationStatus, null, 'status must stay untouched');
  }
});

test('an already-Valid lead is not re-verified on follow-ups', () => {
  assert.strictEqual(v.needsVerification({ verificationStatus: 'Valid' }, {}), false);
  assert.strictEqual(v.needsVerification({ verificationStatus: 'valid' }, {}), false);
  assert.strictEqual(v.needsVerification({ verificationStatus: '' }, {}), true);
  assert.strictEqual(v.needsVerification({}, {}), true);
});

test('a Risky lead is re-verified unless risky sends are allowed', () => {
  assert.strictEqual(v.needsVerification({ verificationStatus: 'Risky' }, {}), true);
  assert.strictEqual(v.needsVerification({ verificationStatus: 'Risky' }, { allowRisky: true }), false);
});

test('FORCE_REVERIFY overrides the cache', () => {
  assert.strictEqual(v.needsVerification({ verificationStatus: 'Valid' }, { forceReverify: true }), true);
});
