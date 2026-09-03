'use strict';
/**
 * workflows.test.js — assertions about the shipped n8n JSON itself.
 *
 * These are the checks that a unit test of the libraries cannot make: that the
 * node graph actually wires the safety logic in, that credentials are declared,
 * and that the committed JSON has not drifted from src/.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const W1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/workflow-1-outbound-dispatcher.json'), 'utf8'));
const W2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/workflow-2-inbound-listener.json'), 'utf8'));
const W3 = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/workflow-3-lead-qualifier.json'), 'utf8'));

const nodeNames = (wf) => wf.nodes.map((n) => n.name);
const byName = (wf, name) => wf.nodes.find((n) => n.name === name);
const targetsOf = (wf, name, out = 0) =>
  (((wf.connections[name] || {}).main || [])[out] || []).map((l) => l.node);

test('the committed workflow JSON is in sync with src/', () => {
  // Runs the real build in --check mode. If this fails, run `npm run build`.
  execFileSync(process.execPath, [path.join(ROOT, 'build/build.js'), '--check'], { stdio: 'pipe' });
});

test('both workflows parse and carry the expected node counts', () => {
  assert.ok(W1.nodes.length > 25);
  assert.ok(W2.nodes.length > 15);
  assert.strictEqual(W1.settings.executionOrder, 'v1');
  assert.strictEqual(W2.settings.executionOrder, 'v1');
});

test('no Code node still contains an uninjected placeholder', () => {
  for (const wf of [W1, W2, W3]) {
    for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
      assert.ok(node.parameters.jsCode, `${node.name} has no code`);
      assert.strictEqual(/@@code:/.test(node.parameters.jsCode), false, `${node.name} was not injected`);
      assert.ok(node.parameters.jsCode.includes('GENERATED'), `${node.name} is missing its provenance banner`);
    }
  }
});

test('every Code node body is syntactically valid', () => {
  for (const wf of [W1, W2, W3]) {
    for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(
        () => new Function(`return (async () => {\n${node.parameters.jsCode}\n});`),
        `${node.name} does not parse`
      );
    }
  }
});

/* ------------------------------------------------- Workflow 1 structure */

test('W1: the schedule trigger only fires on weekdays', () => {
  const trigger = byName(W1, 'Every Business Day 08:00');
  assert.strictEqual(trigger.parameters.rule.interval[0].expression, '0 8 * * 1-5');
});

test('W1: the schema engine runs before any lead is fetched', () => {
  assert.deepStrictEqual(targetsOf(W1, 'Get Base Schema'), ['Plan Schema Changes']);
  assert.deepStrictEqual(targetsOf(W1, 'Schema Report'), ['Plan Lead Fetch']);
  assert.deepStrictEqual(targetsOf(W1, 'Plan Lead Fetch'), ['Fetch Candidate Leads']);
  assert.deepStrictEqual(targetsOf(W1, 'Fetch Candidate Leads'), ['Build Send Queue']);
});

test('W1: the schema branch is a loop, so nothing downstream can run twice', () => {
  // Regression guard. Converging both IF branches on Schema Report made it
  // execute once per branch, which fetched, queued and SENT the batch twice.
  const loop = byName(W1, 'Loop Schema Changes');
  assert.strictEqual(loop.type, 'n8n-nodes-base.splitInBatches');
  assert.deepStrictEqual(targetsOf(W1, 'Plan Schema Changes'), ['Loop Schema Changes']);
  assert.deepStrictEqual(targetsOf(W1, 'Loop Schema Changes', 0), ['Schema Report']);
  assert.deepStrictEqual(targetsOf(W1, 'Loop Schema Changes', 1), ['Is a Change?']);
  assert.deepStrictEqual(targetsOf(W1, 'Is a Change?', 0), ['Apply Schema Change']);
  assert.deepStrictEqual(targetsOf(W1, 'Is a Change?', 1), ['Loop Schema Changes']);
  assert.deepStrictEqual(targetsOf(W1, 'Apply Schema Change'), ['Loop Schema Changes']);
});

