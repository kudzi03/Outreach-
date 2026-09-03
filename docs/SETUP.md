# Setup — clearing the warning triangles

After importing, nodes show a ⚠️ triangle because the JSON ships **placeholder
credential IDs on purpose** — that's how no secret of yours ever ends up in a
file you might share.

There are 15 triangles across the three workflows, but only **4 credentials**.
The Airtable one alone clears 11 of them.

Make the credentials first, then click through the nodes. Total time: ~10 minutes.

---

## Step 1 — Make the credentials (do this before touching any node)

In n8n: left sidebar → **Credentials** → **Add credential**.

### A. Airtable — clears 11 triangles

Search for and choose **Header Auth**.

| Field | Value |
|---|---|
| Name (of the credential) | `Airtable PAT (Header Auth)` |
| **Name** | `Authorization` |
| **Value** | `Bearer patXXXXXXXXXXXXXX.xxxxxxxx…` |

⚠️ The Value must be the word `Bearer`, then a **space**, then your token.
`Bearer patABC123...` — not just the token on its own. This is the single most
common setup mistake.

Get the token at <https://airtable.com/create/tokens> with all four scopes:
`data.records:read`, `data.records:write`, `schema.bases:read`,
`schema.bases:write` — and add your base under "Access".

### B. Postmark — clears 1 triangle

Search for and choose **Header Auth** again (a second, separate credential).

| Field | Value |
|---|---|
| Name (of the credential) | `Postmark Server Token (Header Auth)` |
| **Name** | `X-Postmark-Server-Token` |
| **Value** | your Postmark **Server** token |

Postmark → your server → **API Tokens** tab. Use the *Server* token, not the
Account token.

### C. Your inbox — clears 1 triangle

Search for and choose **IMAP**.

| Field | Value |
|---|---|
| Name (of the credential) | `Outreach Inbox (IMAP)` |
| User | your full email address |
| Password | your password — **Gmail/Workspace: an App Password**, not your login |
| Host | `imap.gmail.com` (Gmail), `outlook.office365.com` (Microsoft 365) |
| Port | `993` |
| SSL/TLS | on |

### D. Anthropic — clears 1 triangle (only if you use Workflow 3)

Search for and choose **Header Auth** (a third one).

| Field | Value |
|---|---|
| Name (of the credential) | `Anthropic API Key (Header Auth)` |
| **Name** | `x-api-key` |
| **Value** | `sk-ant-…` from <https://console.anthropic.com> |

Lowercase `x-api-key`. No "Bearer" here — just the key.

---

## Step 2 — Click through the nodes

For each node listed below: **open it → find the "Credential for Header Auth"
dropdown at the top → pick the credential → close.** The triangle disappears.

n8n usually pre-selects the last credential you used for that type, so after the
first node the rest are often two clicks each.

### Workflow 1 — Outbound Dispatcher (6 triangles)

| Node | Credential to pick |
|---|---|
| Get Base Schema | Airtable PAT (Header Auth) |
| Apply Schema Change | Airtable PAT (Header Auth) |
| Fetch Candidate Leads | Airtable PAT (Header Auth) |
| Re-read Lead Record | Airtable PAT (Header Auth) |
| Commit to Airtable | Airtable PAT (Header Auth) |
| **Send via Postmark** | **Postmark Server Token (Header Auth)** |

Five Airtable, one Postmark. Don't mix those two up — the Postmark node is the
only one that isn't Airtable.

### Workflow 2 — Inbound Listener (4 triangles)

| Node | Credential to pick |
|---|---|
| IMAP: New Mail | Outreach Inbox (IMAP) |
| Find Lead in Airtable | Airtable PAT (Header Auth) |
| Update Lead Status | Airtable PAT (Header Auth) |
| Twilio: SMS Alert | Twilio (Basic Auth) — **or see below** |

**Not using SMS?** Just **delete the `Twilio: SMS Alert` node.** Nothing else
needs changing: the `SMS Enabled?` node already routes back to the loop on its
false branch, and with `SMS_ENABLED` off it always takes that branch anyway.

**Want SMS?** Add a **Basic Auth** credential named `Twilio (Basic Auth)` —
Username = your Account SID, Password = your Auth Token — then fill in
`SMS_ENABLED`, `TWILIO_ACCOUNT_SID`, `TWILIO_FROM_NUMBER` and
`SMS_ALERT_TO_NUMBER` in the `W2 Config` node.

### Workflow 3 — Lead Qualifier (5 triangles, optional)

