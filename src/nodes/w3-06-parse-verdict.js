// @requires: qualify
// n8n Code node — "Parse Verdict" (Run Once for All Items)
//
// Every failure path here resolves to "Unsure", never "No". An API outage, a
// refusal, or malformed JSON is not evidence that a company is a bad fit, and
// treating it as such would silently delete good leads.

var lead = $('Read Page').first().json;
var res = $input.first().json || {};

var httpError = res.error && !res.content ? res.error : null;
var verdict = parseVerdict(httpError ? null : res, { httpError: httpError });

console.log('[' + lead.runId + '] ' + (lead.host || lead.qualifyUrl) + ' -> ' +
  verdict.fit + ' (' + verdict.category + ') :: ' + verdict.reason);

return [{ json: Object.assign({}, lead, { route: 'commit', verdict: verdict }) }];
