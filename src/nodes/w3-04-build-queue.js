// @requires: qualify
// n8n Code node — "Build Qualification Queue" (Run Once for All Items)
//
// Resolves a website for each lead (Website column, else the email domain),
// drops free-mailbox leads and same-domain duplicates, and caps the run.

var cfg = $('W3 Config').first().json.cfg;

var records = [];
var incoming = $input.all();
for (var n = 0; n < incoming.length; n++) {
  var j = incoming[n].json;
  if (j && Array.isArray(j.records)) records = records.concat(j.records);
  else if (j && j.id) records.push(j);
}

var built = buildQualifyQueue(records, { perRunCap: cfg.perRunCap });

console.log('[' + cfg.runId + '] queue=' + built.stats.queued + '/' + built.stats.fetched +
  ' (' + built.stats.skipped + ' skipped)');

// Leads with no readable site still get a row written, so they are not
// re-attempted every hour forever. "Unsure" means they are still contacted.
var unresolvable = built.skipped.filter(function (s) { return s.unresolvable; });
for (var u = 0; u < unresolvable.length; u++) {
  console.log('  no site ' + unresolvable[u].recordId + ': ' + unresolvable[u].reason);
}

var items = built.queue.map(function (lead) {
  return {
    json: {
      runId: cfg.runId,
      recordId: lead.recordId,
      email: lead.email,
      companyName: lead.companyName,
      city: lead.city,
      qualifyUrl: lead.qualifyUrl,
      urlSource: lead.urlSource,
      host: lead.host,
      position: lead.position,
      queueSize: lead.queueSize,
      route: 'fetch'
    }
  };
});

// Append the unreadable ones so they flow through the same commit path.
for (var v = 0; v < unresolvable.length; v++) {
  items.push({
    json: {
      runId: cfg.runId,
      recordId: unresolvable[v].recordId,
      email: unresolvable[v].email,
      qualifyUrl: null,
      route: 'unreadable',
      verdict: {
        fit: 'Unsure',
        category: 'unknown',
        size: 'unknown',
        doesKitchens: false,
        doesBaths: false,
        hasExistingCrm: false,
        reason: unresolvable[v].reason,
        inputTokens: 0,
        outputTokens: 0,
        ok: false
      }
    }
  });
}

if (!items.length) {
  return [{ json: { __empty: true, runId: cfg.runId, stats: built.stats } }];
}
items[0].json.stats = built.stats;
return items;
