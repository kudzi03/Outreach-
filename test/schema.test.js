'use strict';
const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/lib/schema.js');

/** A base that only has the user's own columns — the realistic day-one state. */
function userOnlyBase() {
  return {
    tables: [{
      id: 'tbl123',
      name: 'Leads',
      fields: [
        { id: 'fld1', name: 'First Name', type: 'singleLineText' },
        { id: 'fld2', name: 'Company Name', type: 'singleLineText' },
        { id: 'fld3', name: 'Email', type: 'email' },
        { id: 'fld4', name: 'City', type: 'singleLineText' }
      ]
    }]
  };
}

test('a fresh base gets every required field created', () => {
  const plan = s.planSchema(userOnlyBase(), 'Leads', { manageOptional: false });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.tableId, 'tbl123');
  assert.deepStrictEqual(
    plan.createFields.map((f) => f.name),
    ['Status', 'Last Contacted Date', 'Verification Status']
  );
});

test('the Status field is created with exactly the eight required choices', () => {
  const plan = s.planSchema(userOnlyBase(), 'Leads', { manageOptional: false });
  const status = plan.createFields.find((f) => f.name === 'Status');
  assert.strictEqual(status.type, 'singleSelect');
  assert.deepStrictEqual(
    status.options.choices.map((c) => c.name),
    ['New', 'Invalid', 'Queued', 'Sent Email 1', 'Sent Follow-up 1', 'Sent Follow-up 2', 'Replied', 'Do Not Contact']
  );
});

test('Last Contacted Date is a dateTime, Verification Status is text', () => {
  const plan = s.planSchema(userOnlyBase(), 'Leads', { manageOptional: false });
  const byName = Object.fromEntries(plan.createFields.map((f) => [f.name, f]));
  assert.strictEqual(byName['Last Contacted Date'].type, 'dateTime');
  assert.strictEqual(byName['Last Contacted Date'].options.timeZone, 'utc');
  assert.strictEqual(byName['Verification Status'].type, 'singleLineText');
});

test('PROTECTED: no plan ever mutates a user column', () => {
  const plan = s.planSchema(userOnlyBase(), 'Leads');
  const touched = [
    ...plan.createFields.map((f) => f.name),
    ...plan.patchSelectFields.map((f) => f.name)
  ];
  for (const protectedField of s.SCHEMA_PROTECTED_FIELDS) {
    assert.ok(!touched.includes(protectedField), `${protectedField} must never be touched`);
  }
});

test('a fully-provisioned base produces no changes at all', () => {
  const base = userOnlyBase();
  const plan1 = s.planSchema(base, 'Leads');
  // Simulate the creates having happened.
  plan1.createFields.forEach((f, i) => {
    base.tables[0].fields.push(Object.assign({ id: `new${i}` }, f, {
      options: f.type === 'singleSelect'
        ? { choices: f.options.choices.map((c, j) => ({ id: `ch${i}${j}`, name: c.name })) }
        : f.options
    }));
  });
  const plan2 = s.planSchema(base, 'Leads');
  assert.strictEqual(plan2.ok, true);
  assert.deepStrictEqual(plan2.createFields, [], 'the check must be idempotent');
  assert.deepStrictEqual(plan2.patchSelectFields, []);
});

test('missing single-select choices are added without dropping existing ones', () => {
  const base = userOnlyBase();
  base.tables[0].fields.push({
    id: 'fldStatus',
    name: 'Status',
    type: 'singleSelect',
    options: { choices: [{ id: 'chA', name: 'New' }, { id: 'chB', name: 'Customer' }] }
  });
  const plan = s.planSchema(base, 'Leads');
  assert.strictEqual(plan.createFields.some((f) => f.name === 'Status'), false);

  const patch = plan.patchSelectFields.find((p) => p.name === 'Status');
  assert.ok(patch, 'a choice patch is expected');
  const names = patch.body.options.choices.map((c) => c.name);
  assert.ok(names.includes('Customer'), "the user's own choice must survive");
  assert.ok(names.includes('New'));
  assert.ok(names.includes('Do Not Contact'));
  assert.ok(names.includes('Sent Follow-up 2'));
  // Existing choices must keep their ids or Airtable rejects the PATCH.
  assert.strictEqual(patch.body.options.choices.find((c) => c.name === 'Customer').id, 'chB');
  assert.strictEqual(patch.body.options.choices.find((c) => c.name === 'Do Not Contact').id, undefined);
});

