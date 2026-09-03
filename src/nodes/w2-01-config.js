// @requires:
// n8n Code node — "W2 Config" (Run Once for All Items)
//
// ---8<--- hoist
// ============================================================================
//                      >>>  FILL THIS IN. NOTHING ELSE.  <<<
// ============================================================================
// The only thing in Workflow 2 you need to edit. The first two must match
// Workflow 1 exactly — that shared Airtable table is how the two workflows
// talk to each other.
//
// Leave a value as '' and it falls back to an n8n environment variable of the
// same name, then to the default in the comment.
// ============================================================================

var SETTINGS = {

  // --- Required — must match Workflow 1 ------------------------------------
  AIRTABLE_BASE_ID: '',
  AIRTABLE_TABLE_NAME: 'Leads',

  // --- Optional: get pinged when someone replies ---------------------------
  SLACK_WEBHOOK_URL: '',        // blank = no Slack alerts
  NOTIFY_ON_OPT_OUT: '',        // default false. Opt-outs are usually just noise.

  // --- Optional: text message on a reply (Twilio) --------------------------
  SMS_ENABLED: '',              // default false
  TWILIO_ACCOUNT_SID: '',
  TWILIO_FROM_NUMBER: '',       // the Twilio number sending the alert
  SMS_ALERT_TO_NUMBER: ''       // your phone

};

// ============================================================================
//              Nothing below this line needs editing. Ever.
// ============================================================================
// ---8<--- end hoist

function env(name) {
  try {
    var v = $env[name];
    if (v === undefined || v === null || String(v).trim() === '') return null;
    return String(v).trim();
  } catch (e) {
    return null;
  }
}

function setting(name, fallback) {
  var v = SETTINGS[name];
  if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  var e = env(name);
  return e === null ? fallback : e;
}

function settingBool(name, fallback) {
  var raw = setting(name, null);
  return raw === null ? fallback : /^(1|true|yes|on)$/i.test(raw);
}

var cfg = {
  airtableApiBase: 'https://api.airtable.com/v0',
  baseId: setting('AIRTABLE_BASE_ID', ''),
  tableName: setting('AIRTABLE_TABLE_NAME', 'Leads'),
  slackWebhookUrl: setting('SLACK_WEBHOOK_URL', ''),
  notifyOnOptOut: settingBool('NOTIFY_ON_OPT_OUT', false),
  twilioEnabled: settingBool('SMS_ENABLED', false),
  twilioAccountSid: setting('TWILIO_ACCOUNT_SID', ''),
  twilioFrom: setting('TWILIO_FROM_NUMBER', ''),
  twilioTo: setting('SMS_ALERT_TO_NUMBER', '')
};

if (!cfg.baseId) {
  throw new Error(
    'Setup is incomplete. Open this node ("W2 Config"), scroll to the SETTINGS ' +
    'block at the top, and fill in AIRTABLE_BASE_ID — the same value you put in ' +
    'Workflow 1. No reply was processed.'
  );
}
if (cfg.twilioEnabled && (!cfg.twilioAccountSid || !cfg.twilioFrom || !cfg.twilioTo)) {
  throw new Error(
    'SMS_ENABLED is true but TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER and ' +
    'SMS_ALERT_TO_NUMBER are not all set. Fill them in, or set SMS_ENABLED to false.'
  );
}

// Pass the inbound message THROUGH with cfg attached. This node sits in the
// data path only so that later nodes can reach it via $('W2 Config'); it must
// not swallow the email it was handed.
var incoming = $input.all();
if (!incoming.length) return [{ json: { cfg: cfg } }];
return incoming.map(function (item) {
  return { json: Object.assign({}, item.json, { cfg: cfg }) };
});
