// @requires: schema
// n8n Code node — "Plan Fit Columns" (Run Once for All Items)
//
// Provisions only the three columns Workflow 3 writes, so this workflow can be
// run before — or entirely without — Workflow 1. Same contract as Workflow 1's
// schema engine: create missing fields, extend select choices additively,
// never touch a user column, never retype or delete anything.

var cfg = $('W3 Config').first().json.cfg;
var meta = $input.first().json;

var plan = planSchema(meta, cfg.tableName, {
  only: ['Fit', 'Fit Reason', 'Fit Checked At']
});

if (!plan.ok) {
  throw new Error(
    'Cannot prepare the qualification columns:\n  - ' + plan.blocking.join('\n  - ') +
    '\nNothing was changed.'
  );
}

var items = [];
for (var i = 0; i < plan.createFields.length; i++) {
  items.push({
    json: {
      op: 'create-field',
      label: 'CREATE ' + plan.createFields[i].name,
      method: 'POST',
      url: cfg.airtableMetaBase + '/bases/' + cfg.baseId + '/tables/' + plan.tableId + '/fields',
      body: plan.createFields[i]
    }
  });
}
for (var p = 0; p < plan.patchSelectFields.length; p++) {
  var patch = plan.patchSelectFields[p];
  items.push({
    json: {
      op: 'patch-choices',
      label: 'ADD CHOICES to ' + patch.name + ': ' + patch.addedChoices.join(', '),
      method: 'PATCH',
      url: cfg.airtableMetaBase + '/bases/' + cfg.baseId + '/tables/' + plan.tableId + '/fields/' + patch.fieldId,
      body: patch.body
    }
  });
}

items.push({
  json: {
    op: 'plan-summary',
    tableId: plan.tableId,
    tableName: plan.tableName,
    created: plan.createFields.map(function (f) { return f.name; }),
    choicesAdded: plan.patchSelectFields.map(function (f) { return f.name; }),
    adopted: plan.adopted,
    notes: plan.notes
  }
});

return items;
