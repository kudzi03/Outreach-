'use strict';
/**
 * schema.js — Airtable Metadata API schema check.
 *
 * Contract, in priority order:
 *   1. NEVER touch a user column. `First Name`, `Company Name`, `Email` and
 *      `City` are protected: we do not rename, retype or delete them, and we
 *      never issue a destructive request of any kind. The Metadata API we use
 *      can only CREATE fields and ADD single-select choices.
 *   2. If a system field already exists under a DIFFERENT but workable type
 *      (e.g. `Status` as a plain text column), adopt it as-is and report a
 *      note. Airtable cannot convert a field's type over the API, and
 *      dropping/recreating would destroy data — so we adapt to the base
 *      rather than forcing the base to adapt to us.
 *   3. Only genuinely absent fields are created.
 */

var SCHEMA_STATUS_CHOICES = [
  'New',
  'Invalid',
  'Queued',
  'Sent Email 1',
  'Sent Follow-up 1',
  'Sent Follow-up 2',
  'Replied',
  'Do Not Contact'
];

var SCHEMA_FIT_CHOICES = ['Yes', 'Unsure', 'No', 'Unchecked'];

// Columns owned by the user. Present here purely so we can assert we never
// emit a mutation for them, and so we can warn loudly if one is missing.
var SCHEMA_PROTECTED_FIELDS = ['First Name', 'Company Name', 'Email', 'City'];

/**
 * The fields this system needs.
 *
 * `required` fields are named in the brief. The rest are the bookkeeping the
 * brief's own requirements imply — RFC-5322 threading needs a stored
 * Message-ID, and "ultra-reliable" needs an idempotency key and an error
 * column. Set `MANAGE_OPTIONAL_FIELDS=false` to create only the required set.
 */
function desiredFields(opts) {
  var o = opts || {};
  var tz = o.timeZone || 'utc';
  var dateOpts = {
    dateFormat: { name: 'iso' },
    timeFormat: { name: '24hour' },
    timeZone: 'utc' // store UTC; all display/logic conversion happens in code
  };

  var required = [
    {
      name: 'Status',
      type: 'singleSelect',
      description: 'Outreach state machine. Managed by n8n.',
      options: { choices: SCHEMA_STATUS_CHOICES.map(function (c) { return { name: c }; }) },
      // Adopting a text column is fine: the sequencer compares strings.
      acceptableExistingTypes: ['singleSelect', 'singleLineText', 'multilineText']
    },
    {
      name: 'Last Contacted Date',
      type: 'dateTime',
      description: 'UTC timestamp of the last outbound touch. Managed by n8n.',
      options: dateOpts,
      acceptableExistingTypes: ['dateTime', 'date', 'singleLineText']
    },
    {
      name: 'Verification Status',
      type: 'singleLineText',
      description: 'MillionVerifier verdict: Valid | Risky | Invalid. Managed by n8n.',
      acceptableExistingTypes: ['singleLineText', 'singleSelect', 'multilineText']
    }
  ];

  var optional = [
    {
      name: 'Message ID',
      type: 'singleLineText',
      description: 'RFC 5322 Message-ID of touch 1, so follow-ups thread.',
      acceptableExistingTypes: ['singleLineText', 'multilineText']
    },
    {
      name: 'Thread Subject',
      type: 'singleLineText',
      description: 'Subject of touch 1, reused as "Re: ..." on follow-ups.',
      acceptableExistingTypes: ['singleLineText', 'multilineText']
    },
    {
      name: 'Idempotency Key',
      type: 'singleLineText',
      description: 'recordId:touch of the last committed send. Blocks duplicates on retry.',
      acceptableExistingTypes: ['singleLineText', 'multilineText']
    },
    {
      name: 'Last Error',
      type: 'multilineText',
      description: 'Most recent send/verification failure. Cleared on success.',
      acceptableExistingTypes: ['multilineText', 'singleLineText']
    },
    {
      name: 'Reply Received At',
      type: 'dateTime',
      description: 'UTC timestamp of the inbound reply detected by Workflow 2.',
      options: dateOpts,
      acceptableExistingTypes: ['dateTime', 'date', 'singleLineText']
    }
  ].concat(fitFields(dateOpts));

  void tz;
  return o.manageOptional === false
    ? restrict(required, o.only)
    : restrict(required.concat(optional), o.only);
}

