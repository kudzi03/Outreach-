// @requires: dates
// n8n Code node — "Init Config" (Run Once for All Items)
//
// ---8<--- hoist
// ============================================================================
//                      >>>  FILL THIS IN. NOTHING ELSE.  <<<
// ============================================================================
// This block is the only thing in Workflow 1 you need to edit. Type your values
// between the quote marks and hit Save.
//
// Leave a value as '' (empty) and it falls back to an n8n environment variable
// of the same name, then to the default shown in the comment. So: self-hosted
// users can leave this block empty and use env vars; everyone else — including
// anyone on n8n Cloud, where workflows cannot read env vars — just types here.
// ============================================================================

var SETTINGS = {

  // --- 1. AIRTABLE — required ----------------------------------------------
  // Base ID: from your Airtable URL, https://airtable.com/appXXXXXXXXXXXXXX/...
  AIRTABLE_BASE_ID: '',
  // The table name exactly as it appears in Airtable.
  AIRTABLE_TABLE_NAME: 'Leads',

  // --- 2. WHO THE EMAIL IS FROM — required ---------------------------------
  SENDER_NAME: '',              // e.g. 'Nat Marlowe'
  SENDER_EMAIL: '',             // e.g. 'nat@yourdomain.com'
  SENDER_COMPANY: '',           // e.g. 'Marlowe Automations'
  // A real physical address. Legally required on commercial email (CAN-SPAM).
  SENDER_POSTAL_ADDRESS: '',    // e.g. '1200 W 6th St, Austin, TX 78703'
  // Optional. Blank = replies go to SENDER_EMAIL.
  REPLY_TO_EMAIL: '',

  // --- 3. EMAIL VERIFICATION — required ------------------------------------
  // Your MillionVerifier API key: https://app.millionverifier.com/api
  MILLIONVERIFIER_API_KEY: '',

  // --- 4. TIMING -----------------------------------------------------------
  CAMPAIGN_TIMEZONE: '',        // default 'America/New_York'
  DAILY_SEND_CAP: '',           // default 30. Start at 5 on a new domain.
  SEND_WINDOW_START_HOUR: '',   // default 8   (8am)
  SEND_WINDOW_END_HOUR: '',     // default 18  (6pm)
  STAGGER_MIN_MINUTES: '',      // default 15
  STAGGER_MAX_MINUTES: '',      // default 20
  // Days to skip, comma separated: '2026-07-03,2026-11-26'
  CAMPAIGN_HOLIDAYS: '',

  // --- 5. OPTIONAL ---------------------------------------------------------
  SLACK_WEBHOOK_URL: '',        // blank = no Slack summary
  ALLOW_RISKY: '',              // default false. true = also mail catch-all domains.
  POSTMARK_MESSAGE_STREAM: '',  // default 'outbound'

  // --- 6. SAFETY SWITCH ----------------------------------------------------
  // true  = do everything EXCEPT actually send. Leave this on for your first run.
  // false = live.
  DRY_RUN: 'true'

};

// ============================================================================
//              Nothing below this line needs editing. Ever.
// ============================================================================
// ---8<--- end hoist

/** Read an n8n environment variable, if this instance allows it. */
function env(name) {
  try {
    var v = $env[name];
    if (v === undefined || v === null || String(v).trim() === '') return null;
    return String(v).trim();
  } catch (e) {
    // n8n Cloud, or N8N_BLOCK_ENV_ACCESS_IN_NODE=true. Not an error — the
    // SETTINGS block above is the supported path in that case.
    return null;
  }
}

/** SETTINGS wins, then the environment, then the built-in default. */
function setting(name, fallback) {
  var v = SETTINGS[name];
  if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  var e = env(name);
  return e === null ? fallback : e;
}

function settingNum(name, fallback) {
  var raw = setting(name, null);
  // Number(null) is 0, not NaN — without this guard an unset value would read
  // as a cap of 0 and the workflow would refuse to run for everyone on defaults.
  if (raw === null) return fallback;
  var n = Number(raw);
  return isFinite(n) ? n : fallback;
}

function settingBool(name, fallback) {
  var raw = setting(name, null);
  return raw === null ? fallback : /^(1|true|yes|on)$/i.test(raw);
}

var nowIso = new Date().toISOString();

