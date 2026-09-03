// @requires: classify
// n8n Code node — "Classify Reply" (Run Once for Each Item)
//
// Also builds the Airtable lookup formula. Two lookup strategies, in order:
//   1. RFC threading — In-Reply-To / References against the stored Message ID.
//      Exact, and survives someone replying from a different address.
//   2. Sender address, with +tag stripped.
// Strategy 1 first because it is the only one that is not a guess.

var cfg = $('W2 Config').first().json.cfg;
var msg = $json;

var verdict = classifyInbound({
  fromEmail: msg.fromEmail,
  subject: msg.subject,
  text: msg.text,
  headers: msg.headers
});

function esc(v) { return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// Collect every message-id mentioned in the threading headers.
var ids = [];
var idRe = /<[^>]+>/g;
var pool = (msg.inReplyTo + ' ' + msg.references).trim();
var m;
while ((m = idRe.exec(pool)) !== null) {
  if (ids.indexOf(m[0]) === -1) ids.push(m[0]);
}

var clauses = [];
for (var i = 0; i < ids.length; i++) clauses.push('{Message ID} = "' + esc(ids[i]) + '"');
if (msg.fromEmail) clauses.push('LOWER({Email}) = "' + esc(msg.fromEmail.toLowerCase()) + '"');
if (msg.fromMatchKey && msg.fromMatchKey !== msg.fromEmail) {
  clauses.push('LOWER({Email}) = "' + esc(msg.fromMatchKey) + '"');
}

var formula = clauses.length === 1 ? clauses[0] : 'OR(' + clauses.join(',') + ')';

console.log('[w2] ' + msg.fromEmail + ' subject="' + msg.subject + '" -> ' +
  verdict.verdict + '/' + verdict.sentiment + ' :: ' + verdict.reason);

return {
  json: Object.assign({}, msg, {
    verdict: verdict.verdict,
    sentiment: verdict.sentiment,
    nextStatus: verdict.nextStatus,
    notify: verdict.notify,
    cleanText: verdict.cleanText,
    matchedOptOut: verdict.matchedOptOut,
    matchedPositive: verdict.matchedPositive,
    reason: verdict.reason,
    threadIds: ids,
    // 'auto' never touches Airtable — do not even look the record up.
    route: verdict.verdict === 'auto' ? 'ignore' : 'match',
    searchUrl: cfg.airtableApiBase + '/' + cfg.baseId + '/' + encodeURIComponent(cfg.tableName),
    searchFormula: clauses.length ? formula : null
  })
};