test('W1: exactly one node feeds each stage of the main pipeline', () => {
  // Any node with two live predecessors executes twice under executionOrder v1.
  // These five must each have exactly one, or a run could double-send.
  const parents = (target) => Object.entries(W1.connections)
    .filter(([, c]) => (c.main || []).some((b) => (b || []).some((l) => l.node === target)))
    .map(([from]) => from);
  for (const stage of ['Schema Report', 'Plan Lead Fetch', 'Fetch Candidate Leads',
    'Build Send Queue', 'Any Leads Queued?']) {
    assert.strictEqual(parents(stage).length, 1, `${stage} has ${parents(stage).length} predecessors`);
  }
});

test('W1: the guard reads the Wait node, never the loop node', () => {
  // $('node').first() reads output branch 0, and on splitInBatches branch 0 is
  // "done" — empty mid-loop. Referencing the loop node here would silently
  // guard against the wrong record.
  const guard = byName(W1, 'Guard: Re-read & Re-check').parameters.jsCode;
  assert.ok(guard.includes("$('Stagger 15-20 min').first()"));
  assert.strictEqual(guard.includes("$('Loop Over Leads').first()"), false);

  const resolve = byName(W2, 'Resolve Match & Decide').parameters.jsCode;
  assert.strictEqual(resolve.includes("$('Loop Over Replies').first()"), false);
});

test('W1: SAFETY — the record is re-read after the stagger and before the guard', () => {
  // Order matters absolutely: wait -> re-read -> guard -> send.
  assert.deepStrictEqual(targetsOf(W1, 'Loop Over Leads', 1), ['Stagger 15-20 min']);
  assert.deepStrictEqual(targetsOf(W1, 'Stagger 15-20 min'), ['Re-read Lead Record']);
  assert.deepStrictEqual(targetsOf(W1, 'Re-read Lead Record'), ['Guard: Re-read & Re-check']);
  assert.deepStrictEqual(targetsOf(W1, 'Guard: Re-read & Re-check'), ['Guard Verdict']);
});

test('W1: nothing can reach the send node without passing the guard', () => {
  const sendPredecessors = new Set();
  for (const [from, conns] of Object.entries(W1.connections)) {
    for (const branch of conns.main || []) {
      for (const link of branch || []) {
        if (link.node === 'Send via Postmark') sendPredecessors.add(from);
      }
    }
  }
  assert.deepStrictEqual([...sendPredecessors], ['Dry Run?']);

  // ...and walk back from Dry Run? to confirm the guard is on every path.
  const parentsOf = (target) => Object.entries(W1.connections)
    .filter(([, c]) => (c.main || []).some((b) => (b || []).some((l) => l.node === target)))
    .map(([from]) => from);

  const seen = new Set();
  const stack = ['Dry Run?'];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    parentsOf(cur).forEach((p) => stack.push(p));
  }
  assert.ok(seen.has('Guard: Re-read & Re-check'), 'the guard must dominate the send path');
});

test('W1: the guard switch routes verify / send / invalid / skip', () => {
  const sw = byName(W1, 'Guard Verdict');
  assert.deepStrictEqual(sw.parameters.rules.values.map((r) => r.outputKey),
    ['verify', 'send', 'invalid', 'skip']);
  assert.deepStrictEqual(targetsOf(W1, 'Guard Verdict', 0), ['Verify Email (MillionVerifier)']);
  assert.deepStrictEqual(targetsOf(W1, 'Guard Verdict', 1), ['Route by Touch']);
  assert.deepStrictEqual(targetsOf(W1, 'Guard Verdict', 2), ['Build Airtable Commit']);
  assert.deepStrictEqual(targetsOf(W1, 'Guard Verdict', 3), ['Build Airtable Commit']);
});