var cfg = {
  runId: 'run_' + nowIso.replace(/[^0-9]/g, '').slice(0, 14) + '_' + Math.random().toString(36).slice(2, 8),
  now: nowIso,

  // --- Airtable -----------------------------------------------------------
  airtableApiBase: 'https://api.airtable.com/v0',
  airtableMetaBase: 'https://api.airtable.com/v0/meta',
  baseId: setting('AIRTABLE_BASE_ID', ''),
  tableName: setting('AIRTABLE_TABLE_NAME', 'Leads'),
  manageOptionalFields: settingBool('MANAGE_OPTIONAL_FIELDS', true),

  // --- Scheduling ---------------------------------------------------------
  timeZone: setting('CAMPAIGN_TIMEZONE', 'America/New_York'),
  holidays: setting('CAMPAIGN_HOLIDAYS', ''),
  dailyCap: settingNum('DAILY_SEND_CAP', 30),
  staggerMinMinutes: settingNum('STAGGER_MIN_MINUTES', 15),
  staggerMaxMinutes: settingNum('STAGGER_MAX_MINUTES', 20),
  sendWindowStartHour: settingNum('SEND_WINDOW_START_HOUR', 8),
  sendWindowEndHour: settingNum('SEND_WINDOW_END_HOUR', 18),

  // --- Verification -------------------------------------------------------
  millionVerifierKey: setting('MILLIONVERIFIER_API_KEY', ''),
  millionVerifierTimeout: settingNum('MILLIONVERIFIER_TIMEOUT_SECONDS', 20),
  allowRisky: settingBool('ALLOW_RISKY', false),
  forceReverify: settingBool('FORCE_REVERIFY', false),

  // --- Sending ------------------------------------------------------------
  emailProvider: setting('EMAIL_PROVIDER', 'postmark').toLowerCase(),
  postmarkEndpoint: 'https://api.postmarkapp.com/email',
  postmarkMessageStream: setting('POSTMARK_MESSAGE_STREAM', 'outbound'),
  postmarkMessageIdDomain: setting('POSTMARK_MESSAGE_ID_DOMAIN', 'mtasv.net'),
  senderName: setting('SENDER_NAME', ''),
  senderEmail: setting('SENDER_EMAIL', ''),
  senderCompany: setting('SENDER_COMPANY', ''),
  senderPostalAddress: setting('SENDER_POSTAL_ADDRESS', ''),
  replyToEmail: setting('REPLY_TO_EMAIL', ''),

  // --- Ops ----------------------------------------------------------------
  slackWebhookUrl: setting('SLACK_WEBHOOK_URL', ''),
  dryRun: settingBool('DRY_RUN', true)
};

cfg.fromHeader = cfg.senderName
  ? '"' + cfg.senderName.replace(/"/g, '') + '" <' + cfg.senderEmail + '>'
  : cfg.senderEmail;

// --- Preflight: refuse to run half-configured rather than half-send. ------
var missing = [];
if (!cfg.baseId) missing.push('AIRTABLE_BASE_ID');
if (!cfg.tableName) missing.push('AIRTABLE_TABLE_NAME');
if (!cfg.senderEmail) missing.push('SENDER_EMAIL');
if (!cfg.senderName) missing.push('SENDER_NAME');
if (!cfg.millionVerifierKey) missing.push('MILLIONVERIFIER_API_KEY');
if (!cfg.senderPostalAddress) missing.push('SENDER_POSTAL_ADDRESS (legally required on commercial email)');

if (cfg.dailyCap < 1 || cfg.dailyCap > 200) missing.push('DAILY_SEND_CAP must be between 1 and 200');
if (cfg.staggerMinMinutes < 0 || cfg.staggerMaxMinutes < cfg.staggerMinMinutes) {
  missing.push('STAGGER_MIN_MINUTES / STAGGER_MAX_MINUTES are inconsistent');
}
if (cfg.sendWindowEndHour <= cfg.sendWindowStartHour) {
  missing.push('SEND_WINDOW_END_HOUR must be later than SEND_WINDOW_START_HOUR');
}
if (missing.length) {
  throw new Error(
    'Setup is incomplete. Open this node ("Init Config"), scroll to the SETTINGS ' +
    'block at the top, and fill in:\n  - ' + missing.join('\n  - ') +
    '\nNothing was sent.'
  );
}

// --- Is today a sending day? ---------------------------------------------
var todayYMD = zonedYMD(cfg.now, cfg.timeZone);
var businessDay = isBusinessDayYMD(todayYMD, cfg.holidays);
var inWindow = isWithinSendWindow(cfg.now, cfg.timeZone, cfg.sendWindowStartHour, cfg.sendWindowEndHour);
var runway = secondsLeftInWindow(cfg.now, cfg.timeZone, cfg.sendWindowEndHour);

// How many sends can actually fit before the window closes, at the WORST
// case stagger? Trimming here is what stops a batch stranding half-sent.
var worstCaseGap = cfg.staggerMaxMinutes * 60;
var fitsInWindow = worstCaseGap > 0 ? Math.floor(runway / worstCaseGap) + 1 : cfg.dailyCap;
var effectiveCap = Math.max(0, Math.min(cfg.dailyCap, fitsInWindow));

var shouldRun = businessDay && inWindow && effectiveCap > 0;

console.log('[' + cfg.runId + '] ' + todayYMD + ' ' + cfg.timeZone +
  ' | cap ' + effectiveCap + '/' + cfg.dailyCap +
  ' | dryRun=' + cfg.dryRun +
  ' | run=' + shouldRun);

return [{
  json: {
    cfg: cfg,
    runDate: todayYMD,
    businessDay: businessDay,
    inSendWindow: inWindow,
    secondsLeftInWindow: runway,
    effectiveCap: effectiveCap,
    shouldRun: shouldRun,
    haltReason: shouldRun
      ? null
      : (!businessDay
          ? 'Not a business day (' + todayYMD + ').'
          : (!inWindow
              ? 'Outside the send window ' + cfg.sendWindowStartHour + ':00-' + cfg.sendWindowEndHour + ':00 ' + cfg.timeZone + '.'
              : 'Not enough time left in the send window for even one staggered send.'))
  }
}];
