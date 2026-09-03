// @requires:
// n8n Code node — "Parse Send Result" (Run Once for All Items)
//
// The send node runs with onError=continueRegularOutput, so both success and
// failure arrive here as data and the loop is never torn down mid-batch.
//
// Message-ID: Postmark's REST response returns a bare UUID in `MessageID`;
// the RFC 5322 header it actually stamps on the message is
// <MessageID@mtasv.net>. That reconstructed value is what the prospect's mail
// client will thread on, so it is what we store.

var cfg = $('Init Config').first().json.cfg;
var lead = $('Build Email').first().json;
var res = $input.first().json || {};

function rfcMessageId(raw) {
  if (!raw) return '';
  var id = String(raw).trim();
  if (id.charAt(0) === '<') return id;
  if (id.indexOf('@') === -1) id = id + '@' + cfg.postmarkMessageIdDomain;
  return '<' + id + '>';
}

var sentAt = new Date().toISOString();

if (cfg.dryRun) {
  return [{
    json: Object.assign({}, lead, {
      route: 'sent',
      dryRun: true,
      sentAt: sentAt,
      sentMessageId: rfcMessageId('dryrun-' + lead.recordId + '-' + lead.touch),
      sendReport: 'DRY_RUN=true — nothing was actually sent.'
    })
  }];
}

// Postmark: ErrorCode 0 means accepted. Anything else (or a transport failure
// surfaced by n8n as {error:...}) is a send failure.
var errorCode = res.ErrorCode === undefined ? null : Number(res.ErrorCode);
var transportError = res.error || res.__error || null;
var accepted = !transportError && (errorCode === 0 || (errorCode === null && !!res.MessageID));

if (!accepted) {
  var detail = transportError
    ? (typeof transportError === 'string' ? transportError : JSON.stringify(transportError))
    : ('Postmark ErrorCode ' + errorCode + ': ' + (res.Message || 'unknown'));
  console.log('[' + lead.runId + '] SEND FAILED ' + lead.recordId + ' (' + lead.email + '): ' + detail);
  return [{
    json: Object.assign({}, lead, {
      route: 'failed',
      sentAt: sentAt,
      sendError: detail.slice(0, 900)
    })
  }];
}

var messageId = rfcMessageId(res.MessageID || res.MessageId || '');
console.log('[' + lead.runId + '] SENT ' + lead.touch + ' ' + lead.email + ' msgid=' + messageId);

return [{
  json: Object.assign({}, lead, {
    route: 'sent',
    sentAt: sentAt,
    sentMessageId: messageId,
    providerMessageId: res.MessageID || null,
    sendReport: 'Accepted by Postmark at ' + (res.SubmittedAt || sentAt)
  })
}];
