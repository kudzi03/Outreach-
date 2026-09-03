// @requires: templates
// n8n Code node — "Build Email" (Run Once for All Items)
//
// Fed by all three Switch branches; exactly one of them carries data per lead.
// Produces a provider-agnostic message plus a ready-to-POST Postmark body.

var cfg = $('Init Config').first().json.cfg;
var lead = $input.first().json;

var msg = buildMessage(lead.touch, {
  firstName: lead.firstName,
  companyName: lead.companyName,
  threadSubject: lead.threadSubject,
  messageId: lead.messageId
}, {
  senderName: cfg.senderName,
  senderCompany: cfg.senderCompany,
  senderPostalAddress: cfg.senderPostalAddress,
  // Gates what the follow-ups are allowed to claim. See "Init Config".
  remodelersInterviewed: cfg.remodelersInterviewed,
  remodelerClients: cfg.remodelerClients
});

var headers = msg.headers.slice();

var postmarkBody = {
  From: cfg.fromHeader,
  To: lead.email,
  Subject: msg.subject,
  TextBody: msg.textBody,
  MessageStream: cfg.postmarkMessageStream,
  TrackOpens: false,   // no tracking pixel: reputation over vanity metrics
  TrackLinks: 'None'
};
if (cfg.replyToEmail) postmarkBody.ReplyTo = cfg.replyToEmail;
if (headers.length) postmarkBody.Headers = headers;

// Touch 1 defines the thread; store its subject so follow-ups can say "Re: ".
var threadSubject = msg.isReply ? (lead.threadSubject || msg.subject.replace(/^re:\s*/i, '')) : msg.subject;

console.log('[' + lead.runId + '] build ' + lead.touch + ' -> ' + lead.email +
  ' | subject="' + msg.subject + '"' + (msg.isReply ? ' | in-reply-to=' + lead.messageId : ''));

return [{
  json: Object.assign({}, lead, {
    subject: msg.subject,
    textBody: msg.textBody,
    isReply: msg.isReply,
    threadSubject: threadSubject,
    outboundHeaders: headers,
    postmarkBody: postmarkBody,
    dryRun: cfg.dryRun
  })
}];
