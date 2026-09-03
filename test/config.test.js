'use strict';
/**
 * config.test.js — executes the real, shipped config nodes.
 *
 * These two nodes are the only place a user edits, and the only place that
 * touches the environment. So they get run for real: the code below is pulled
 * out of the built workflow JSON and executed with n8n's globals stubbed,
 * including the case that matters most — n8n Cloud, where reading `$env`
 * throws and the SETTINGS block is the only way in.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const W1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/workflow-1-outbound-dispatcher.json'), 'utf8'));
const W2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/workflow-2-inbound-listener.json'), 'utf8'));

const codeOf = (wf, name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

/** An n8n instance that allows env access. */
const envAllowing = (vars) => new Proxy(vars || {}, {});

/** n8n Cloud: any read of $env throws. */
const envBlocking = () => new Proxy({}, {
  get() { throw new Error('Access to env vars is blocked in this n8n instance'); }
});

/** Overwrite one key inside the node's SETTINGS block, as a user would. */
function withSettings(code, values) {
  let out = code;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`(\\n\\s*${key}:\\s*)'[^']*'`);
    assert.ok(re.test(out), `SETTINGS key "${key}" not found in the node`);
    out = out.replace(re, `$1'${value}'`);
  }
  return out;
}

/** Run a config node with stubbed n8n globals. */
function run(code, { env = envBlocking(), input = [] } = {}) {
  const $input = { all: () => input.map((json) => ({ json })) };
  const fn = new Function('$env', '$input', 'console', code);
  return fn(env, $input, { log() {} });
}

const FULL = {
  AIRTABLE_BASE_ID: 'appTEST1234567890',
  SENDER_NAME: 'Nat Marlowe',
  SENDER_EMAIL: 'nat@example.com',
  SENDER_COMPANY: 'Marlowe Automations',
  SENDER_POSTAL_ADDRESS: '1200 W 6th St, Austin, TX 78703',
  MILLIONVERIFIER_API_KEY: 'mv_key_123'
};

/* ============================ Workflow 1 ============================ */

test('W1 config: both nodes expose a SETTINGS block a human can fill in', () => {
  for (const [wf, name] of [[W1, 'Init Config'], [W2, 'W2 Config']]) {
    const code = codeOf(wf, name);
    assert.ok(/FILL THIS IN/.test(code), `${name} has no fill-in banner`);
    assert.ok(/var SETTINGS = \{/.test(code), `${name} has no SETTINGS block`);
    assert.ok(/Nothing below this line needs editing/.test(code), `${name} has no end marker`);
    // It must be the first thing on screen, above the inlined libraries —
    // that is the whole point of the build's hoist step.
    const line = code.split('\n').findIndex((l) => l.includes('var SETTINGS')) + 1;
    assert.ok(line > 0 && line < 30,
      `${name}: SETTINGS is at line ${line}; it must be within the first 30 lines`);
  }
});

test('W1 config: works on n8n Cloud, where reading $env throws', () => {
  // The whole point of the SETTINGS block. If this passes, Cloud users need
  // no environment variables at all.
  const out = run(withSettings(codeOf(W1, 'Init Config'), FULL), { env: envBlocking() });
  const cfg = out[0].json.cfg;
  assert.strictEqual(cfg.baseId, 'appTEST1234567890');
  assert.strictEqual(cfg.senderEmail, 'nat@example.com');
  assert.strictEqual(cfg.millionVerifierKey, 'mv_key_123');
  assert.strictEqual(cfg.tableName, 'Leads');
});

test('W1 config: works on self-hosted n8n from environment variables alone', () => {
  const out = run(codeOf(W1, 'Init Config'), { env: envAllowing(FULL) });
  const cfg = out[0].json.cfg;
  assert.strictEqual(cfg.baseId, 'appTEST1234567890');
  assert.strictEqual(cfg.senderCompany, 'Marlowe Automations');
});

test('W1 config: a filled-in SETTINGS value beats the environment', () => {
  const code = withSettings(codeOf(W1, 'Init Config'), Object.assign({}, FULL, {
    AIRTABLE_BASE_ID: 'appFROM_SETTINGS'
  }));
  const out = run(code, { env: envAllowing({ AIRTABLE_BASE_ID: 'appFROM_ENV' }) });
  assert.strictEqual(out[0].json.cfg.baseId, 'appFROM_SETTINGS');
});

test('W1 config: an empty SETTINGS value falls through to the environment', () => {
  const out = run(withSettings(codeOf(W1, 'Init Config'), FULL), {
    env: envAllowing({ DAILY_SEND_CAP: '7', CAMPAIGN_TIMEZONE: 'Europe/London' })
  });
  assert.strictEqual(out[0].json.cfg.dailyCap, 7);
  assert.strictEqual(out[0].json.cfg.timeZone, 'Europe/London');
});

test('W1 config: the defaults are the ones documented in the comments', () => {
  const cfg = run(withSettings(codeOf(W1, 'Init Config'), FULL))[0].json.cfg;
  assert.strictEqual(cfg.dailyCap, 30);
  assert.strictEqual(cfg.timeZone, 'America/New_York');
  assert.strictEqual(cfg.sendWindowStartHour, 8);
  assert.strictEqual(cfg.sendWindowEndHour, 18);
  assert.strictEqual(cfg.staggerMinMinutes, 15);
  assert.strictEqual(cfg.staggerMaxMinutes, 20);
  assert.strictEqual(cfg.allowRisky, false);
});

test('W1 config: DRY_RUN ships ON, so a first run cannot send by accident', () => {
  const out = run(withSettings(codeOf(W1, 'Init Config'), FULL));
  assert.strictEqual(out[0].json.cfg.dryRun, true);
});

test('W1 config: DRY_RUN can be turned off to go live', () => {
  const code = withSettings(codeOf(W1, 'Init Config'), Object.assign({}, FULL, { DRY_RUN: 'false' }));
  assert.strictEqual(run(code)[0].json.cfg.dryRun, false);
});

test('W1 config: an incomplete setup fails with a message that names each gap', () => {
  assert.throws(
    () => run(codeOf(W1, 'Init Config')),
    (err) => {
      assert.match(err.message, /Init Config/);
      assert.match(err.message, /SETTINGS block/);
      assert.match(err.message, /AIRTABLE_BASE_ID/);
      assert.match(err.message, /SENDER_EMAIL/);
      assert.match(err.message, /MILLIONVERIFIER_API_KEY/);
      assert.match(err.message, /SENDER_POSTAL_ADDRESS/);
      assert.match(err.message, /Nothing was sent/);
      return true;
    }
  );
});

test('W1 config: nonsensical numbers are rejected before anything is sent', () => {
  const bad = [
    { DAILY_SEND_CAP: '0' },
    { DAILY_SEND_CAP: '5000' },
    { STAGGER_MIN_MINUTES: '30', STAGGER_MAX_MINUTES: '10' },
    { SEND_WINDOW_START_HOUR: '18', SEND_WINDOW_END_HOUR: '8' }
  ];
  for (const overrides of bad) {
    assert.throws(
      () => run(withSettings(codeOf(W1, 'Init Config'), Object.assign({}, FULL, overrides))),
      /SETTINGS block/,
      JSON.stringify(overrides)
    );
  }
});

test('W1 config: the From header is built correctly, quotes and all', () => {
  const out = run(withSettings(codeOf(W1, 'Init Config'), FULL));
  assert.strictEqual(out[0].json.cfg.fromHeader, '"Nat Marlowe" <nat@example.com>');
});

test('W1 config: the cap is trimmed to what fits before the window closes', () => {
  // 30 leads x 20 min worst case needs ~9h40m of runway.
  const out = run(withSettings(codeOf(W1, 'Init Config'), FULL));
  const j = out[0].json;
  assert.ok(j.effectiveCap <= j.cfg.dailyCap);
  if (j.inSendWindow) {
    const fits = Math.floor(j.secondsLeftInWindow / (j.cfg.staggerMaxMinutes * 60)) + 1;
    assert.strictEqual(j.effectiveCap, Math.min(j.cfg.dailyCap, fits));
  } else {
    assert.strictEqual(j.shouldRun, false);
    assert.match(j.haltReason, /send window|business day/);
  }
});

/* ============================ Workflow 2 ============================ */

test('W2 config: works on Cloud and passes the inbound email through', () => {
  const code = withSettings(codeOf(W2, 'W2 Config'), { AIRTABLE_BASE_ID: 'appTEST1234567890' });
  const email = { from: 'dana@example.com', subject: 'Re: quick question', text: 'sounds good' };
  const out = run(code, { env: envBlocking(), input: [email] });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].json.subject, 'Re: quick question', 'the email must survive this node');
  assert.strictEqual(out[0].json.text, 'sounds good');
  assert.strictEqual(out[0].json.cfg.baseId, 'appTEST1234567890');
});

