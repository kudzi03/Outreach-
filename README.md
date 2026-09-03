# Kitchen & Bath Remodeler Outreach

A production n8n + Airtable cold email system for Kitchen & Bath remodelers.

**The pitch it makes:** remodelers lose $20k+ jobs because a quote goes out on
Tuesday, they get pulled onto a job site Wednesday, and by the time they call
back on Friday the homeowner has signed with whoever followed up first.

**How it behaves:** three touches per lead, threaded into one conversation, a
hard ceiling of **30 emails per day** across all touches, sends spaced 15–20
minutes apart, and a reply or opt-out that stops everything instantly and
permanently.

```
                                       ┌──────────────────────────────┐
  WORKFLOW 1  (daily, Mon–Fri 08:00)   │  Airtable                    │
  ───────────────────────────────────  │  ┌────────────────────────┐  │
  schema check → auto-create columns ─▶│  │ First Name  (yours)    │  │
  fetch eligible leads               ◀─│  │ Company Name(yours)    │  │
  build capped, staggered queue        │  │ Email       (yours)    │  │
    ↓ per lead                         │  │ City        (yours)    │  │
    wait 15–20 min                     │  │ ─────────────────────  │  │
    RE-READ the record   ─────────────▶│  │ Status                 │  │
    guard: still eligible?             │  │ Last Contacted Date    │  │
    verify (MillionVerifier)           │  │ Verification Status    │  │
    switch on Status → touch 1/2/3     │  │ Message ID             │  │
    send  ────────────────────────────▶│  │ Idempotency Key        │  │
    commit Status + timestamp  ───────▶│  └────────────────────────┘  │
                                       │                              │
  WORKFLOW 2  (IMAP / webhook)         │                              │
  ───────────────────────────────────  │                              │
  inbound mail                         │                              │
    → bounce   → Status = Invalid ────▶│                              │
    → auto-reply → (nothing at all)    │                              │
    → opt-out  → Do Not Contact  ─────▶│                              │
    → reply    → Replied + Slack ─────▶│                              │
                                       └──────────────────────────────┘
```

---

## What's in here

| Path | What it is |
|---|---|
| `workflows/*.json` | **Import these into n8n.** Generated, complete, ready to run. |
| `workflows/templates/*.json` | The node graph, with `@@code:name@@` markers where source is injected. |
| `src/lib/*.js` | The real logic: dates, templates, schema diffing, classification, queueing. Unit-tested. |
| `src/nodes/*.js` | One file per n8n Code node. Thin wrappers over `src/lib`. |
| `build/build.js` | Inlines the libs into every Code node and validates the graph. |
| `test/*.test.js` | 144 tests, including a multi-week end-to-end campaign simulation. |
| `tools/` | `preview-emails.js` and `simulate-campaign.js` — see your copy and your schedule before going live. |
| `docs/AIRTABLE_SETUP.md` | Token scopes, base setup, what the schema engine will and won't do. |
| `docs/RUNBOOK.md` | Day-2 operations: deliverability, failure modes, SMTP variant, troubleshooting. |

### Why there is a build step

n8n Code nodes can't `require` project files, so shared logic has to be pasted
into each node. Pasting `businessDaysSince` into a dozen nodes by hand
guarantees they drift — and drift there means emailing someone who asked to be
left alone. So the logic is written once in `src/lib`, tested once, and
mechanically inlined:

```bash
npm run build     # regenerate workflows/*.json from src/
npm test          # 144 tests, incl. a check that the JSON matches src/
npm run verify    # both
```

Edit `src/`, never the Code nodes in the n8n UI. `npm test` fails loudly if the
committed JSON has drifted from source.

---

## Quick start

```bash
git clone <this repo> && cd Outreach-
npm test                              # no dependencies to install
npm run preview                       # read the three emails out loud
npm run dry-run -- --leads=200        # see the day-by-day schedule
```

Then:

1. **Airtable** — create a Personal Access Token with `data.records:read`,
   `data.records:write`, `schema.bases:read`, `schema.bases:write`, scoped to
   your base. Your table needs only `First Name`, `Company Name`, `Email`,
   `City`. Everything else is created for you. → `docs/AIRTABLE_SETUP.md`
2. **n8n credentials** — create three:
   - `Airtable PAT (Header Auth)` → Name `Authorization`, Value `Bearer patXXXX…`
   - `Postmark Server Token (Header Auth)` → Name `X-Postmark-Server-Token`, Value `<token>`
   - `Outreach Inbox (IMAP)` → the mailbox replies land in
