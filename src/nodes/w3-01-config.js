// @requires:
// n8n Code node — "W3 Config" (Run Once for All Items)
//
// ---8<--- hoist
// ============================================================================
//                      >>>  FILL THIS IN. NOTHING ELSE.  <<<
// ============================================================================
// Workflow 3 reads each lead's website and decides whether they belong on the
// list at all. It NEVER writes any part of an email — the copy stays fixed and
// tested. See docs/QUALIFICATION.md for why.
//
// The first two must match Workflow 1 exactly.
// ============================================================================

var SETTINGS = {

  // --- Required — must match Workflow 1 ------------------------------------
  AIRTABLE_BASE_ID: '',
  AIRTABLE_TABLE_NAME: 'Leads',

  // --- Required: your Anthropic API key ------------------------------------
  // Get one at https://console.anthropic.com. The key itself lives in the n8n
  // credential "Anthropic API Key (Header Auth)" (Name: x-api-key), NOT here.
  // This just picks the model.
  CLAUDE_MODEL: '',             // default 'claude-sonnet-5'

  // --- Cost / pace ---------------------------------------------------------
  // Leads checked per run. At the default hourly schedule, 50/run clears
  // 1,200 leads a day for roughly $4 per 1,000.
  QUALIFY_PER_RUN: '',          // default 50
  CLAUDE_EFFORT: '',            // default 'low' — this is a short classification

  // --- Optional ------------------------------------------------------------
  SLACK_WEBHOOK_URL: '',        // blank = no summary posted
  // true = check every lead again, even ones already judged. Costs money.
  FORCE_REQUALIFY: ''           // default false

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

function settingNum(name, fallback) {
  var raw = setting(name, null);
  if (raw === null) return fallback;
  var n = Number(raw);
  return isFinite(n) ? n : fallback;
}

function settingBool(name, fallback) {
  var raw = setting(name, null);
  return raw === null ? fallback : /^(1|true|yes|on)$/i.test(raw);
}

var cfg = {
  runId: 'qual_' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14),
  now: new Date().toISOString(),

  airtableApiBase: 'https://api.airtable.com/v0',
  airtableMetaBase: 'https://api.airtable.com/v0/meta',
  baseId: setting('AIRTABLE_BASE_ID', ''),
  tableName: setting('AIRTABLE_TABLE_NAME', 'Leads'),

  claudeEndpoint: 'https://api.anthropic.com/v1/messages',
  claudeVersion: '2023-06-01',
  claudeModel: setting('CLAUDE_MODEL', 'claude-sonnet-5'),
  claudeEffort: setting('CLAUDE_EFFORT', 'low'),
  claudeMaxTokens: settingNum('CLAUDE_MAX_TOKENS', 2000),

  perRunCap: settingNum('QUALIFY_PER_RUN', 50),
  pageCharLimit: settingNum('PAGE_CHAR_LIMIT', 6000),
  fetchTimeoutMs: settingNum('PAGE_FETCH_TIMEOUT_MS', 15000),
  forceRequalify: settingBool('FORCE_REQUALIFY', false),

  slackWebhookUrl: setting('SLACK_WEBHOOK_URL', ''),

  // Published rates for claude-sonnet-5, used only for the cost estimate in
  // the run summary. Update if you switch model.
  pricing: { inputPerMillion: 2.0, outputPerMillion: 10.0 }
};

var missing = [];
if (!cfg.baseId) missing.push('AIRTABLE_BASE_ID');
if (!cfg.tableName) missing.push('AIRTABLE_TABLE_NAME');
if (cfg.perRunCap < 1 || cfg.perRunCap > 500) missing.push('QUALIFY_PER_RUN must be between 1 and 500');
if (missing.length) {
  throw new Error(
    'Setup is incomplete. Open this node ("W3 Config"), scroll to the SETTINGS ' +
    'block at the top, and fill in:\n  - ' + missing.join('\n  - ') +
    '\nNo lead was qualified.'
  );
}

console.log('[' + cfg.runId + '] qualifying up to ' + cfg.perRunCap +
  ' leads with ' + cfg.claudeModel + ' (effort ' + cfg.claudeEffort + ')');

return [{ json: { cfg: cfg } }];
