# Workflow 3 — Lead Qualification

**Optional.** Never import it and the campaign runs exactly as it did before.

It reads each lead's website and writes a **Fit** verdict to Airtable. Workflow 1
then skips the clear mismatches. It decides **who** you email; it never writes a
word of **what** you email.

---

## Why it doesn't write the copy

The obvious version of "use AI for personalization" is to have a model read the
site and write the opener. That version makes things worse:

**It reads as more of a pitch, not less.** The output is always some variant of
*"Hi Dana — I came across Maple Ridge Kitchens and was impressed by your
portfolio of transitional kitchen remodels in the Austin area..."*. Every
remodeler on your list has received twenty of those this month. It is the single
most recognizable pattern in cold email, and it opens by performing interest
instead of asking something.

Your opener works *because* it isn't personalized. "When you guys drop off a
quote for a $20k+ kitchen or bath job, who usually handles chasing them down?"
is a peer asking about a process. The relevance comes from knowing the trade,
not the company.

**Generated copy is untestable.** Every other line of email text in this repo is
fixed and covered by assertions. A model in the send path means what actually
goes out is unverifiable — and one hallucinated detail ("saw the Johnson project
you wrapped up") in a cold email is not recoverable.

**The volume doesn't justify it.** At 30 sends/day the bottleneck is list
quality and deliverability, not copy variance. Personalization pays off at
500/day with an A/B test behind it.

**Targeting is where the leverage is.** Not emailing a roofing company beats any
amount of clever phrasing, and it costs you nothing in reputation.

So the model answers narrow factual questions, the answer lands in a column, and
the copy stays fixed. `test/workflows.test.js` asserts structurally that no node
in Workflow 3 can reach the email templates, and that the only columns it writes
are `Fit`, `Fit Reason` and `Fit Checked At`.

---

## What it decides

For each lead it fetches the homepage and asks for a small JSON object:

| Field | Values |
|---|---|
| `fit` | `Yes` · `Unsure` · `No` |
| `category` | `kitchen_bath_remodeler` · `general_contractor` · `handyman` · `supplier_showroom` · `designer_only` · `other_trade` · `not_a_business` · `unknown` |
| `size` | `solo` · `small_team` · `established` · `unknown` |
| `does_kitchens` / `does_baths` | true / false |
| `has_existing_crm` | true / false — the site advertises online booking or instant quoting |
| `reason` | ≤ 20 words, quoting evidence from the page |

`No` is reserved for clear mismatches: suppliers and showrooms that don't
install, handymen, designers who don't build, unrelated trades (roofing, HVAC,
landscaping, flooring-only…), directories and lead-gen sites, and dead or parked
domains.

The prompt says *"Be strict. A wrong Yes wastes a send and risks a spam
complaint; a wrong No only costs one lead"*, and *"Judge ONLY from the text
shown — never guess from the company name, and never invent details."*

---

## Fail-open, everywhere

This is the property that matters most. **Only an explicit `No` is ever
skipped.** Every other outcome is contacted normally:

| What happened | `Fit` | Emailed? |
|---|---|---|
| Model says it's a good fit | `Yes` | yes |
| Model says roofing company | `No` | **no** |
| Model unsure, page too thin | `Unsure` | yes |
| Site timed out / 404 / blocked the scraper | `Unsure` | yes |
| Domain is parked or dead | `Unsure` | yes |
| Anthropic API returned an error | `Unsure` | yes |
| Model returned malformed JSON | `Unsure` | yes |
| Free mailbox — no company site to read | `Unsure` | yes |
| **Workflow 3 never run at all** | blank | yes |

An API outage is not evidence that a company is a bad fit, and treating it as
such would silently delete good leads. `test/qualify.test.js` walks all eight
failure paths and asserts none of them can produce a `No`.

A lead already mid-sequence is never pulled out by a fit verdict either — only
a reply or an opt-out stops a live thread.

---

## Where the website comes from

1. A **`Website`** column, if your table has one (add it yourself; the schema
   engine won't).
2. Otherwise the **email domain** — `dana@mapleridgekitchens.com` →
   `mapleridgekitchens.com`. For a small contractor that's almost always right.
3. A **free mailbox** (gmail, yahoo, outlook, comcast…) tells us nothing, so
   those leads are recorded `Unsure` and contacted normally.

Two contacts at the same domain cost one page fetch and one API call; the second
is skipped as a duplicate.

---

## Cost

`claude-sonnet-5` at `effort: low`, roughly 1.5k input tokens per homepage:

**≈ $4 per 1,000 leads.**

Less than the MillionVerifier credits you save by not verifying leads that were
never a fit. `claude-haiku-4-5` would run about half that — set `CLAUDE_MODEL`
in the `W3 Config` node.

Cost control levers, in order:

- `QUALIFY_PER_RUN` (default 50) — leads per hourly run. 50/hr clears ~1,200/day.
- `PAGE_CHAR_LIMIT` (default 6000) — the page text budget; input tokens scale
  with this directly.
- `CLAUDE_EFFORT` (default `low`) — already at the bottom.

The run summary reports actual token counts and a dollar estimate.

---

## Setup

1. **Credential** — in n8n, add a **Header Auth** credential named
   `Anthropic API Key (Header Auth)`:
   - Name: `x-api-key`
   - Value: your key from <https://console.anthropic.com>
2. **Import** `workflows/workflow-3-lead-qualifier.json`.
3. **Settings** — open the `W3 Config` node. `AIRTABLE_BASE_ID` and
   `AIRTABLE_TABLE_NAME` must match Workflow 1 exactly; that shared table is how
   the workflows talk to each other.
4. **Run it manually once.** It creates the three `Fit` columns, checks up to 50
   leads, and posts a summary. Read a dozen `Fit Reason` values before you trust
   it.
5. **Activate it.** It runs hourly and works through the backlog on its own.

Workflow 1 picks the verdicts up automatically — its schema engine also creates
the `Fit` column, and it only adds `{Fit} != "No"` to its Airtable query once
that column exists.

---

## Reading the output

The Slack summary per run:

```
🔍 Lead qualification — 50 checked
• Fit: 31 yes · 12 unsure · 7 no  (14% rejected)
• Cost: ~$0.198  (74,900 in / 4,010 out tokens, claude-sonnet-5)
• Only "no" is skipped by the sender. Unsure and unchecked leads are still contacted.
Rejected: austinroofingpros.com — other_trade
          cabinetsupplyco.com — supplier_showroom
```

**A reject rate above ~40% usually means the list is wrong, not the model.**
Read the `Fit Reason` column on a sample before you widen the prompt.

**A reject rate near 0%** means either a very clean list, or that most sites are
too thin to judge — check how many came back `Unsure`.

---

## Tuning

The classification lives in `QL_SYSTEM_PROMPT` in `src/lib/qualify.js`. To
change what counts as a fit, edit the `Answer "No" when...` list, add a test
case to `test/qualify.test.js`, and run `npm run build`.

To re-check leads you've already judged, set `FORCE_REQUALIFY` to `true` in
`W3 Config` for one run, then set it back — it costs full price every time.