test('W2 config: several inbound emails all pass through', () => {
  const code = withSettings(codeOf(W2, 'W2 Config'), { AIRTABLE_BASE_ID: 'app1' });
  const out = run(code, { input: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.deepStrictEqual(out.map((i) => i.json.id), [1, 2, 3]);
});

test('W2 config: a missing base id points at the SETTINGS block and Workflow 1', () => {
  assert.throws(
    () => run(codeOf(W2, 'W2 Config'), { input: [{}] }),
    (err) => {
      assert.match(err.message, /W2 Config/);
      assert.match(err.message, /SETTINGS block/);
      assert.match(err.message, /Workflow 1/);
      return true;
    }
  );
});

test('W2 config: half-configured SMS is caught rather than failing at send time', () => {
  const code = withSettings(codeOf(W2, 'W2 Config'), {
    AIRTABLE_BASE_ID: 'app1',
    SMS_ENABLED: 'true',
    TWILIO_ACCOUNT_SID: 'AC123'
    // FROM and TO deliberately left blank
  });
  assert.throws(() => run(code, { input: [{}] }), /SMS_ENABLED is true but/);
});

test('W2 config: SMS off by default, and fully-configured SMS is accepted', () => {
  const off = withSettings(codeOf(W2, 'W2 Config'), { AIRTABLE_BASE_ID: 'app1' });
  assert.strictEqual(run(off, { input: [{}] })[0].json.cfg.twilioEnabled, false);

  const on = withSettings(codeOf(W2, 'W2 Config'), {
    AIRTABLE_BASE_ID: 'app1',
    SMS_ENABLED: 'true',
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_FROM_NUMBER: '+15125550100',
    SMS_ALERT_TO_NUMBER: '+15125550199'
  });
  assert.strictEqual(run(on, { input: [{}] })[0].json.cfg.twilioEnabled, true);
});

test('the two workflows agree on the table name default', () => {
  const w1 = run(withSettings(codeOf(W1, 'Init Config'), FULL))[0].json.cfg;
  const w2 = run(withSettings(codeOf(W2, 'W2 Config'), { AIRTABLE_BASE_ID: 'app1' }), { input: [{}] })[0].json.cfg;
  assert.strictEqual(w1.tableName, w2.tableName);
  assert.strictEqual(w1.airtableApiBase, w2.airtableApiBase);
});
