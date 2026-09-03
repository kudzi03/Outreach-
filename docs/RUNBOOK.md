# Runbook

Day-2 operations: warming up, reading a run, diagnosing failures, and the
changes you're most likely to want.

---

## Going live

### Domain warm-up

Do **not** start at 30/day on a fresh domain. A cold domain sending 30 cold
emails on day one is the textbook path to a spam folder you can't get out of.

| Week | `DAILY_SEND_CAP` |
|---|---|
| 1 | 5 |
| 2 | 10 |
| 3 | 20 |
| 4+ | 30 |

Before any of that:

1. **Use a separate domain** from your primary business mail — e.g.
   `marloweautomations.co` for outreach, `marloweautomations.com` for real
   business. A reputation hit then can't take your actual email down with it.
2. **SPF, DKIM and DMARC must all pass.** Postmark walks you through SPF and
   DKIM; add DMARC yourself, starting at `p=none`.
3. **Send real mail from the mailbox first.** A domain whose very first traffic
   is 30 identical cold emails looks exactly like what it is.
4. **Check the mailbox is human.** Workflow 2 needs to reach it over IMAP, and
   someone needs to actually reply to the people who answer.

### First run checklist

- [ ] `npm test` passes
- [ ] `npm run preview` — read all three emails out loud
- [ ] `npm run dry-run -- --leads=<your list size>` — the schedule looks sane
- [ ] `DRY_RUN=true`, execute Workflow 1 manually
- [ ] Airtable columns appeared; **Schema Report** shows `schemaReady: true`
- [ ] **Build Send Queue** log shows the right leads and sensible skip reasons
- [ ] Second manual run: `fieldsCreated` is now `[]`
- [ ] Send yourself one real email (`DAILY_SEND_CAP=1`, a test row, `DRY_RUN=false`)
- [ ] Reply to it, then confirm Workflow 2 flipped the record to `Replied`
- [ ] Reply `stop` from another test row, confirm `Do Not Contact`
- [ ] `DRY_RUN=false`, activate both workflows

---

## Reading a run

Workflow 1 posts one Slack summary per day:

```
✅ Kitchen & Bath outreach — 2026-09-03
• Sent: 30 / cap 30  (touch1 12, fu1 11, fu2 7)
• Verification halts: 2
• Send failures: 0
• Guard skips: 3
```

What each line means:

- **Sent** — accepted by Postmark. Not "delivered" and certainly not "read".
- **Verification halts** — addresses MillionVerifier called undeliverable or
  risky. A few per day is normal; a sudden spike means a bad list import.
- **Send failures** — Postmark rejected or the call failed. Status was left
  unchanged, so these retry tomorrow. Persistent failures need investigation.
- **Guard skips** — leads that became ineligible between queue-build and send.
  Usually replies that landed mid-batch. **This number being non-zero is the
  system working.**

Per-lead detail is in the execution log. `Build Send Queue` logs a reason for
every skipped lead:

```
[run_20260903080012_a3f9k] queue=30/412 byTouch={"email1":12,"followup1":11,"followup2":7} finishes~2026-09-03T21:47:00Z
  skip recABC123 (dana@example.com): Only 2 of 3 business days elapsed.
  skip recDEF456 (sam@example.com): Terminal status "Replied".
  skip recGHI789 (lee@example.com): Over the 30/day cap — rolls to the next business day.
```

---

## Failure modes

### Nothing was sent today

Check `Init Config` → `haltReason`:

- `Not a business day (2026-09-07).` — weekend or a `CAMPAIGN_HOLIDAYS` entry.
- `Outside send window 8:00-18:00 America/New_York.` — the schedule fired but
  the window had closed. Check the n8n instance timezone against
  `CAMPAIGN_TIMEZONE`.
- `Not enough runway left in the send window…` — a late start. The batch is
  trimmed to what fits rather than stranded half-sent.

If `shouldRun` was true but the queue was empty, `Build Send Queue` logged why.

### The same lead got two emails

This should be impossible; four independent mechanisms prevent it. If it
happens, work through them in order:

1. Duplicate rows with the same address → the queue dedupes within a day, but
   check for rows added *between* runs.
2. `Idempotency Key` — is `MANAGE_OPTIONAL_FIELDS=false`? Duplicate protection
   weakens to the status check alone.
3. Two n8n instances (staging + production) pointed at one base.
4. `Commit to Airtable` failing while the send succeeded — look for `Last Error`
   on the record.

### Someone who replied still got a follow-up

Check, in order:

1. Did Workflow 2 actually run? Look for an execution at the reply's timestamp.
2. Did it match the record? An unmatched reply posts a Slack alert.
3. Was it classified `auto`? A human reply from an address with an aggressive
   corporate autoresponder header can be misread. The `Classify Reply` node logs
   its verdict and reason for every message.
4. Was the follow-up already in flight? The guard closes this — but only if
   Workflow 2 wrote the status *before* the guard's re-read. A Workflow 2
   execution stuck in a retry backoff can lose that race. This is why the IMAP
   trigger polls frequently.

### Someone got marked Do Not Contact who shouldn't have