3. **Environment** — copy `.env.example` into your n8n instance's environment.
   Leave `DRY_RUN=true` for now.
4. **Import** both files from `workflows/`. Re-select the credentials on the
   nodes that show a warning triangle (the JSON ships placeholder ids
   deliberately, so no secret is ever committed).
5. **Test run** — hit *Execute Workflow* on Workflow 1. With `DRY_RUN=true` it
   provisions the schema, builds the real queue and writes real statuses, but
   hands nothing to Postmark. Check the Airtable columns appeared and the queue
   looks right.
6. **Go live** — set `DRY_RUN=false`, activate both workflows.

> Start at `DAILY_SEND_CAP=5` on a new domain and climb to 30 over two or three
> weeks. `docs/RUNBOOK.md` has the warm-up schedule.

---

## The three touches

Copy is in `src/lib/templates.js`; run `npm run preview` to see it rendered.

**Touch 1 — Day 1**
Subject: `quick question / [Company Name]`
> Hey [First Name], quick question: when you guys drop off a quote for a $20k+
> kitchen or bath job, who usually handles chasing them down a few days later?

Fallback when there is no usable first name:
> Quick question for the team at [Company Name]—when you guys send out a quote
> for a bigger remodel, who handles following up?

**Touch 2 — Day 4** (3 business days later, threaded `Re:`)
> Hey [First Name], reason I asked is most kitchen & bath guys I talk to say
> their biggest headache is estimating a project on Tuesday, getting pulled onto
> a job site on Wednesday, and completely forgetting to check back in by Friday.
> By the time they call, the homeowner already signed with someone else who
> checked in first.
>
> Do you guys have something running that texts/emails them automatically after
> 48 hours, or is it mostly manual right now?

**Touch 3 — Day 8** (4 business days later, threaded `Re:`)
> Hey [First Name], I'm guessing either your pipeline is completely packed for
> the next 6 months, or you've already got a system handling quote follow-ups?
>
> If not, let me know—happy to send over a 60-second video showing how two other
> remodelers automated it. Otherwise, I'll stop bugging you!

Every message is plain text with **no links, no HTML and no open tracking**, and
carries the sender's name, company and postal address plus a plain-English
opt-out line. That footer is also the opt-out mechanism Workflow 2 listens for.

### Personalization guards

`[First Name]` is only used when the value actually looks like a person's name.
`info`, `Sales`, `Maple Ridge Kitchens`, `1234`, `j@example.com` and
`a-very-long-scraped-string` are all rejected, and the lead silently gets the
fallback copy instead. One embarrassing `Hey Info,` costs more than a hundred
generic openers.

---

## The two safety guarantees

Everything else in this repo is scheduling. These two are the part that must
never fail.

**1. A terminal record is never even loaded.** Workflow 1's Airtable
`filterByFormula` excludes `Replied`, `Do Not Contact`, `Invalid` and
`Sent Follow-up 2` before a single record crosses the wire.

**2. Every lead is re-read from Airtable immediately before its send.** The
queue is planned at 08:00 but the 30th email leaves around 17:00. In those nine
hours a prospect can reply and an operator can mark someone Do Not Contact — so
after the stagger wait, and before building the message, Workflow 1 fetches the
record again and re-decides. A reply that lands at 14:32 cancels the 14:35 send.

The guard also blocks: a status that advanced underneath us, a matching
idempotency key (the same touch already committed), an address cleared from the
record, and any lead already contacted today by anything at all.

Workflow 2 enforces a strict one-way precedence:

```
Do Not Contact  >  Replied  >  everything else
```

A record that opted out is **never** promoted back to `Replied`, however
friendly a later message is.

### What is deliberately *not* a reply

An out-of-office autoresponder is not a reply. Marking one `Replied` silently
kills a live sequence every time a prospect takes a week off, so Workflow 2
detects autoresponders (via `Auto-Submitted`, `X-Autoreply`, `Precedence`, and
subject patterns) and **writes nothing at all**. Hard bounces are detected
separately and set `Status = Invalid`.

And the sharpest edge: our own signature says *reply "stop"*, and every reply
quotes it. Matching opt-out keywords against the raw body would opt out every
single person who answers. So quoted history and signatures are stripped
**first**, and only the freshly typed text is classified. `stop` on its own is
an opt-out; "Sure — stop by the showroom Thursday" is a warm lead. Both are
tested.

---

## Daily cap and pacing

