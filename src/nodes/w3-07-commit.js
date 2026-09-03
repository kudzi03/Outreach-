// @requires:
// n8n Code node — "Build Fit Commit" (Run Once for All Items)
//
// One Airtable PATCH per lead. `Fit Checked At` is always written, even on an
// "Unsure", so a lead we could not read is not re-attempted every hour.

var cfg = $('W3 Config').first().json.cfg;
var lead = $input.first().json;
var v = lead.verdict || {};

var reason = v.reason || 'No reason recorded.';
if (v.ok) {
  var facts = [];
  if (v.category && v.category !== 'unknown') facts.push(v.category);
  if (v.size && v.size !== 'unknown') facts.push(v.size);
  if (v.doesKitchens) facts.push('kitchens');
  if (v.doesBaths) facts.push('baths');
  if (v.hasExistingCrm) facts.push('has booking/CRM');
  if (facts.length) reason = reason + '  [' + facts.join(' · ') + ']';
}

return [{
  json: {
    runId: lead.runId,
    recordId: lead.recordId,
    email: lead.email,
    host: lead.host || null,
    url: lead.qualifyUrl || null,
    fit: v.fit || 'Unsure',
    category: v.category || 'unknown',
    ok: v.ok === true,
    inputTokens: v.inputTokens || 0,
    outputTokens: v.outputTokens || 0,
    patchUrl: cfg.airtableApiBase + '/' + cfg.baseId + '/' +
      encodeURIComponent(cfg.tableName) + '/' + lead.recordId,
    patchBody: {
      fields: {
        'Fit': v.fit || 'Unsure',
        'Fit Reason': reason.slice(0, 900),
        'Fit Checked At': new Date().toISOString()
      },
      typecast: true
    }
  }
}];
