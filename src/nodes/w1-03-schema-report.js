// @requires:
// n8n Code node — "Schema Report" (Run Once for All Items)
//
// Runs exactly once, on the "done" output of the schema loop, so the main
// pipeline downstream of it can never be executed twice.
//
// It reads the plan from the planning node and the results from every loop
// iteration of the apply node, then either reports what changed or aborts the
// run. Aborting matters: continuing without a `Status` column would have the
// dispatcher write into a field that does not exist, once per lead.

var plan = [];
try {
  plan = $('Plan Schema Changes').all().map(function (i) { return i.json; });
} catch (e) {
  plan = [];
}

var summary = null;
var expected = [];
for (var p = 0; p < plan.length; p++) {
  if (plan[p].op === 'plan-summary') summary = plan[p];
  else expected.push(plan[p]);
}

// The apply node runs once per iteration, and .all() returns only the last
// run — walk every run index to collect the whole set.
var responses = [];
for (var run = 0; run < 200; run++) {
  var chunk;
  try {
    chunk = $('Apply Schema Change').all(0, run);
  } catch (e) {
    break; // the node never executed: there was nothing to change
  }
  if (!chunk || !chunk.length) break;
  for (var k = 0; k < chunk.length; k++) responses.push(chunk[k].json);
}

var applied = [];
var failed = [];
for (var r = 0; r < responses.length; r++) {
  var res = responses[r];
  if (res && (res.error || res.message === 'ERROR')) {
    failed.push(res.error || res);
  } else if (res && (res.id || res.name || res.type || res.options)) {
    applied.push(res.name || res.id);
  }
}

if (failed.length || applied.length < expected.length) {
  throw new Error(
    'Airtable schema changes did not all succeed (' + applied.length + ' of ' +
    expected.length + ' applied).\n' +
    'Planned: ' + expected.map(function (e) { return e.label; }).join(' | ') + '\n' +
    (failed.length ? 'Errors: ' + JSON.stringify(failed).slice(0, 900) + '\n' : '') +
    'Most common cause: the Personal Access Token is missing the ' +
    '"schema.bases:write" scope, or this base is not in the token\'s access list. ' +
    'Nothing was sent.'
  );
}

var report = {
  schemaReady: true,
  hasFitField: summary ? summary.hasFitField === true : false,
  tableId: summary ? summary.tableId : null,
  tableName: summary ? summary.tableName : null,
  fieldsCreated: summary ? (summary.created || []) : [],
  choicesAdded: summary ? (summary.choicesAdded || []) : [],
  fieldsAdopted: summary ? (summary.adopted || []) : [],
  notes: summary ? (summary.notes || []) : [],
  appliedCalls: applied
};

if (applied.length) {
  console.log('[schema] applied ' + applied.length + ' change(s): ' + applied.join(', '));
} else {
  console.log('[schema] no changes needed — base already matches.');
}
for (var n = 0; n < report.notes.length; n++) console.log('[schema] note: ' + report.notes[n]);

return [{ json: report }];
