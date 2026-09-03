// @requires: dates,queue
// n8n Code node — "Build Send Queue" (Run Once for All Items)
//
// The whole daily-cap and safety story lives here. Input is every candidate
// record returned by Airtable; output is at most `effectiveCap` items, each
// already carrying its touch, its wait, and its idempotency target.

var boot = $('Init Config').first().json;
var cfg = boot.cfg;

// Accept both shapes the HTTP node can produce: one item per Airtable page
// ({records:[...], offset}) or one item per record.
var records = [];
var incoming = $input.all();
for (var n = 0; n < incoming.length; n++) {
  var j = incoming[n].json;
  if (j && Array.isArray(j.records)) records = records.concat(j.records);
  else if (j && j.id) records.push(j);
}

var built = buildQueue(records, {
  now: cfg.now,
  timeZone: cfg.timeZone,
  holidays: cfg.holidays,
  dailyCap: boot.effectiveCap,
  staggerMinMinutes: cfg.staggerMinMinutes,
  staggerMaxMinutes: cfg.staggerMaxMinutes
});

var stats = built.stats;
stats.runId = cfg.runId;
stats.runDate = boot.runDate;
stats.configuredCap = cfg.dailyCap;
stats.effectiveCap = boot.effectiveCap;
stats.dryRun = cfg.dryRun;

// Log the skips: "why didn't lead X get an email today" must be answerable
// from the execution log alone.
console.log('[' + cfg.runId + '] queue=' + stats.queued + '/' + stats.fetched +
  ' byTouch=' + JSON.stringify(stats.byTouch) +
  ' finishes~' + stats.projectedFinishAt);
for (var s = 0; s < built.skipped.length; s++) {
  console.log('  skip ' + built.skipped[s].recordId + ' (' + built.skipped[s].email + '): ' + built.skipped[s].reason);
}

if (!built.queue.length) {
  return [{ json: { __empty: true, stats: stats, skipped: built.skipped } }];
}

return built.queue.map(function (lead) {
  return {
    json: {
      __empty: false,
      runId: cfg.runId,
      runDate: boot.runDate,
      recordId: lead.recordId,
      email: lead.email,
      firstName: lead.firstName,
      companyName: lead.companyName,
      city: lead.city,
      status: lead.status,
      touch: lead.touch,
      nextStatus: lead.nextStatus,
      dueReason: lead.dueReason,
      waitedBusinessDays: lead.waitedBusinessDays,
      verificationStatus: lead.verificationStatus,
      messageId: lead.messageId,
      threadSubject: lead.threadSubject,
      idempotencyTarget: lead.idempotencyTarget,
      position: lead.position,
      queueSize: lead.queueSize,
      waitSeconds: lead.waitSeconds,
      offsetSeconds: lead.offsetSeconds,
      plannedSendAt: lead.plannedSendAt,
      stats: lead.position === 1 ? stats : undefined
    }
  };
});
