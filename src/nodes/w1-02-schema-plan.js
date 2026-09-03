// @requires: schema
// n8n Code node — "Plan Schema Changes" (Run Once for All Items)
//
// Input : the Airtable Metadata API response (GET /v0/meta/bases/{baseId}/tables)
// Output: one item per API call we must make, plus a plan summary item.
//
// Emits NOTHING destructive: only field creations and additive select-choice
// patches. The user's own columns are never in the output by construction.

var cfg = $('Init Config').first().json.cfg;
var meta = $input.first().json;

var plan = planSchema(meta, cfg.tableName, { manageOptional: cfg.manageOptionalFields });

if (!plan.ok) {
  throw new Error(
    'Airtable schema cannot be prepared automatically:\n  - ' +
    plan.blocking.join('\n  - ') +
    '\nNothing was changed. Fix these in the Airtable UI and re-run.'
  );
}

var items = [];

// Field creations: POST /v0/meta/bases/{baseId}/tables/{tableId}/fields
for (var i = 0; i < plan.createFields.length; i++) {
  items.push({
    json: {
      op: 'create-field',
      label: 'CREATE ' + plan.createFields[i].name + ' (' + plan.createFields[i].type + ')',
      method: 'POST',
      url: cfg.airtableMetaBase + '/bases/' + cfg.baseId + '/tables/' + plan.tableId + '/fields',
      body: plan.createFields[i]
    }
  });
}

// Additive select-choice patches: PATCH .../fields/{fieldId}
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

// Always emit the plan itself last so the summary node can find it even when
// there is nothing to change.
items.push({
  json: {
    op: 'plan-summary',
    tableId: plan.tableId,
    tableName: plan.tableName,
    changesRequired: items.length,
    created: plan.createFields.map(function (f) { return f.name; }),
    choicesAdded: plan.patchSelectFields.map(function (f) { return f.name; }),
    adopted: plan.adopted,
    notes: plan.notes
  }
});

return items;