test('W1: the verification gate halts Invalid/Risky and defers on an outage', () => {
  const sw = byName(W1, 'Verification Verdict');
  assert.deepStrictEqual(sw.parameters.rules.values.map((r) => r.outputKey), ['send', 'invalid', 'defer']);
  assert.deepStrictEqual(targetsOf(W1, 'Verification Verdict', 0), ['Route by Touch']);
  assert.deepStrictEqual(targetsOf(W1, 'Verification Verdict', 1), ['Build Airtable Commit']);
  assert.deepStrictEqual(targetsOf(W1, 'Verification Verdict', 2), ['Build Airtable Commit']);
});

test('W1: the multi-stage Switch has one branch per touch, all feeding Build Email', () => {
  const sw = byName(W1, 'Route by Touch');
  assert.deepStrictEqual(sw.parameters.rules.values.map((r) => r.outputKey),
    ['email1', 'followup1', 'followup2']);
  for (let i = 0; i < 3; i++) {
    const [caseNode] = targetsOf(W1, 'Route by Touch', i);
    assert.ok(caseNode.startsWith('Case: '), `output ${i} should reach a named case node`);
    assert.deepStrictEqual(targetsOf(W1, caseNode), ['Build Email']);
  }
});

test('W1: the loop always closes, so one bad lead cannot strand the batch', () => {
  assert.deepStrictEqual(targetsOf(W1, 'Commit to Airtable'), ['Loop Over Leads']);
  assert.deepStrictEqual(targetsOf(W1, 'Build Airtable Commit'), ['Commit to Airtable']);
  assert.deepStrictEqual(targetsOf(W1, 'Loop Over Leads', 0), ['Run Summary']);
});

test('W1: the send and commit nodes continue on error rather than aborting the run', () => {
  for (const name of ['Send via Postmark', 'Commit to Airtable', 'Re-read Lead Record',
    'Verify Email (MillionVerifier)']) {
    assert.strictEqual(byName(W1, name).onError, 'continueRegularOutput', `${name} must not abort the batch`);
  }
});

test('W1: every Airtable call carries the header-auth credential', () => {
  const airtableNodes = ['Get Base Schema', 'Apply Schema Change', 'Fetch Candidate Leads',
    'Re-read Lead Record', 'Commit to Airtable'];
  for (const name of airtableNodes) {
    const n = byName(W1, name);
    assert.ok(n, `${name} is missing from the workflow`);
    assert.strictEqual(n.parameters.authentication, 'genericCredentialType', `${name} is unauthenticated`);
    assert.ok(n.credentials && n.credentials.httpHeaderAuth, `${name} has no Airtable credential`);
  }
});

test('W1: the send node uses the Postmark credential, not the Airtable one', () => {
  const send = byName(W1, 'Send via Postmark');
  assert.strictEqual(send.parameters.method, 'POST');
  assert.match(send.credentials.httpHeaderAuth.name, /Postmark/);
});

test('W1: the stagger reads its delay from the queue, not a fixed constant', () => {
  const wait = byName(W1, 'Stagger 15-20 min');
  assert.strictEqual(wait.parameters.amount, '={{ $json.waitSeconds }}');
  assert.strictEqual(wait.parameters.unit, 'seconds');
});

test('W1: no secret is baked into the JSON', () => {
  const blob = JSON.stringify(W1) + JSON.stringify(W2) + JSON.stringify(W3);
  // Real Airtable PATs are patXXXXXXXXXXXXXX.<64 hex>; the loose form matches
  // ordinary identifiers like "patchSelectFields".
  assert.strictEqual(/pat[A-Za-z0-9]{14}\.[A-Za-z0-9]{40,}/.test(blob), false, 'an Airtable PAT looks committed');
  assert.strictEqual(/"key[A-Za-z0-9]{14}"/.test(blob), false, 'a legacy Airtable key looks committed');
  assert.strictEqual(/\bSK[a-f0-9]{32}\b/.test(blob), false, 'a Twilio key looks committed');
  assert.strictEqual(/sk-ant-[A-Za-z0-9_-]{20,}/.test(blob), false, 'an Anthropic key looks committed');
  assert.ok(JSON.stringify(W1).includes('REPLACE_WITH_'), 'credential ids should be placeholders');
  assert.strictEqual(/hooks\.slack\.com\/services\/T[A-Z0-9]/.test(blob), false, 'a Slack webhook looks committed');
});

