// @requires:
// n8n Code node — "W2 Config" (Run Once for All Items)
// Same single-source-of-truth pattern as Workflow 1.

function env(name, fallback) {
  try {
    var v = $env[name];
    if (v === undefined || v === null || String(v).trim() === '') return fallback;
    return String(v).trim();
  } catch (e) { return fallback; }
}
function envBool(name, fallback) {
  var raw = env(name, null);
  return raw === null ? fallback : /^(1|true|yes|on)$/i.test(raw);
}

var cfg = {
  airtableApiBase: 'https://api.airtable.com/v0',
  baseId: env('AIRTABLE_BASE_ID', ''),
  tableName: env('AIRTABLE_TABLE_NAME', 'Leads'),
  slackWebhookUrl: env('SLACK_WEBHOOK_URL', ''),
  notifyOnOptOut: envBool('NOTIFY_ON_OPT_OUT', false),
  twilioEnabled: envBool('SMS_ENABLED', false),
  twilioAccountSid: env('TWILIO_ACCOUNT_SID', ''),
  twilioFrom: env('TWILIO_FROM_NUMBER', ''),
  twilioTo: env('SMS_ALERT_TO_NUMBER', '')
};

if (!cfg.baseId) throw new Error('W2 Config: AIRTABLE_BASE_ID is not set.');

// Pass the inbound message THROUGH with cfg attached. This node sits in the
// data path only so that later nodes can reach it via $('W2 Config'); it must
// not swallow the email it was handed.
var incoming = $input.all();
if (!incoming.length) return [{ json: { cfg: cfg } }];
return incoming.map(function (item) {
  return { json: Object.assign({}, item.json, { cfg: cfg }) };
});
