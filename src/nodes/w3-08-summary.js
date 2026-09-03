// @requires: qualify
// n8n Code node — "Qualification Summary" (Run Once for All Items)
//
// Runs once after the loop drains. Reports what was judged and what it cost.

var cfg = $('W3 Config').first().json.cfg;

var results = [];
for (var run = 0; run < 1000; run++) {
  var chunk;
  try {
    chunk = $('Build Fit Commit').all(0, run);
  } catch (e) {
    break;
  }
  if (!chunk || !chunk.length) break;
  for (var k = 0; k < chunk.length; k++) results.push(chunk[k].json);
}

var counts = { Yes: 0, Unsure: 0, No: 0 };
var byCategory = {};
var inputTokens = 0;
var outputTokens = 0;
var examples = [];

for (var i = 0; i < results.length; i++) {
  var r = results[i];
  if (counts[r.fit] === undefined) counts[r.fit] = 0;
  counts[r.fit]++;
  byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  inputTokens += r.inputTokens || 0;
  outputTokens += r.outputTokens || 0;
  if (r.fit === 'No' && examples.length < 8) {
    examples.push((r.host || r.email) + ' — ' + r.category);
  }
}

var cost = estimateCost(inputTokens, outputTokens, cfg.pricing);
var judged = results.length;
var rejected = counts.No || 0;
var rejectRate = judged ? Math.round((rejected / judged) * 100) : 0;

var lines = [
  ':mag: *Lead qualification — ' + judged + ' checked*',
  '• Fit: *' + (counts.Yes || 0) + ' yes* · ' + (counts.Unsure || 0) + ' unsure · ' + rejected + ' no  (' + rejectRate + '% rejected)',
  '• Cost: ~$' + cost.toFixed(3) + '  (' + inputTokens + ' in / ' + outputTokens + ' out tokens, ' + cfg.claudeModel + ')',
  '• Only "no" is skipped by the sender. Unsure and unchecked leads are still contacted.'
];
if (examples.length) lines.push('Rejected: ```' + examples.join('\n') + '```');

console.log('[' + cfg.runId + '] judged=' + judged + ' yes=' + (counts.Yes || 0) +
  ' unsure=' + (counts.Unsure || 0) + ' no=' + rejected + ' cost=$' + cost.toFixed(4));

return [{
  json: {
    runId: cfg.runId,
    judged: judged,
    counts: counts,
    byCategory: byCategory,
    rejectRatePercent: rejectRate,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    estimatedCostUsd: Number(cost.toFixed(4)),
    slackPayload: { text: lines.join('\n') },
    notify: !!cfg.slackWebhookUrl && judged > 0
  }
}];
