// @requires: dates
// n8n Code node — "Init Config" (Run Once for All Items)
//
// Single source of truth for every tunable in Workflow 1. Every later node
// reads it with $('Init Config').first().json.cfg, so nothing else touches
// $env and there is exactly one place to change a setting.

function env(name, fallback) {
  try {
    var v = $env[name];
    if (v === undefined || v === null || String(v).trim() === '') return fallback;
    return String(v).trim();
  } catch (e) {
    // N8N_BLOCK_ENV_ACCESS_IN_NODE=true. Fall back and report it below.
    return fallback;
  }
}

function envNum(name, fallback) {
  var raw = env(name, null);
  if (raw === null) return fallback;
  var n = Number(raw);
  return isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  var raw = env(name, null);
  if (raw === null) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

var nowIso = new Date().toISOString();

var cfg = {
  runId: 'run_' + nowIso.replace(/[^0-9]/g, '').slice(0, 14) + '_' + Math.random().toString(36).slice(2, 8),
  now: nowIso,

  // --- Airtable -----------------------------------------------------------
  airtableApiBase: 'https://api.airtable.com/v0',
  airtableMetaBase: 'https://api.airtable.com/v0/meta',
  baseId: env('AIRTABLE_BASE_ID', ''),
  tableName: env('AIRTABLE_TABLE_NAME', 'Leads'),
  manageOptionalFields: envBool('MANAGE_OPTIONAL_FIELDS', true),

  // --- Scheduling ---------------------------------------------------------
  timeZone: env('CAMPAIGN_TIMEZONE', 'America/New_York'),
  holidays: env('CAMPAIGN_HOLIDAYS', ''),
  dailyCap: envNum('DAILY_SEND_CAP', 30),
  staggerMinMinutes: envNum('STAGGER_MIN_MINUTES', 15),
  staggerMaxMinutes: envNum('STAGGER_MAX_MINUTES', 20),
  sendWindowStartHour: envNum('SEND_WINDOW_START_HOUR', 8),
  sendWindowEndHour: envNum('SEND_WINDOW_END_HOUR', 18),

  // --- Verification -------------------------------------------------------
  millionVerifierKey: env('MILLIONVERIFIER_API_KEY', ''),
  millionVerifierTimeout: envNum('MILLIONVERIFIER_TIMEOUT_SECONDS', 20),
  allowRisky: envBool('ALLOW_RISKY', false),
  forceReverify: envBool('FORCE_REVERIFY', false),

  // --- Sending ------------------------------------------------------------
  emailProvider: env('EMAIL_PROVIDER', 'postmark').toLowerCase(),
  postmarkEndpoint: 'https://api.postmarkapp.com/email',
  postmarkMessageStream: env('POSTMARK_MESSAGE_STREAM', 'outbound'),
  postmarkMessageIdDomain: env('POSTMARK_MESSAGE_ID_DOMAIN', 'mtasv.net'),
  senderName: env('SENDER_NAME', ''),
  senderEmail: env('SENDER_EMAIL', ''),
  senderCompany: env('SENDER_COMPANY', ''),
  senderPostalAddress: env('SENDER_POSTAL_ADDRESS', ''),
  replyToEmail: env('REPLY_TO_EMAIL', ''),

  // --- Ops ----------------------------------------------------------------
  slackWebhookUrl: env('SLACK_WEBHOOK_URL', ''),
  dryRun: envBool('DRY_RUN', false)
};

cfg.fromHeader = cfg.senderName
  ? '"' + cfg.senderName.replace(/"/g, '') + '" <' + cfg.senderEmail + '>'
  : cfg.senderEmail;

// --- Preflight: refuse to run half-configured rather than half-send. ------
var missing = [];
if (!cfg.baseId) missing.push('AIRTABLE_BASE_ID');
if (!cfg.tableName) missing.push('AIRTABLE_TABLE_NAME');
if (!cfg.senderEmail) missing.push('SENDER_EMAIL');
if (!cfg.millionVerifierKey) missing.push('MILLIONVERIFIER_API_KEY');
if (!cfg.senderPostalAddress) missing.push('SENDER_POSTAL_ADDRESS (required by CAN-SPAM)');

if (cfg.dailyCap < 1 || cfg.dailyCap > 200) missing.push('DAILY_SEND_CAP out of range 1-200');
if (cfg.staggerMinMinutes < 0 || cfg.staggerMaxMinutes < cfg.staggerMinMinutes) {
  missing.push('STAGGER_MIN_MINUTES / STAGGER_MAX_MINUTES inconsistent');
}
if (missing.length) {
  throw new Error(
    'Init Config: missing or invalid settings -> ' + missing.join(', ') +
    '. Set them as n8n environment variables (see .env.example). If your n8n has ' +
    'N8N_BLOCK_ENV_ACCESS_IN_NODE=true, unset it or hard-code the values in this node.'
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
              ? 'Outside send window ' + cfg.sendWindowStartHour + ':00-' + cfg.sendWindowEndHour + ':00 ' + cfg.timeZone + '.'
              : 'Not enough runway left in the send window for even one staggered send.'))
  }
}];