`DAILY_SEND_CAP=30` counts **all** touches, not just new leads. The queue is
built once per morning:

1. every non-terminal record is evaluated against its business-day gate;
2. duplicates by email address are collapsed — duplicate rows are the fastest
   way to send one person three emails before lunch;
3. follow-ups are sorted ahead of cold opens, because a live thread is worth
   more than a fresh guess;
4. the list is cut to the cap, and the remainder rolls to the next business day;
5. each lead gets a randomized 15–20 minute offset.

At the worst-case 20-minute gap, 30 emails span 9h40m — which is why the send
window defaults to 08:00–18:00. If a run starts late, `Init Config` trims the
batch to what actually fits rather than stranding it half-sent.

Steady-state throughput is **~10 new leads/day** (each lead costs 3 emails).
`npm run dry-run -- --leads=500 --days=90` will show you the exact curve.

---

## Failure policy

The expensive failures are silent ones. Every outcome is written back.

| What happened | Status | Why |
|---|---|---|
| Sent | advances to the next touch | with timestamp + idempotency key, in one write |
| Verified `invalid`/`disposable` | `Invalid` | undeliverable, halted per the brief |
| Verified `catch_all`/`unknown` | `Invalid` | halted unless `ALLOW_RISKY=true` |
| **Verifier unreachable** | **unchanged** | an API outage must never burn a good lead |
| **Send failed** | **unchanged** | `Last Error` written; retried on the next run |
| Guard blocked | unchanged | reason written to `Last Error` |
| Bounced (Workflow 2) | `Invalid` | |

`Status` and `Last Contacted Date` are always written in a *single* PATCH.
Splitting them would leave a crash window where a record reads `Sent Email 1`
with no timestamp — and the sequencer, failing closed, would then refuse to ever
follow up on it.

Send, commit, re-read and verify nodes all continue on error, so one bad lead
can never strand the other 29.

---

## Testing

```
$ npm test
# tests 144
# pass 144
```

The suite covers the things that would be expensive to get wrong:

- **`sequence.test.js`** simulates 200 leads over 60 business days and asserts
  that nobody gets a 4th email, nobody gets two in a day, the cap holds *every*
  day, a reply or opt-out ends the sequence forever, and an out-of-office
  doesn't.
- **`classify.test.js`** asserts our own quoted signature doesn't opt anyone out,
  every keyword from the brief does, and "stop by the showroom" doesn't.
- **`queue.test.js`** covers the business-day gates including weekends and
  holidays, and every branch of the pre-send guard.
- **`schema.test.js`** asserts the schema engine never emits a mutation for a
  user column, is idempotent, and adopts rather than replaces an existing
  `Status` column.
- **`workflows.test.js`** asserts the shipped JSON actually wires the guard onto
  the send path, that every branch returns to its loop, and that no secret is
  committed.

---

## Configuration

Every setting is in `.env.example`, documented inline. The ones worth a second
look:

| Variable | Default | Note |
|---|---|---|
| `DRY_RUN` | `true` | Runs everything except handing mail to Postmark. Leave on for the first run. |
| `DAILY_SEND_CAP` | `30` | All touches, not just new leads. |
| `CAMPAIGN_TIMEZONE` | `America/New_York` | **All** business-day maths happens here. |
| `CAMPAIGN_HOLIDAYS` | — | `YYYY-MM-DD,…`. Excluded from sending *and* from the follow-up gates. |
| `ALLOW_RISKY` | `false` | `true` sends to catch-all domains. Real trade — many remodelers run catch-all Workspace domains. |
| `MANAGE_OPTIONAL_FIELDS` | `true` | `false` creates only the three required columns; threading and duplicate protection degrade. |

All configuration is read in exactly two nodes — `Init Config` and `W2 Config` —
so if your n8n runs with `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, those are the only
two places to hard-code values.

---

## Compliance

This sends unsolicited commercial email, which is legal in the US under
CAN-SPAM if you follow the rules, and **not** legal in the EU/UK without a
lawful basis. The system does its part:

- accurate `From` and subject lines, no header forgery;
- sender name, company and physical postal address on every message;
- a plain-English opt-out in every message, honoured automatically and
  permanently by Workflow 2, well inside the 10-day statutory window;
- verification before send, so you aren't hammering dead addresses.

What it can't do for you: confirm you have a lawful basis under GDPR/PECR for
any EU/UK contacts, or that your list was sourced legitimately. That part is
yours. If you're contacting outside the US, talk to a lawyer before enabling.