| Node | Credential to pick |
|---|---|
| Get Base Schema | Airtable PAT (Header Auth) |
| Apply Fit Column Change | Airtable PAT (Header Auth) |
| Fetch Unqualified Leads | Airtable PAT (Header Auth) |
| Save Fit to Airtable | Airtable PAT (Header Auth) |
| **Ask Claude** | **Anthropic API Key (Header Auth)** |

---

## Nodes that never show a triangle

These reach the internet but need no credential — nothing to do:

| Node | Why |
|---|---|
| Verify Email (MillionVerifier) | the key travels in the URL, from your settings |
| Fetch Website (W3) | it's just reading a public web page |
| Post Run Summary to Slack | a Slack webhook URL *is* the secret |
| Slack: Reply Alert / Unmatched Reply | same |

---

## Step 3 — Fill in the settings

One node per workflow. Open it and type between the quote marks at the top.

| Workflow | Node | Must fill in |
|---|---|---|
| 1 | `Init Config` | `AIRTABLE_BASE_ID`, `SENDER_NAME`, `SENDER_EMAIL`, `SENDER_COMPANY`, `SENDER_POSTAL_ADDRESS`, `MILLIONVERIFIER_API_KEY` |
| 2 | `W2 Config` | `AIRTABLE_BASE_ID` |
| 3 | `W3 Config` | `AIRTABLE_BASE_ID` |

`AIRTABLE_BASE_ID` must be **identical in all three** — it's the shared table
that lets the workflows talk to each other. It's the `appXXXXXXXXXXXXXX` part of
your Airtable URL.

Leave `DRY_RUN: 'true'` in Workflow 1 for now.

---

## Step 4 — Check it worked

Run each workflow manually (**Execute Workflow**), in this order.

**Workflow 1** (with `DRY_RUN: 'true'`)
- Green ticks all the way through
- Your Airtable table has new columns: `Status`, `Last Contacted Date`,
  `Verification Status`, `Message ID`, and the rest
- Open the `Build Send Queue` node → it lists the leads it *would* have emailed
- **No email was actually sent** — that's the point of DRY_RUN

**Workflow 3** (if you're using it)
- New columns appear: `Fit`, `Fit Reason`, `Fit Checked At`
- Rows start filling in with `Yes` / `Unsure` / `No`
- Read a dozen `Fit Reason` values before you trust it

**Workflow 2**
- Send yourself an email from another address to the inbox it watches
- It should execute; check that no record changed (you're not in the table)
- Once you've sent a real test email from Workflow 1, reply to it and confirm
  the record flips to `Replied`

Then: set `DRY_RUN: 'false'` in Workflow 1, and activate the workflows.

---

## If a triangle won't go away

| Symptom | Cause |
|---|---|
| Triangle stays after picking a credential | You didn't hit **Save** on the workflow |
| `401` on an Airtable node | Missing `Bearer ` + space in the credential Value |
| `403` on `Get Base Schema` | Token is missing `schema.bases:read` |
| `403` on `Apply Schema Change` only | Token is missing `schema.bases:write` |
| `404` on any Airtable node | Base isn't added to the token's **Access** list, or `AIRTABLE_BASE_ID` is wrong |
| `422` from Postmark | Your `SENDER_EMAIL` isn't a verified Sender Signature in Postmark |
| IMAP won't connect | Gmail/Workspace needs an **App Password**; a normal password is rejected |
| `401` on `Ask Claude` | Header name must be lowercase `x-api-key`, with no "Bearer" |
| "Setup is incomplete…" | Not a credential problem — the error names which settings are blank |

---

## The whole thing on one page

```
CREATE 4 CREDENTIALS               THEN PICK THEM ON THESE NODES
─────────────────────              ──────────────────────────────────────
Header Auth                        W1: Get Base Schema
  Authorization                        Apply Schema Change
  Bearer patXXX...                     Fetch Candidate Leads
  "Airtable PAT (Header Auth)"          Re-read Lead Record
                                       Commit to Airtable
                                   W2: Find Lead in Airtable
                                       Update Lead Status
                                   W3: Get Base Schema
                                       Apply Fit Column Change
                                       Fetch Unqualified Leads
                                       Save Fit to Airtable

Header Auth                        W1: Send via Postmark
  X-Postmark-Server-Token
  <server token>
  "Postmark Server Token (Header Auth)"

IMAP                               W2: IMAP: New Mail
  imap.gmail.com : 993
  "Outreach Inbox (IMAP)"

Header Auth                        W3: Ask Claude
  x-api-key
  sk-ant-...
  "Anthropic API Key (Header Auth)"

(optional) Basic Auth              W2: Twilio: SMS Alert
  SID / Auth Token                     — or just delete that node
  "Twilio (Basic Auth)"
```