test('an existing text Status column is adopted, not replaced', () => {
  const base = userOnlyBase();
  base.tables[0].fields.push({ id: 'fldS', name: 'Status', type: 'singleLineText' });
  const plan = s.planSchema(base, 'Leads');
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.createFields.some((f) => f.name === 'Status'), false, 'must not duplicate the column');
  assert.deepStrictEqual(plan.adopted.find((a) => a.name === 'Status'), {
    name: 'Status', wanted: 'singleSelect', found: 'singleLineText'
  });
  assert.match(plan.notes.join(' '), /Adopting it as-is/);
});

test('an unusable existing type blocks rather than destroying data', () => {
  const base = userOnlyBase();
  base.tables[0].fields.push({ id: 'fldS', name: 'Status', type: 'multipleAttachments' });
  const plan = s.planSchema(base, 'Leads');
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.createFields.length > 0, true, 'other fields are still planned');
  assert.match(plan.blocking.join(' '), /will not modify it/);
});

test('field lookup is case-insensitive so "status" is not duplicated', () => {
  const base = userOnlyBase();
  base.tables[0].fields.push({ id: 'fldS', name: 'status', type: 'singleLineText' });
  const plan = s.planSchema(base, 'Leads');
  assert.strictEqual(plan.createFields.some((f) => f.name === 'Status'), false);
});

test('a missing table is a blocking error with an actionable message', () => {
  const plan = s.planSchema(userOnlyBase(), 'Prospects');
  assert.strictEqual(plan.ok, false);
  assert.match(plan.blocking[0], /AIRTABLE_TABLE_NAME/);
});

test('the table can be addressed by id as well as by name', () => {
  assert.strictEqual(s.planSchema(userOnlyBase(), 'tbl123').tableId, 'tbl123');
  assert.strictEqual(s.planSchema(userOnlyBase(), 'leads').tableId, 'tbl123');
});

test('a missing Email column blocks the run; other user columns only warn', () => {
  const base = userOnlyBase();
  base.tables[0].fields = base.tables[0].fields.filter((f) => f.name !== 'Email');
  const plan = s.planSchema(base, 'Leads');
  assert.strictEqual(plan.ok, false);
  assert.match(plan.blocking.join(' '), /"Email" is missing/);

  const base2 = userOnlyBase();
  base2.tables[0].fields = base2.tables[0].fields.filter((f) => f.name !== 'First Name');
  const plan2 = s.planSchema(base2, 'Leads');
  assert.strictEqual(plan2.ok, true, 'a missing First Name only changes the copy');
  assert.match(plan2.notes.join(' '), /generic variant/);
});

test('optional bookkeeping fields can be switched off', () => {
  const full = s.planSchema(userOnlyBase(), 'Leads', { manageOptional: true });
  const lean = s.planSchema(userOnlyBase(), 'Leads', { manageOptional: false });
  assert.strictEqual(lean.createFields.length, 3);
  assert.ok(full.createFields.length > lean.createFields.length);
  assert.ok(full.createFields.some((f) => f.name === 'Message ID'), 'threading needs a Message ID column');
});

test('coerceStatusValue only ever returns a legal choice', () => {
  const choices = s.SCHEMA_STATUS_CHOICES;
  assert.strictEqual(s.coerceStatusValue('Replied', choices), 'Replied');
  assert.strictEqual(s.coerceStatusValue('replied', choices), 'Replied');
  assert.strictEqual(s.coerceStatusValue('Nonsense', choices), null);
  assert.strictEqual(s.coerceStatusValue('Anything', null), 'Anything');
});
