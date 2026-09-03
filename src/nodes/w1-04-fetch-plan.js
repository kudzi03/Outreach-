// @requires: dates,queue
// n8n Code node — "Plan Lead Fetch" (Run Once for All Items)
//
// Emits the Airtable list-records request. The filterByFormula comes from
// queue.js so the "never load a terminal record" rule is written once and used
// by both the fetch and the in-memory eligibility check.

var boot = $('Init Config').first().json;
var cfg = boot.cfg;
var schema = $input.first().json;

return [{
  json: {
    schemaReady: schema.schemaReady === true,
    fieldsCreated: schema.fieldsCreated || [],
    notes: schema.notes || [],
    listUrl: cfg.airtableApiBase + '/' + cfg.baseId + '/' + encodeURIComponent(cfg.tableName),
    filterByFormula: fetchFormula(),
    pageSize: 100,
    effectiveCap: boot.effectiveCap
  }
}];
