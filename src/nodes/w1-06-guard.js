// @requires: dates,queue,verify
// n8n Code node — "Guard: Re-read & Re-check" (Run Once for All Items)
//
// SAFETY GUARANTEE #2.
//
// The queue is planned at 08:00; the last email leaves ~9 hours later. In that
// window a prospect can reply, an operator can mark Do Not Contact, or a
// retried execution can already have sent this exact touch. So immediately
// before every single send we re-read the record from Airtable and re-decide.
// Nothing downstream is allowed to send unless this node says proceed.

var cfg = $('Init Config').first().json.cfg;
// NOTE: reference the Wait node, not 'Loop Over Leads'. $('node').first()
// reads output branch 0, and on a splitInBatches node branch 0 is "done",
// which is empty mid-loop. The Wait node has a single output and passes
// the queued item straight through.
var intent = $('Stagger 15-20 min').first().json;  // the queued plan for this lead
var fresh = $input.first().json;                  // the record we just re-read

var verdict = guardBeforeSend(fresh, intent, { now: new Date().toISOString(), timeZone: cfg.timeZone });

if (!verdict.proceed) {
  console.log('[' + intent.runId + '] GUARD BLOCKED ' + intent.recordId + ' (' + intent.email + '): ' + verdict.reason);
  return [{ json: Object.assign({}, intent, { route: 'skip', guardCode: verdict.code, guardReason: verdict.reason }) }];
}

var lead = verdict.lead;

// Syntax gate before we spend a verification credit.
if (!looksLikeEmail(lead.email)) {
  return [{
    json: Object.assign({}, intent, {
      route: 'invalid',
      verificationStatus: 'Invalid',
      guardCode: 'malformed',
      guardReason: 'Email "' + lead.email + '" is not a syntactically valid address.'
    })
  }];
}

var mustVerify = needsVerification(lead, { allowRisky: cfg.allowRisky, forceReverify: cfg.forceReverify });

return [{
  json: Object.assign({}, intent, {
    route: mustVerify ? 'verify' : 'send',
    // Refresh from the authoritative copy — the queue snapshot may be stale.
    email: lead.email,
    firstName: lead.firstName,
    companyName: lead.companyName,
    city: lead.city,
    status: lead.status,
    verificationStatus: lead.verificationStatus,
    messageId: lead.messageId,
    threadSubject: lead.threadSubject,
    guardCode: 'ok',
    guardReason: verdict.reason,
    verifyUrl: mustVerify
      ? verifyUrl(cfg.millionVerifierKey, lead.email, cfg.millionVerifierTimeout)
      : null
  })
}];
