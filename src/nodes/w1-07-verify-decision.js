// @requires: verify
// n8n Code node — "Verification Gate" (Run Once for All Items)
//
// Input: the MillionVerifier response (the HTTP node runs with
// onError=continueRegularOutput so an outage reaches us as data, not a crash).

var cfg = $('Init Config').first().json.cfg;
var intent = $('Guard: Re-read & Re-check').first().json;
var response = $input.first().json || {};

var httpError = response.error && !response.result ? response.error : null;
var mapped = mapVerification(httpError ? null : response, { allowRisky: cfg.allowRisky, httpError: httpError });

console.log('[' + intent.runId + '] verify ' + intent.email + ' -> ' +
  (mapped.verificationStatus || 'PENDING') + ' (' + mapped.decision + ') ' + mapped.reason);

var route = mapped.decision === 'send'
  ? 'send'
  : (mapped.decision === 'halt' ? 'invalid' : 'defer');

return [{
  json: Object.assign({}, intent, {
    route: route,
    verificationStatus: mapped.verificationStatus,
    verificationRaw: mapped.raw,
    verificationReason: mapped.reason,
    // 'defer' leaves Status untouched: a verifier outage must never burn a lead.
    guardReason: mapped.reason
  })
}];