/**
 * Columns written by Workflow 3 (the qualification pass). Kept separate so
 * Workflow 3 can provision just these three and run standalone.
 */
function fitFields(dateOpts) {
  return [
    {
      name: 'Fit',
      type: 'singleSelect',
      description: 'Workflow 3 verdict: Yes | Unsure | No | Unchecked. Only "No" is skipped.',
      options: { choices: SCHEMA_FIT_CHOICES.map(function (c) { return { name: c }; }) },
      acceptableExistingTypes: ['singleSelect', 'singleLineText', 'multilineText']
    },
    {
      name: 'Fit Reason',
      type: 'multilineText',
      description: 'One-line justification from the qualification pass, with evidence.',
      acceptableExistingTypes: ['multilineText', 'singleLineText']
    },
    {
      name: 'Fit Checked At',
      type: 'dateTime',
      description: 'UTC timestamp of the last qualification check.',
      options: dateOpts || { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' },
      acceptableExistingTypes: ['dateTime', 'date', 'singleLineText']
    }
  ];
}

/** Narrow a field list to a named subset, preserving order. */
function restrict(fields, only) {
  if (!only || !only.length) return fields;
  var wanted = only.map(function (n) { return String(n).toLowerCase(); });
  return fields.filter(function (f) { return wanted.indexOf(f.name.toLowerCase()) !== -1; });
}



/** Find a table by id or (case-insensitive) name in a Metadata API payload. */
function findTable(metaResponse, tableIdOrName) {
  var tables = (metaResponse && metaResponse.tables) || [];
  var needle = String(tableIdOrName || '').trim().toLowerCase();
  for (var i = 0; i < tables.length; i++) {
    var t = tables[i];
    if (t.id === tableIdOrName) return t;
    if (String(t.name || '').toLowerCase() === needle) return t;
  }
  return null;
}

function fieldByName(table, name) {
  var fields = (table && table.fields) || [];
  var needle = String(name).toLowerCase();
  for (var i = 0; i < fields.length; i++) {
    if (String(fields[i].name || '').toLowerCase() === needle) return fields[i];
  }
  return null;
}

/** Choice names already present on an existing singleSelect field. */
function existingChoiceNames(field) {
  var choices = (field && field.options && field.options.choices) || [];
  return choices.map(function (c) { return String(c.name); });
}

/**
 * Compare the live table against `desiredFields()` and produce an
 * executable plan. Pure function: does no I/O, so it is fully unit-testable.
 *
 * @returns {{
 *   tableId: string|null,
 *   createFields: Array,          POST bodies for /meta/.../fields
 *   patchSelectFields: Array,     PATCH bodies that only ADD select choices
 *   adopted: Array,               fields kept under a different-but-usable type
 *   notes: string[],
 *   blocking: string[],           problems a human must resolve
 *   ok: boolean
 * }}
 */
function planSchema(metaResponse, tableIdOrName, opts) {
  var plan = {
    tableId: null,
    tableName: null,
    createFields: [],
    patchSelectFields: [],
    adopted: [],
    notes: [],
    blocking: [],
    ok: false
  };

  var table = findTable(metaResponse, tableIdOrName);
  if (!table) {
    plan.blocking.push(
      'Table "' + tableIdOrName + '" not found in base. Check AIRTABLE_TABLE_NAME ' +
      'and that the PAT has schema.bases:read on this base.'
    );
    return plan;
  }
  plan.tableId = table.id;
  plan.tableName = table.name;

  // Protected user columns: warn, never mutate.
  for (var p = 0; p < SCHEMA_PROTECTED_FIELDS.length; p++) {
    var prot = SCHEMA_PROTECTED_FIELDS[p];
    if (!fieldByName(table, prot)) {
      if (prot === 'Email') {
        plan.blocking.push('Required user column "Email" is missing — nothing can be sent without it.');
      } else {
        plan.notes.push('User column "' + prot + '" is missing. Copy will fall back to its generic variant.');
      }
    }
  }

  var wanted = desiredFields(opts);
  for (var i = 0; i < wanted.length; i++) {
    var spec = wanted[i];
    var existing = fieldByName(table, spec.name);

    if (!existing) {
      var body = { name: spec.name, type: spec.type };
      if (spec.description) body.description = spec.description;
      if (spec.options) body.options = spec.options;
      plan.createFields.push(body);
      continue;
    }

    if (existing.type === spec.type) {
      // Same type. For singleSelect, top up any missing choices additively.
      if (spec.type === 'singleSelect') {
        var have = existingChoiceNames(existing);
        var haveLower = have.map(function (n) { return n.toLowerCase(); });
        var wantChoices = spec.name === 'Fit' ? SCHEMA_FIT_CHOICES : SCHEMA_STATUS_CHOICES;
        var missing = wantChoices.filter(function (c) {
          return haveLower.indexOf(c.toLowerCase()) === -1;
        });
        if (missing.length) {
          // PATCH must echo ALL existing choices (with their ids) plus the new
          // ones, or Airtable rejects the request as a destructive change.
          var choices = ((existing.options && existing.options.choices) || []).map(function (c) {
            return c.id ? { id: c.id, name: c.name } : { name: c.name };
          }).concat(missing.map(function (n) { return { name: n }; }));
          plan.patchSelectFields.push({
            fieldId: existing.id,
            name: existing.name,
            addedChoices: missing,
            body: { options: { choices: choices } }
          });
        }
      }
      continue;
    }

    var acceptable = spec.acceptableExistingTypes || [];
    if (acceptable.indexOf(existing.type) !== -1) {
      plan.adopted.push({ name: spec.name, wanted: spec.type, found: existing.type });
      plan.notes.push(
        'Field "' + spec.name + '" already exists as "' + existing.type + '" (wanted "' +
        spec.type + '"). Adopting it as-is — no data touched.'
      );
      continue;
    }

    plan.blocking.push(
      'Field "' + spec.name + '" exists as "' + existing.type + '", which this system ' +
      'cannot use (needs one of: ' + acceptable.join(', ') + '). Rename or convert it ' +
      'in the Airtable UI — this workflow will not modify it.'
    );
  }

  plan.ok = plan.blocking.length === 0;
  return plan;
}

/**
 * Airtable single-select fields reject unknown option names. When Status is a
 * select whose choices we could not extend, degrade to the closest legal value
 * instead of failing the write.
 */
function coerceStatusValue(value, allowedChoices) {
  if (!allowedChoices || !allowedChoices.length) return value;
  var lower = String(value).toLowerCase();
  for (var i = 0; i < allowedChoices.length; i++) {
    if (String(allowedChoices[i]).toLowerCase() === lower) return allowedChoices[i];
  }
  return null; // caller decides: skip the write rather than corrupt the cell
}

// ---8<--- exports (stripped by build/build.js when inlining into n8n)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCHEMA_STATUS_CHOICES: SCHEMA_STATUS_CHOICES,
    SCHEMA_FIT_CHOICES: SCHEMA_FIT_CHOICES,
    fitFields: fitFields,
    SCHEMA_PROTECTED_FIELDS: SCHEMA_PROTECTED_FIELDS,
    desiredFields: desiredFields,
    findTable: findTable,
    fieldByName: fieldByName,
    existingChoiceNames: existingChoiceNames,
    planSchema: planSchema,
    coerceStatusValue: coerceStatusValue
  };
}
