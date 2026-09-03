// @requires:
// n8n Code node — "Run Summary" (Run Once for All Items)
//
// Runs once after the loop drains. Produces the one message an operator reads
// each morning to know the campaign is healthy.

var boot = $('Init Config').first().json;
var cfg = boot.cfg;

// A node inside a SplitInBatches loop runs once per iteration, and .all()
// returns only the LAST run. Walk every run index to get the whole batch.
var results = [];
for (var run = 0; run < 1000; run++) {
  var chunk;
  try {
    chunk = $('Build Airtable Commit').all(0, run);
  } catch (e) {
    break;
  }
  if (!chunk || !chunk.length) break;
  for (var k = 0; k < chunk.length; k++) results.push(chunk[k].json);
}

var counts = { sent: 0, invalid: 0, failed: 0, skipped: 0 };
var byTouch = { email1: 0, followup1: 0, followup2: 0 };
var failures = [];

for (var i = 0; i < results.length; i++) {
  var r = results[i];
  var bucket = counts[r.route] === undefined ? 'skipped' : r.route;
  counts[bucket]++;
  if (r.route === 'sent' && byTouch[r.touch] !== undefined) byTouch[r.touch]++;
  if (r.route === 'failed') failures.push(r.email + ': ' + (r.patchBody.fields['Last Error'] || '').slice(0, 160));
}

var healthy = counts.failed === 0;
var lines = [
  (healthy ? ':white_check_mark:' : ':warning:') + ' *Kitchen & Bath outreach — ' + boot.runDate + '*',
  '• Sent: *' + counts.sent + '* / cap ' + cfg.dailyCap +
    '  (touch1 ' + byTouch.email1 + ', fu1 ' + byTouch.followup1 + ', fu2 ' + byTouch.followup2 + ')',
  '• Verification halts: ' + counts.invalid,
  '• Send failures: ' + counts.failed + (counts.failed ? '  _(status left unchanged — retried next run)_' : ''),
  '• Guard skips: ' + counts.skipped
];
if (cfg.dryRun) lines.push('• :test_tube: DRY_RUN was ON — no mail left the building.');
if (failures.length) lines.push('```' + failures.slice(0, 10).join('\n') + '```');

return [{
  json: {
    runId: cfg.runId,
    runDate: boot.runDate,
    healthy: healthy,
    counts: counts,
    byTouch: byTouch,
    slackPayload: { text: lines.join('\n') },
    notify: !!cfg.slackWebhookUrl
  }
}];
