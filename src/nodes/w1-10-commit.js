// @requires:
// n8n Code node — "Build Airtable Commit" (Run Once for All Items)
//
// Turns any of the four terminal outcomes (sent / invalid / failed / skipped)
// into a single Airtable PATCH body. Writing every outcome — not just the
// happy path — is what makes the next run's decisions correct.
//
// Ordering note: Status and Last Contacted Date are written in ONE PATCH.
// Splitting them would leave a window where a crash produces "Sent Email 1"
// with no timestamp, which the sequencer would then refuse to follow up
// forever. One write, one consistent state.

var cfg = $('Init Config').first().json.cfg;
var lead = $input.first().json;
var fields = {};
var note;

if (lead.route === 'sent') {
  fields['Status'] = lead.nextStatus;
  fields['Last Contacted Date'] = lead.sentAt;
  fields['Idempotency Key'] = lead.idempotencyTarget;
  fields['Last Error'] = '';
  if (lead.verificationStatus) fields['Verification Status'] = lead.verificationStatus;
  // Only touch 1 establishes the thread; follow-ups must not overwrite it.
  if (lead.touch === 'email1') {
    if (lead.sentMessageId) fields['Message ID'] = lead.sentMessageId;
    if (lead.threadSubject) fields['Thread Subject'] = lead.threadSubject;
  }
  note = 'sent ' + lead.touch;

} else if (lead.route === 'invalid') {
  // Brief: an Invalid/Risky verification halts this lead permanently.
  fields['Status'] = 'Invalid';
  fields['Verification Status'] = lead.verificationStatus || 'Invalid';
  fields['Last Error'] = (lead.verificationReason || lead.guardReason || 'Failed verification').slice(0, 900);
  note = 'verification halt';

} else if (lead.route === 'failed') {
  // Status deliberately unchanged: the lead stays eligible and is retried on
  // the next run rather than being silently consumed by a provider blip.
  fields['Last Error'] = ('[' + lead.sentAt + '] ' + (lead.sendError || 'send failed')).slice(0, 900);
  if (lead.verificationStatus) fields['Verification Status'] = lead.verificationStatus;
  note = 'send failure recorded, lead left eligible';

} else {
  // 'skip' / 'defer': record why, change nothing else.
  fields['Last Error'] = ('[' + new Date().toISOString() + '] ' + (lead.guardReason || 'skipped')).slice(0, 900);
  note = 'skipped';
}

return [{
  json: {
    recordId: lead.recordId,
    email: lead.email,
    touch: lead.touch,
    route: lead.route,
    note: note,
    runId: lead.runId,
    patchUrl: cfg.airtableApiBase + '/' + cfg.baseId + '/' + encodeURIComponent(cfg.tableName) + '/' + lead.recordId,
    patchBody: { fields: fields, typecast: true }
  }
}];
