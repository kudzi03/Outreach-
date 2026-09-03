// @requires: classify
// n8n Code node — "Normalize Inbound" (Run Once for Each Item)
//
// One shape out of two very different inputs:
//   * n8n IMAP Email trigger  -> {from, subject, text, headers, ...}
//   * Postmark inbound webhook -> {body:{From, Subject, TextBody, Headers:[...]}}
//
// Everything downstream depends only on this shape, so swapping the trigger
// never touches the classification or matching logic.

var raw = $json;
var src = raw.body && (raw.body.From || raw.body.FromFull) ? raw.body : raw;
var isWebhook = src !== raw;

var headers = {};
if (Array.isArray(src.Headers)) {
  // Postmark: [{Name, Value}, ...]
  for (var i = 0; i < src.Headers.length; i++) {
    headers[String(src.Headers[i].Name || '').toLowerCase()] = src.Headers[i].Value;
  }
} else if (src.headers && typeof src.headers === 'object') {
  headers = normalizeHeaders(src.headers);
}

var fromRaw = src.From || (src.FromFull && src.FromFull.Email) || src.from || headers['from'] || '';
var subject = src.Subject || src.subject || headers['subject'] || '';
var text = src.TextBody || src.text || src.textPlain || src.StrippedTextReply || src.textHtml || src.html || '';

// Strip HTML if that is all we were given — classification needs prose.
if (!src.TextBody && !src.text && /<[a-z][\s\S]*>/i.test(text)) {
  text = String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

var inReplyTo = src.InReplyTo || headers['in-reply-to'] || '';
var references = headers['references'] || '';
var toAddr = src.To || src.to || headers['to'] || '';

return {
  json: {
    source: isWebhook ? 'webhook' : 'imap',
    fromRaw: String(fromRaw),
    fromEmail: extractEmail(fromRaw),
    fromMatchKey: matchKey(fromRaw),
    toEmail: extractEmail(toAddr),
    subject: String(subject),
    text: String(text),
    headers: headers,
    inReplyTo: String(inReplyTo).trim(),
    references: String(references).trim(),
    receivedAt: src.Date || src.date || headers['date'] || new Date().toISOString()
  }
};
