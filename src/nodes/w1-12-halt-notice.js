// @requires:
// n8n Code node — "Halt Notice" (Run Once for All Items)
//
// The no-op path: weekend, holiday, or outside the send window. Emitting a
// deliberate, readable item beats an empty execution nobody can interpret.

var boot = $('Init Config').first().json;
console.log('[' + boot.cfg.runId + '] no send today: ' + boot.haltReason);
return [{
  json: {
    runId: boot.cfg.runId,
    runDate: boot.runDate,
    sent: 0,
    halted: true,
    reason: boot.haltReason
  }
}];
