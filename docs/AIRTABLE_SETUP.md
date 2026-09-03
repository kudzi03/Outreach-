# Airtable setup

## 1. The table you provide

Create a table (default name `Leads`) with these four columns. Names must match
exactly — they are the contract between your list and the workflows.

| Column | Type | Required |
|---|---|---|
| `First Name` | Single line text | no — the copy falls back gracefully |
| `Company Name` | Single line text | no — the subject falls back to `quick question` |
| `Email` | Email or Single line text | **yes** — nothing runs without it |
| `City` | Single line text | no — used only in reply notifications |

Anything else you already have (Phone, Source, Notes, Owner, Last Job Value…)
is left completely alone.

## 2. The Personal Access Token

Create one at <https://airtable.com/create/tokens>.

**Scopes — all four are required:**

| Scope | Used for |
|---|---|
| `data.records:read` | fetching leads, re-reading before send, matching replies |
| `data.records:write` | writing Status, timestamps, verification results |
| `schema.bases:read` | the schema check (`GET /v0/meta/bases/{baseId}/tables`) |
| `schema.bases:write` | creating the missing columns |

**Access:** add your specific base. A token with the right scopes but no base
access returns a 403 that reads like an auth failure.

Then in n8n create a **Header Auth** credential named
`Airtable PAT (Header Auth)`:

```
Name:  Authorization
Value: Bearer patXXXXXXXXXXXXXX.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

All five Airtable HTTP nodes share this one credential.

> Dropping `schema.bases:write` is a legitimate choice if you'd rather not let
> automation alter your base. Create the columns from §3 by hand, and the schema
> engine will find them, plan nothing, and pass straight through.

## 3. What the schema engine creates

On every run, Workflow 1 reads the live schema and creates only what is missing.
It is idempotent — the second run plans zero changes.

### Required (always managed)

| Column | Type | Purpose |
|---|---|---|
| `Status` | Single select | The state machine. Choices: `New`, `Invalid`, `Queued`, `Sent Email 1`, `Sent Follow-up 1`, `Sent Follow-up 2`, `Replied`, `Do Not Contact` |
| `Last Contacted Date` | Date & time (ISO, UTC) | Drives both business-day follow-up gates |
| `Verification Status` | Single line text | `Valid` / `Risky` / `Invalid` from MillionVerifier |

### Bookkeeping (`MANAGE_OPTIONAL_FIELDS=true`, the default)

| Column | Type | Purpose |
|---|---|---|
| `Message ID` | Single line text | RFC 5322 Message-ID of touch 1. **Without it, follow-ups can only thread on subject.** |
| `Thread Subject` | Single line text | Subject of touch 1, reused as `Re: …` |
| `Idempotency Key` | Single line text | `recordId:touch` of the last committed send. Blocks a duplicate on retry. |
| `Last Error` | Long text | Most recent failure. Cleared on success. |
| `Reply Received At` | Date & time | When Workflow 2 saw the reply. |

These five aren't in the original spec, but two of its requirements imply them:
"send as a thread reply" needs a stored Message-ID, and "ultra-reliable" needs
an idempotency key. Set `MANAGE_OPTIONAL_FIELDS=false` to skip them — threading
degrades to subject-only and duplicate protection weakens to the status check.

## 4. What the schema engine will never do

The Metadata API calls it makes are exactly two: `POST …/fields` (create) and
`PATCH …/fields/{id}` with a choices list (add select options). There is no
delete or retype path in the code at all.

- **Your four columns are never touched.** `test/schema.test.js` asserts that no
  generated plan ever names one.
- **Existing select choices are preserved.** If your `Status` already has
  `Customer` and `Nurture`, the patch echoes them back with their ids and
  appends only the missing ones.
- **A different-but-usable type is adopted, not replaced.** If `Status` is
  already plain text, the engine notes it and moves on; the sequencer compares
  strings, so it works either way, and Airtable's `typecast: true` handles the
  writes.
- **An unusable type blocks the run.** If `Status` is, say, an attachment field,
  the run stops with a message naming the field and asking you to fix it in the
  UI. Nothing is modified.

## 5. Verifying it worked

Run Workflow 1 manually with `DRY_RUN=true` and open the **Schema Report** node:

```json
{
  "schemaReady": true,
  "tableId": "tblXXXXXXXXXXXXXX",
  "fieldsCreated": ["Status", "Last Contacted Date", "Verification Status", "Message ID", "..."],
  "choicesAdded": [],
  "fieldsAdopted": [],
  "notes": []
}
```

Run it a second time: `fieldsCreated` should be `[]`.

## 6. Loading leads

Set `Status` to `New`, or leave it blank — both are treated as "needs touch 1".

Two things worth doing before you import:

- **De-duplicate by email.** The queue collapses duplicates within a single day,
  but two rows for the same address still burn two records' worth of state.
- **Don't pre-fill `Last Contacted Date`.** A row with a follow-up status and no
  parseable timestamp is deliberately skipped forever — the code refuses to
  guess when a send happened.

## 7. Common errors

| Symptom | Cause |
|---|---|
| `403` on the Metadata call | PAT missing `schema.bases:read`, or the base isn't in the token's access list |
| `403` on `Apply Schema Change` only | PAT missing `schema.bases:write` |
| `Table "Leads" not found in base` | `AIRTABLE_TABLE_NAME` doesn't match, or the PAT can't see the base |
| `INVALID_MULTIPLE_CHOICE_OPTIONS` | A select `Status` whose choices weren't extended. Re-run — the engine adds them; `typecast: true` covers the rest |
| `Required user column "Email" is missing` | Rename your email column to exactly `Email` |
| Leads fetched but nothing queued | Look at the **Build Send Queue** node's console output — it logs a per-lead reason for every skip |