/* ------------------------------------------------- Workflow 2 structure */

test('W2: both triggers converge on the same normalization path', () => {
  assert.deepStrictEqual(targetsOf(W2, 'IMAP: New Mail'), ['W2 Config']);
  assert.deepStrictEqual(targetsOf(W2, 'Webhook: Inbound Email'), ['W2 Config']);
  assert.deepStrictEqual(targetsOf(W2, 'W2 Config'), ['Normalize Inbound']);
  assert.deepStrictEqual(targetsOf(W2, 'Normalize Inbound'), ['Classify Reply']);
});

test('W2: replies are processed one at a time', () => {
  const loop = byName(W2, 'Loop Over Replies');
  assert.strictEqual(loop.type, 'n8n-nodes-base.splitInBatches');
  assert.strictEqual(loop.parameters.batchSize, 1);
  assert.deepStrictEqual(targetsOf(W2, 'Classify Reply'), ['Loop Over Replies']);
});

test('W2: autoresponders bypass Airtable entirely', () => {
  assert.deepStrictEqual(targetsOf(W2, 'Actionable?', 1), ['Ignore (Autoresponder)']);
  assert.deepStrictEqual(targetsOf(W2, 'Ignore (Autoresponder)'), ['Loop Over Replies']);
  assert.deepStrictEqual(targetsOf(W2, 'Actionable?', 0), ['Find Lead in Airtable']);
});

test('W2: every outcome branch returns to the loop, so one reply cannot hang it', () => {
  for (const [name, out] of [
    ['Slack: Unmatched Reply', 0], ['No Change Needed', 0],
    ['Notify Humans?', 1], ['SMS Enabled?', 1], ['Twilio: SMS Alert', 0]
  ]) {
    assert.deepStrictEqual(targetsOf(W2, name, out), ['Loop Over Replies'], `${name}[${out}]`);
  }
});

test('W2: the status update is authenticated and tolerant of failure', () => {
  const update = byName(W2, 'Update Lead Status');
  assert.strictEqual(update.parameters.method, 'PATCH');
  assert.ok(update.credentials.httpHeaderAuth);
  assert.strictEqual(update.onError, 'continueRegularOutput');
  assert.strictEqual(update.retryOnFail, true);
});

test('W2: the IMAP trigger marks mail read so a reply is handled once', () => {
  assert.strictEqual(byName(W2, 'IMAP: New Mail').parameters.postProcessAction, 'read');
});

/* ============================ Workflow 3 ============================ */

test('W3: the qualifier is a separate, optional workflow', () => {
  assert.match(W3.name, /optional/i);
  assert.ok(W3.nodes.length > 20);
  assert.strictEqual(W3.settings.executionOrder, 'v1');
});

test('W3: SAFETY — the model is never given a path to email copy', () => {
  // The single most important property of this workflow. The only thing it is
  // allowed to write is the Fit verdict.
  const patchNode = byName(W3, 'Save Fit to Airtable');
  assert.strictEqual(patchNode.parameters.method, 'PATCH');

  const commit = byName(W3, 'Build Fit Commit').parameters.jsCode;
  const written = [...commit.matchAll(/'(Fit(?:\s+[A-Za-z]+)*)':/g)].map((m) => m[1]);
  assert.deepStrictEqual(new Set(written), new Set(['Fit', 'Fit Reason', 'Fit Checked At']),
    `the qualifier writes ${written.join(', ')} — it must touch nothing else`);

  // And no node in W3 may reach the email templates at all.
  for (const node of W3.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    assert.strictEqual(/buildMessage|bodyEmail1|bodyFollowUp/.test(node.parameters.jsCode), false,
      `${node.name} can reach the email templates`);
  }
  assert.strictEqual(W3.nodes.some((n) => /postmark|sendgrid|smtp/i.test(JSON.stringify(n))), false,
    'the qualifier must have no send path');
});

