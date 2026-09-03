// @requires: qualify
// n8n Code node — "Fit Columns Ready" (Run Once for All Items)
//
// Fires once, on the schema loop's "done" output, and emits the Airtable fetch
// for leads that still need checking.

var cfg = $('W3 Config').first().json.cfg;

var plan = [];
try {
  plan = $('Plan Fit Columns').all().map(function (i) { return i.json; });
} catch (e) {
  plan = [];
}

var summary = null;
var expected = [];
for (var p = 0; p < plan.length; p++) {
  if (plan[p].op === 'plan-summary') summary = plan[p];
  else expected.push(plan[p]);
}

var responses = [];
for (var run = 0; run < 50; run++) {
  var chunk;
  try {
    chunk = $('Apply Fit Column Change').all(0, run);
  } catch (e) {
    break;
  }
  if (!chunk || !chunk.length) break;
  for (var k = 0; k < chunk.length; k++) responses.push(chunk[k].json);
}

var applied = [];
var failed = [];
for (var r = 0; r < responses.length; r++) {
  var res = responses[r];
  if (res && res.error) failed.push(res.error);
  else if (res && (res.id || res.name || res.options)) applied.push(res.name || res.id);
}

if (failed.length || applied.length < expected.length) {
  throw new Error(
    'Could not create the qualification columns (' + applied.length + ' of ' +
    expected.length + ').\n' +
    (failed.length ? JSON.stringify(failed).slice(0, 700) + '\n' : '') +
    'The Airtable token needs the "schema.bases:write" scope. No lead was qualified.'
  );
}

if (applied.length) console.log('[' + cfg.runId + '] created: ' + applied.join(', '));

// FORCE_REQUALIFY widens the fetch to every uncontacted lead, judged or not.
var formula = cfg.forceRequalify
  ? 'AND({Email} != "", OR({Status} = "", {Status} = "New", {Status} = "Queued"))'
  : qualifyFetchFormula();

return [{
  json: {
    schemaReady: true,
    tableId: summary ? summary.tableId : null,
    columnsCreated: applied,
    listUrl: cfg.airtableApiBase + '/' + cfg.baseId + '/' + encodeURIComponent(cfg.tableName),
    filterByFormula: formula,
    pageSize: 100
  }
}];