Look at `Classify Reply` → `matchedOptOut` in the execution log. It names the
exact phrase. If it's a false positive, remove or tighten that phrase in
`src/lib/classify.js`, add a test case for the message that misfired, and
`npm run build`.

Ambiguous single words (`stop`, `remove`, `no`, `pass`) only count when the
whole reply is four words or shorter. Multi-word phrases count anywhere.

### Emails are landing in spam

In rough order of likelihood: sending too much too soon (warm up), SPF/DKIM/
DMARC not all passing, a shared or recycled sending domain, a list with lots of
dead addresses (raise verification strictness — set `ALLOW_RISKY=false`), or
copy that looks like marketing. The templates avoid links, images and tracking
for exactly this reason; adding a link to touch 1 will measurably hurt.

### `Init Config: missing or invalid settings`

The workflow refuses to run half-configured. The message names each missing
variable. If your n8n has `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, `$env` reads
return nothing — either unset it, or hard-code values in `Init Config` and
`W2 Config` (the only two nodes that touch the environment).

---

## Common changes

### Change the copy

Edit `src/lib/templates.js`, then:

```bash
npm run preview     # read it
npm test            # the copy assertions will tell you what you changed
npm run build       # regenerate the workflows
```

Re-import Workflow 1. Editing the Code node in the n8n UI instead will work
until the next build overwrites it, and `npm test` will fail in the meantime —
that failure is the point.

### Change the cadence

`QUEUE_WAIT_BUSINESS_DAYS` in `src/lib/queue.js`:

```js
var QUEUE_WAIT_BUSINESS_DAYS = { email1: 0, followup1: 3, followup2: 4 };
```

Update the day expectations in `test/sequence.test.js` to match, then rebuild.

### Add a fourth touch

1. `src/lib/queue.js` — add `'sent follow-up 2': 'followup3'` to
   `QUEUE_TOUCH_BY_STATUS`, add `followup3` to `QUEUE_NEXT_STATUS`,
   `QUEUE_WAIT_BUSINESS_DAYS` and `QUEUE_PRIORITY`, and remove
   `Sent Follow-up 2` from the terminal list in `fetchFormula()`.
2. `src/lib/schema.js` — add `Sent Follow-up 3` to `SCHEMA_STATUS_CHOICES`.
   The engine will add the choice to your existing select on the next run.
3. `src/lib/templates.js` — add `bodyFollowUp3` and a `buildMessage` branch.
4. `workflows/templates/workflow-1-outbound-dispatcher.json` — add a fourth
   rule to `Route by Touch`, a `Case: Follow-up 3` node, and wire it to
   `Build Email`.
5. `npm run verify`.

### Use SMTP instead of Postmark

Replace `Send via Postmark` with an **Email Send** node:

- To: `={{ $json.email }}`
- Subject: `={{ $json.subject }}`
- Text: `={{ $json.textBody }}`
- From: `={{ $('Init Config').first().json.cfg.fromHeader }}`

Then set `EMAIL_PROVIDER=smtp`.

**The trade:** n8n's Email Send node doesn't return the message's RFC
Message-ID, and doesn't let you set custom headers. So follow-ups can't carry
`In-Reply-To` and will thread on subject alone — most clients group them, but
Gmail's threading gets less reliable. `Parse Send Result` handles the missing
id without erroring. If threading matters to you, stay on Postmark.

### Use webhook inbound instead of IMAP

Point Postmark's inbound stream at `https://<your-n8n>/webhook/inbound-reply`,
then disable the `IMAP: New Mail` node. `Normalize Inbound` already handles both
payload shapes; nothing else changes.

Webhook is faster and more reliable than IMAP polling — worth doing if you're
already on Postmark.

### Pause the campaign

Deactivate Workflow 1. **Leave Workflow 2 active** — replies to mail you already
sent still need to be caught and honoured.

### Change the daily cap

Set `DAILY_SEND_CAP`. Above ~35 you'll also need to widen the send window or
narrow the stagger:

```
max sends ≈ (SEND_WINDOW_END_HOUR − SEND_WINDOW_START_HOUR) × 60 / STAGGER_MAX_MINUTES
```

At 08:00–18:00 with a 20-minute maximum gap, that's 30. `Init Config` computes
this every morning and trims the batch rather than overrunning.

---

## Monitoring

Worth an alert:

- Workflow 1 hasn't run on a business day → the schedule or the instance is down.
- `Send failures` non-zero two days running → a provider or auth problem.
- `Sent` is 0 but leads exist → check `Build Send Queue` skip reasons.
- Unmatched-reply Slack alerts → someone is replying from an address that isn't
  in Airtable. Usually a forward, sometimes a bad match key.
- Reply rate collapsing week over week → deliverability, before copy.

Point n8n's **Error Workflow** setting at a workflow that posts to Slack, so an
unhandled failure is loud. The send path already continues on error, so this
catches only genuinely unexpected breakage.

## Data retention

Full inbound message bodies pass through Workflow 2's execution logs. If your
n8n retains executions indefinitely, that's a growing pile of other people's
email on your disk. Set `EXECUTIONS_DATA_MAX_AGE` (default 336 hours) to
something you're comfortable defending.