test('W3: the Claude call is authenticated and tolerant of failure', () => {
  const ask = byName(W3, 'Ask Claude');
  assert.strictEqual(ask.parameters.method, 'POST');
  assert.match(ask.credentials.httpHeaderAuth.name, /Anthropic/);
  assert.strictEqual(ask.onError, 'continueRegularOutput', 'an API outage must not abort the run');
  const headers = ask.parameters.headerParameters.parameters.map((h) => h.name);
  assert.ok(headers.includes('anthropic-version'));
});

test('W3: the website fetch cannot crash the run', () => {
  const fetchNode = byName(W3, 'Fetch Website');
  assert.strictEqual(fetchNode.onError, 'continueRegularOutput');
  assert.strictEqual(fetchNode.parameters.options.response.response.neverError, true);
  assert.ok(fetchNode.parameters.options.timeout, 'a scrape needs a timeout');
  assert.strictEqual(fetchNode.parameters.options.redirect.redirect.followRedirects, true);
});

test('W3: every branch reaches the commit and returns to the loop', () => {
  // No lead may fall out of the loop unrecorded, or it is re-checked forever.
  assert.deepStrictEqual(targetsOf(W3, 'Readable?', 0), ['Fetch Website']);
  assert.deepStrictEqual(targetsOf(W3, 'Readable?', 1), ['Build Fit Commit']);
  assert.deepStrictEqual(targetsOf(W3, 'Enough to Judge?', 0), ['Ask Claude']);
  assert.deepStrictEqual(targetsOf(W3, 'Enough to Judge?', 1), ['Build Fit Commit']);
  assert.deepStrictEqual(targetsOf(W3, 'Parse Verdict'), ['Build Fit Commit']);
  assert.deepStrictEqual(targetsOf(W3, 'Build Fit Commit'), ['Save Fit to Airtable']);
  assert.deepStrictEqual(targetsOf(W3, 'Save Fit to Airtable'), ['Loop Over Leads']);
});

test('W3: the schema branch is a loop, like Workflow 1', () => {
  assert.deepStrictEqual(targetsOf(W3, 'Loop Schema Changes', 0), ['Fit Columns Ready']);
  assert.deepStrictEqual(targetsOf(W3, 'Loop Schema Changes', 1), ['Is a Change?']);
  assert.deepStrictEqual(targetsOf(W3, 'Apply Fit Column Change'), ['Loop Schema Changes']);
});

test('W3: no code node reads a splitInBatches node with a default branch index', () => {
  for (const node of W3.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    for (const loop of ['Loop Over Leads', 'Loop Schema Changes']) {
      assert.strictEqual(
        node.parameters.jsCode.includes(`$('${loop}').first()`), false,
        `${node.name} reads ${loop} branch 0, which is "done" and empty mid-loop`
      );
    }
  }
});

/* ==================== cross-workflow: fail open ==================== */

test('W1 only references the Fit column when it exists', () => {
  // Workflow 3 is optional; an Airtable formula naming a missing field is
  // rejected outright, which would take the whole campaign down.
  const plan = byName(W1, 'Plan Lead Fetch').parameters.jsCode;
  assert.ok(plan.includes('excludeUnfit: schema.hasFitField === true'));
  const report = byName(W1, 'Schema Report').parameters.jsCode;
  assert.ok(report.includes('hasFitField'));
});

test('W1 skips only an explicit Fit = No', () => {
  const queueCode = byName(W1, 'Build Send Queue').parameters.jsCode;
  assert.ok(queueCode.includes("qTrim(lead.fit).toLowerCase() === 'no'"),
    'the eligibility check must compare against "no" exactly');
  // A blank or "Unsure" verdict must not appear as a skip condition anywhere.
  assert.strictEqual(/lead\.fit[^\n]*(unsure|unchecked)/i.test(queueCode), false,
    'Unsure and unchecked leads must still be contacted');
});
