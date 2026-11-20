import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLayoutSnapshots } from '../src/features/layouts.mjs';

const snapshot = (studies = []) => ({
  symbol: 'MOEX:IMOEX', resolution: 'D', chart_type: 1,
  panes: [{ symbol: 'MOEX:IMOEX', resolution: 'D', studies, drawings: [] }],
  unverified_fields: [],
});
const study = (value, name = 'Indicator') => ({ name, inputs: { value }, properties: {} });

test('comparison receipts hash private inputs, properties, names and drawing points', () => {
  const secret = 'PRIVATE_PINE_ENCRYPTED_MARKER_'.repeat(20000);
  const source = snapshot([study(secret, secret)]);
  source.panes[0].studies[0].properties = { privateCode: secret };
  source.panes[0].drawings = [{ points: [secret], text: secret }];
  const destination = snapshot([study('different', 'different')]);
  const result = compareLayoutSnapshots(source, destination);
  assert.equal(result.chart_verified, false);
  assert.equal(result.mismatch_count, 4);
  assert.deepEqual(result.mismatches.map(row => row.field), [
    'panes.0.studies.0.name', 'panes.0.studies.0.inputs',
    'panes.0.studies.0.properties', 'panes.0.drawings',
  ]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('PRIVATE_PINE'));
  assert.ok(!serialized.includes('privateCode'));
  assert.ok(!serialized.includes('points'));
  assert.ok(serialized.length < 4000);
  for (const row of result.mismatches) {
    assert.match(row.source.sha256, /^[a-f0-9]{64}$/);
    assert.match(row.destination.sha256, /^[a-f0-9]{64}$/);
    assert.notEqual(row.source.sha256, row.destination.sha256);
  }
});

test('bounded receipts count every mismatch and cannot hide a failed comparison', () => {
  const source = snapshot(Array.from({ length: 1000 }, (_, i) => study(i)));
  const destination = snapshot(Array.from({ length: 1000 }, (_, i) => study(i + 1)));
  const result = compareLayoutSnapshots(source, destination);
  assert.equal(result.chart_verified, false);
  assert.equal(result.readable_configuration_verified, false);
  assert.equal(result.mismatch_count, 1000);
  assert.equal(result.mismatches.length, 100);
  assert.equal(result.mismatches_truncated, true);
  assert.ok(JSON.stringify(result).length < 35000);
});

test('unverified field names are bounded and cannot expose private study names', () => {
  const source = snapshot();
  source.unverified_fields = Array.from({ length: 1000 }, (_, i) =>
    `panes.0.study.PRIVATE_NAME_${i}.inputs`);
  source.unverified_fields.push(`panes.${'1'.repeat(5000)}.studies`);
  const result = compareLayoutSnapshots(source, snapshot());
  assert.equal(result.chart_verified, false);
  assert.equal(result.unverified_field_count, 1001);
  assert.equal(result.unverified_fields.length, 100);
  assert.equal(result.unverified_fields_truncated, true);
  assert.ok(result.unverified_fields.every(field => field.length <= 160));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_NAME'));
});

test('exact comparison retains object-key normalization and input-array normalization', () => {
  const source = snapshot([{ name: 'Indicator', inputs: [{ id: 'x', value: { b: 2, a: 1 } }], properties: {} }]);
  const destination = snapshot([{ name: 'Indicator', inputs: { x: { a: 1, b: 2 } }, properties: {} }]);
  assert.equal(compareLayoutSnapshots(source, destination).chart_verified, true);
  destination.panes[0].studies[0].inputs.x.a = 3;
  assert.equal(compareLayoutSnapshots(source, destination).chart_verified, false);
});

test('missing unnamed studies hash safely and optional unknown fields remain fail-closed for fidelity', () => {
  const result = compareLayoutSnapshots(snapshot([{ inputs: {} }]), snapshot());
  assert.equal(result.chart_verified, false);
  assert.equal(result.mismatches[1].source.type, 'undefined');
  const source = snapshot();
  source.unverified_fields = ['panes.0.drawings'];
  const optional = compareLayoutSnapshots(source, snapshot());
  assert.equal(optional.chart_verified, true);
  assert.equal(optional.readable_configuration_verified, false);
  assert.equal(optional.full_fidelity_verified, false);
});
