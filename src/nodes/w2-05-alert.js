// @requires:
// n8n Code node — "Build Alert" (Run Once for All Items)
// Shapes the Slack payload and the optional SMS body.

var cfg = $('W2 Config').first().json.cfg;
var item = $json;

var text = item.alertText || '';
var sms = null;
if (cfg.twilioEnabled && item.action === 'replied') {
  sms = 'Reply from ' + (item.leadName || item.fromEmail) +
    (item.sentiment === 'positive' ? ' (POSITIVE)' : '') + ': ' +
    String(item.cleanText || '').replace(/\s+/g, ' ').slice(0, 200);
}

return [{
  json: Object.assign({}, item, {
    slackPayload: { text: text },
    smsBody: sms,
    sendSms: !!sms && !!cfg.twilioTo && !!cfg.twilioFrom
  })
}];
