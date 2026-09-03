// @requires: queue
// n8n Code node — "Resolve Match & Decide" (Run Once for All Items)
//
// Input : Airtable search results for this reply.
// Output: exactly one item describing the write to make (or why we are not
//         making one).
//
// Status precedence is strict and one-way:
//     Do Not Contact  >  Replied  >  everything else
// A record already opted out is NEVER promoted back to "Replied", not even by
// a later friendly message. Downgrading an opt-out is the single most
// expensive mistake this system could make.

var cfg = $('W2 Config').first().json.cfg;
// Same branch-index caveat as Workflow 1: read the IF node's true output
// (branch 0) rather than the splitInBatches "done" branch.
var msg = $('Actionable?').first().json;  // the one reply in flight

var records = [];
var incoming = $input.all();
for (var n = 0; n < incoming.length; n++) {
  var j = incoming[n].json;
  if (j && Array.isArray(j.records)) records = records.concat(j.records);
  else if (j && j.id) records.push(j);
}

if (!records.length) {
  console.log('[w2] UNMATCHED reply from ' + msg.fromEmail + ' — no Airtable record.');
  return [{
    json: Object.assign({}, msg, {
      route: 'unmatched',
      recordId: null,
      alertText: ':grey_question: Reply from *' + msg.fromEmail + '* did not match any lead.\n' +
        '> ' + String(msg.cleanText || '').slice(0, 300)
    })
  }];
}

// Prefer a thread-header match (exact) over an email match (a guess), then
// the most recently contacted record.
records.sort(function (a, b) {
  var af = (a.fields || {}), bf = (b.fields || {});
  var aThread = msg.threadIds.indexOf(String(af['Message ID'] || '')) !== -1 ? 0 : 1;
  var bThread = msg.threadIds.indexOf(String(bf['Message ID'] || '')) !== -1 ? 0 : 1;
  if (aThread !== bThread) return aThread - bThread;
  return String(bf['Last Contacted Date'] || '').localeCompare(String(af['Last Contacted Date'] || ''));
});

var record = records[0];
var lead = normalizeRecord(record);
var current = String(lead.status || '').toLowerCase();

var fields = {};
var action;

if (current === 'do not contact') {
  action = 'noop-optout';
} else if (msg.verdict === 'optout') {
  fields['Status'] = 'Do Not Contact';
  action = 'opt-out';
} else if (msg.verdict === 'bounce') {
  fields['Status'] = 'Invalid';
  fields['Verification Status'] = 'Invalid';
  action = 'bounce';
} else if (current === 'replied') {
  // Already flagged; refresh the timestamp but do not re-alert the humans on
  // every message of an ongoing back-and-forth.
  fields['Reply Received At'] = new Date().toISOString();
  action = 'noop-replied';
} else {
  fields['Status'] = 'Replied';
  fields['Reply Received At'] = new Date().toISOString();
  action = 'replied';
}

var isNoop = action.indexOf('noop') === 0;
if (!isNoop && (action === 'replied' || action === 'opt-out' || action === 'bounce')) {
  fields['Last Error'] = '';
}

var who = lead.firstName || lead.companyName || msg.fromEmail;
var alertText = null;
if (action === 'replied') {
  alertText = [
    (msg.sentiment === 'positive' ? ':fire: *POSITIVE REPLY*' : ':envelope_with_arrow: *New reply*') +
      ' from *' + who + '*' + (lead.companyName ? ' (' + lead.companyName + ')' : ''),
    '`' + msg.fromEmail + '`' + (lead.city ? ' · ' + lead.city : '') + ' · was at _' + (lead.status || 'New') + '_',
    '> ' + String(msg.cleanText || '').split('\n').slice(0, 6).join('\n> ').slice(0, 700),
    '<https://airtable.com/' + cfg.baseId + '/' + record.id + '|Open in Airtable>'
  ].join('\n');
} else if (action === 'opt-out' && cfg.notifyOnOptOut) {
  alertText = ':no_entry: Opt-out from *' + who + '* (`' + msg.fromEmail + '`) — matched: ' +
    msg.matchedOptOut.join(', ') + '. Marked *Do Not Contact*.';
}

console.log('[w2] ' + msg.fromEmail + ' -> record ' + record.id + ' action=' + action +
  ' status "' + lead.status + '" -> "' + (fields['Status'] || lead.status) + '"');

return [{
  json: Object.assign({}, msg, {
    route: isNoop && !Object.keys(fields).length ? 'noop' : 'write',
    action: action,
    recordId: record.id,
    matchedOn: msg.threadIds.indexOf(String((record.fields || {})['Message ID'] || '')) !== -1 ? 'thread-header' : 'email',
    previousStatus: lead.status,
    leadName: who,
    leadCompany: lead.companyName,
    patchUrl: cfg.airtableApiBase + '/' + cfg.baseId + '/' + encodeURIComponent(cfg.tableName) + '/' + record.id,
    patchBody: { fields: fields, typecast: true },
    alertText: alertText,
    shouldAlert: !!alertText
  })
}];
