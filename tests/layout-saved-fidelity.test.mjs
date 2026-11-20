import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { layoutPage, copyLayout, compareLayoutSnapshots, sourceConfigurationFingerprint, findLayoutContext } from '../src/features/layouts.mjs';
import { assertFixedFunction } from '../src/core/security.mjs';
import { ToolError } from '../src/core/errors.mjs';

const clone = value => structuredClone(value);
const content = name => ({ name, layout: '3h', charts: Array.from({ length: 3 }, (_, index) => ({ chartId: `chart-${index}`, symbol: `EXCHANGE:TEST${index}`, sources: [{ type: 'study', inputs: { length: 14, private_text: 'PRIVATE_STUDY_CONTENT' } }] })) });
const row = (uid, id, name) => ({ uid, id, name, content: JSON.stringify(content(name)), content_study_meta: JSON.stringify({ private_script: { source: 'PRIVATE_PINE_SOURCE', version: 7 } }) });
const identity = { source_layout_id: 'Source01', source_numeric_id: '1', source_name: 'Source', copy_layout_id: 'Copied02', copy_numeric_id: '2', copy_name: 'Copy' };

function harness() {
  const rows = new Map([['Source01', row('Source01', 1, 'Source')], ['Copied02', row('Copied02', 2, 'Copy')]]);
  const counts = new Map(), requests = [];
  const state = { status: 200, response: null, beforeRead: null };
  const api = {};
  const environment = vm.createContext({ window: { TradingViewApi: api }, location: { origin: 'https://www.tradingview.com', pathname: '/chart/Source01/' }, crypto: webcrypto, TextEncoder, Map,
    fetch: async (url, options) => {
      const uid = new URL(url).pathname.split('/')[2];
      const count = (counts.get(uid) ?? 0) + 1; counts.set(uid, count);
      requests.push({ url, options }); state.beforeRead?.(uid, count);
      return { ok: state.status === 200, status: state.status, headers: { get: () => null }, text: async () => state.response ?? JSON.stringify(rows.get(uid)) };
    } });
  const call = async (operation, data = {}) => { environment.args = { operation, data }; return JSON.parse(JSON.stringify(await vm.runInContext(`(${layoutPage.toString()})(args)`, environment))); };
  return { api, rows, counts, requests, state, call, fingerprint: () => call('saved_fingerprint', identity), compare: baseline => call('compare_saved', { ...identity, source_baseline: baseline }) };
}

test('saved-layout comparison is fixed reviewed code and compares complete multi-pane content privately', async () => {
  assert.equal(typeof assertFixedFunction(layoutPage), 'string');
  const f = harness(), baseline = await f.fingerprint(), result = await f.compare(baseline);
  assert.equal(result.saved_configuration_verified, true); assert.equal(result.current_saved_configuration_equal, true);
  assert.equal(result.source_unchanged_since_baseline, true); assert.equal(result.stable_reads_verified, true);
  assert.deepEqual(result.excluded_fields, ['content.name']); assert.equal(result.source.pane_count, 3);
  assert.equal(result.source.configuration_sha256, result.destination.configuration_sha256);
  assert.equal(result.drawings_covered, false); assert.equal(result.full_fidelity_verified, false);
  assert.notEqual(result.source.content_sha256, result.destination.content_sha256);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false); assert.equal(JSON.stringify(result).includes('private_text'), false);
  assert.ok(JSON.stringify(result).length < 5000);
  for (const request of f.requests) { assert.match(request.url, /^https:\/\/www\.tradingview\.com\/chart\/(?:Source01|Copied02)\/json\/$/); assert.equal(request.options.credentials, 'include'); assert.equal(request.options.redirect, 'error'); }
});

test('every saved content field except the expected root name remains significant', async () => {
  const f = harness(), baseline = await f.fingerprint();
  const changed = JSON.parse(f.rows.get('Copied02').content); changed.charts[2].sources[0].inputs.private_text = 'ALTERED_PRIVATE_SETTING';
  f.rows.get('Copied02').content = JSON.stringify(changed);
  const result = await f.compare(baseline);
  assert.equal(result.saved_configuration_verified, false); assert.equal(result.content_equal_excluding_root_name, false);
  assert.equal(result.study_metadata_equal, true); assert.equal(JSON.stringify(result).includes('ALTERED_'), false);
});

test('full study metadata differences are checked without returning their values', async () => {
  const f = harness(), baseline = await f.fingerprint();
  f.rows.get('Copied02').content_study_meta = JSON.stringify({ private_script: { source: 'CHANGED_PRIVATE_SOURCE', version: 8 } });
  const result = await f.compare(baseline);
  assert.equal(result.saved_configuration_verified, false); assert.equal(result.study_metadata_equal, false);
  assert.equal(result.content_equal_excluding_root_name, true); assert.equal(JSON.stringify(result).includes('CHANGED_'), false);
});

test('unavailable pre-copy baseline cannot establish source preservation or saved fidelity', async () => {
  const f = harness(), result = await f.compare({ available: false });
  assert.equal(result.current_saved_configuration_equal, true); assert.equal(result.saved_configuration_verified, false);
  assert.equal(result.source_unchanged_since_baseline, null); assert.equal(result.source_stability_unverified, true);
});

test('source changes after the pre-copy baseline and concurrent changes fail closed', async () => {
  const f = harness(), baseline = await f.fingerprint();
  for (const item of f.rows.values()) { const c = JSON.parse(item.content); c.charts[0].sources[0].inputs.length++; item.content = JSON.stringify(c); }
  const result = await f.compare(baseline);
  assert.equal(result.current_saved_configuration_equal, true); assert.equal(result.source_unchanged_since_baseline, false); assert.equal(result.saved_configuration_verified, false);
  const g = harness(), first = await g.fingerprint();
  g.state.beforeRead = (uid, count) => { if (uid === 'Copied02' && count === 2) { const c = JSON.parse(g.rows.get(uid).content); c.charts[0].symbol = 'EXCHANGE:OTHER'; g.rows.get(uid).content = JSON.stringify(c); } };
  const changed = await g.compare(first); assert.equal(changed.stable_reads_verified, false); assert.equal(changed.saved_configuration_verified, false);
  const h = harness(), sourceBaseline = await h.fingerprint();
  h.state.beforeRead = (uid, count) => { if (uid === 'Source01' && count === 4) { const c = JSON.parse(h.rows.get(uid).content); c.charts[0].symbol = 'EXCHANGE:CHANGED_DURING_READ'; h.rows.get(uid).content = JSON.stringify(c); } };
  const changingSource = await h.compare(sourceBaseline);
  assert.equal(changingSource.stable_reads_verified, false); assert.equal(changingSource.source_unchanged_since_baseline, null);
  assert.equal(changingSource.source_stability_unverified, true); assert.equal(changingSource.saved_configuration_verified, false);
});

for (const [label, mutate] of [
  ['wrong returned uid', r => { r.uid = 'Wrong001'; }],
  ['wrong numeric id', r => { r.id = 999; }],
  ['wrong saved name', r => { r.name = 'Unexpected'; }],
  ['wrong content root name', r => { const c = JSON.parse(r.content); c.name = 'Unexpected'; r.content = JSON.stringify(c); }],
  ['missing metadata', r => { delete r.content_study_meta; }],
  ['malformed metadata', r => { r.content_study_meta = '{'; }],
  ['non-object metadata', r => { r.content_study_meta = '[]'; }],
  ['missing content', r => { delete r.content; }],
  ['malformed content', r => { r.content = '{'; }],
  ['missing panes', r => { r.content = JSON.stringify({ name: r.name }); }],
  ['empty panes', r => { r.content = JSON.stringify({ name: r.name, charts: [] }); }],
]) test(`saved comparison rejects ${label}`, async () => {
  const f = harness(), baseline = await f.fingerprint(); mutate(f.rows.get('Copied02'));
  await assert.rejects(f.compare(baseline), /SAVED_LAYOUT_(?:IDENTITY|SCHEMA)_UNVERIFIED/);
});

test('unexpected HTTP and response formats are errors rather than successful empty saved states', async () => {
  const f = harness(); f.state.status = 403; await assert.rejects(f.fingerprint(), /SAVED_LAYOUT_HTTP_ERROR/);
  f.state.status = 200; f.state.response = 'not-json'; await assert.rejects(f.fingerprint(), /SAVED_LAYOUT_SCHEMA_UNVERIFIED/);
  f.state.response = 'x'.repeat(4 * 1024 * 1024 + 1); await assert.rejects(f.fingerprint(), /SAVED_LAYOUT_PAYLOAD_LIMIT/);
  await assert.rejects(f.call('compare_saved', { ...identity, copy_numeric_id: '1' }), /SAVED_LAYOUT_NOT_INDEPENDENT/);
});

test('a changing baseline or imprecise numeric identity cannot authorize saved-state verification', async () => {
  const f = harness();
  f.state.beforeRead = (uid, count) => { if (uid === 'Source01' && count === 2) { const c = JSON.parse(f.rows.get(uid).content); c.charts[0].symbol = 'EXCHANGE:CHANGED'; f.rows.get(uid).content = JSON.stringify(c); } };
  await assert.rejects(f.fingerprint(), /SAVED_LAYOUT_CHANGED_DURING_READ/);
  const g = harness(); g.rows.get('Source01').id = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(g.call('saved_fingerprint', { ...identity, source_numeric_id: String(g.rows.get('Source01').id) }), /SAVED_LAYOUT_IDENTITY_UNVERIFIED/);
});

test('copy receipt retains saved proof and baseline when Desktop cannot open the new tab', async () => {
  const f = harness(), checkpoints = new Map(), calls = []; let copies = 0;
  const source = { layout_id: 'Source01', numeric_id: '1', name: 'Source' }, copy = { layout_id: 'Copied02', numeric_id: '2', name: 'Copy' };
  const ctx = { targetId: 'source-tab', expectedLayoutId: 'Source01', assertLayout: async () => {},
    loadCheckpoint: async key => clone(checkpoints.get(key)), checkpoint: async (key, value) => checkpoints.set(key, clone(value)),
    poll: async (read, predicate) => { const value = await read(); if (!predicate(value)) throw new ToolError('TIMEOUT', 'Fixture'); return value; },
    browser: { isDesktop: async () => true, listTargets: async () => [{ id: 'source-tab', url: 'https://www.tradingview.com/chart/Source01/' }], openTarget: async (_url, options) => { assert.equal(options.sourceTargetId, 'source-tab'); throw new ToolError('CDP_HTTP_ERROR', 'Fixture'); } },
    callPage: async (_fn, { operation, data }) => {
      calls.push(operation);
      if (operation === 'list') return copies ? [source, copy] : [source];
      if (operation === 'snapshot') return { layout_id: 'Source01', unsaved_changes: false, panes: [] };
      if (operation === 'copy') { copies++; return { submitted: true }; }
      return f.call(operation, data);
    } };
  const args = { name: 'Copy', idempotency_key: 'saved-copy-proof' };
  const receipt = error => { assert.equal(error.code, 'COPY_CREATED_UNVERIFIED'); assert.equal(error.details.saved_configuration_verification.saved_configuration_verified, true); assert.equal(error.details.source_full_content_unchanged_verified, null); assert.equal(error.details.source_saved_layout_content_unchanged_verified, true); return true; };
  await assert.rejects(copyLayout(args, ctx), receipt);
  assert.ok(calls.indexOf('saved_fingerprint') < calls.indexOf('copy'));
  assert.equal([...checkpoints.values()][0].source_saved_baseline.available, true);
  await assert.rejects(copyLayout(args, ctx), receipt); assert.equal(copies, 1);
  assert.equal(JSON.stringify([...checkpoints.values()]).includes('PRIVATE_'), false);
});

test('copy rechecks saved state after opening and same-key viewport shifts retain user-config identity', async () => {
  const f = harness(), checkpoints = new Map(); let copies = 0, comparisons = 0, opened = false, viewport = 100;
  const source = { layout_id: 'Source01', numeric_id: '1', name: 'Source' }, copy = { layout_id: 'Copied02', numeric_id: '2', name: 'Copy' };
  const snapshot = layout => ({ layout_id: layout, unsaved_changes: false, symbol: 'EXCHANGE:TEST', resolution: '60', chart_type: 1,
    panes: [{ symbol: 'EXCHANGE:TEST', resolution: '60', chart_type: 1, studies: [{ name: 'Test', inputs: [{ id: 'length', value: 14 }],
      viewport_inputs: [{ id: 'first_visible_bar_time', value: layout === 'Source01' ? viewport : 200 }], viewport_inputs_metadata_verified: true, properties: {} }], drawings: [] }], unverified_fields: [] });
  const browser = { isDesktop: async () => true, listTargets: async () => [{ id: 'source-tab', url: 'https://www.tradingview.com/chart/Source01/' }, ...(opened ? [{ id: 'copy-tab', url: 'https://www.tradingview.com/chart/Copied02/' }] : [])],
    openTarget: async () => { opened = true; return { id: 'copy-tab' }; } };
  const context = (targetId = 'source-tab', expectedLayoutId = 'Source01') => ({ targetId, expectedLayoutId, browser,
    assertLayout: async () => {}, forTarget: async (target, layout) => context(target, layout),
    loadCheckpoint: async key => clone(checkpoints.get(key)), checkpoint: async (key, value) => checkpoints.set(key, clone(value)),
    poll: async (read, predicate) => { const value = await read(); if (!predicate(value)) throw new ToolError('TIMEOUT', 'Fixture'); return value; },
    callPage: async (_fn, { operation, data }) => {
      if (operation === 'list') return copies ? [source, copy] : [source];
      if (operation === 'snapshot' || operation === 'get') return snapshot(expectedLayoutId);
      if (operation === 'copy') { copies++; return { submitted: true }; }
      if (operation === 'compare_saved') { comparisons++; if (comparisons === 1) throw new Error('Newly saved payload is not ready'); assert.equal(opened, true); }
      return f.call(operation, data);
    } });
  const ctx = context(), args = { name: 'Copy', idempotency_key: 'saved-copy-late-payload' };
  const result = await copyLayout(args, ctx);
  assert.equal(copies, 1); assert.equal(comparisons, 2);
  assert.equal(result.saved_configuration_verification.saved_configuration_verified, true);
  assert.equal(result.source_full_content_unchanged_verified, null);
  assert.equal(result.source_saved_layout_content_unchanged_verified, true);
  const checkpoint = [...checkpoints.values()][0];
  assert.deepEqual(checkpoint.saved_configuration_verification, result.saved_configuration_verification);
  assert.deepEqual(checkpoint.result.saved_configuration_verification, result.saved_configuration_verification);
  assert.equal(checkpoint.source_fingerprint_version, 'user-config-v1');
  viewport = 300;
  const replay = await copyLayout(args, ctx);
  assert.equal(copies, 1); assert.equal(comparisons, 4); assert.equal(replay.chart_verified, true); assert.equal(replay.saved_configuration_verification.saved_configuration_verified, true);
  assert.deepEqual([...checkpoints.values()][0].saved_configuration_verification, replay.saved_configuration_verification);
  const legacy = [...checkpoints.values()][0]; delete legacy.source_fingerprint_version;
  legacy.source_fingerprint = createHash('sha256').update(JSON.stringify(snapshot('Source01').panes, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
  viewport = 400;
  const legacyReplay = await copyLayout(args, ctx);
  assert.equal(copies, 1); assert.equal(legacyReplay.chart_verified, false);
  assert.ok(legacyReplay.verification.unverified_fields.includes('legacy or missing source fingerprint cannot verify source stability'));
  assert.equal(legacyReplay.verification.unverified_fields.includes('source changed since clone submission'), false);
});

const normalizedPoint = price => [{ time_t: 123456, offset: 0, price, interval: '60' }];
test('source user-config fingerprints ignore only confirmed viewport values', () => {
  const panes = [{ studies: [{ inputs: [{ id: 'length', value: 14 }], viewport_inputs: [{ id: 'first_visible_bar_time', value: 100 }], viewport_inputs_metadata_verified: true }] }];
  const changed = clone(panes); changed[0].studies[0].viewport_inputs[0].value = 200;
  assert.equal(sourceConfigurationFingerprint(panes), sourceConfigurationFingerprint(changed));
  changed[0].studies[0].inputs[0].value = 15;
  assert.notEqual(sourceConfigurationFingerprint(panes), sourceConfigurationFingerprint(changed));
  for (const metadata of [false, null]) {
    const a = clone(panes), b = clone(panes); a[0].studies[0].viewport_inputs_metadata_verified = metadata; b[0].studies[0].viewport_inputs_metadata_verified = metadata; b[0].studies[0].viewport_inputs[0].value = 300;
    assert.notEqual(sourceConfigurationFingerprint(a), sourceConfigurationFingerprint(b));
  }
  const a = clone(panes), b = clone(panes); a[0].studies[0].viewport_inputs[0].id = 'other_hidden_input'; b[0].studies[0].viewport_inputs[0].id = 'other_hidden_input'; b[0].studies[0].viewport_inputs[0].value = 400;
  assert.notEqual(sourceConfigurationFingerprint(a), sourceConfigurationFingerprint(b));
});
function snapshotFixture({ inputs = [{ id: 'length', value: 14 }], definitions = [], drawings = [] } = {}) {
  const widget = {}, reads = { public: 0 };
  const handles = new Map(drawings.map((drawing, index) => {
    const id = drawing.id ?? `drawing-${index}`;
    const handle = { getPoints: () => { reads.public++; return clone(drawing.publicPoints ?? [{ time: 123456, price: index }]); }, getProperties: () => ({ visible: true }) };
    if (drawing.native) {
      handle._source = { id: () => drawing.sourceId ?? id };
      if (drawing.normalized !== undefined) handle._source.normalizedPoints = () => clone(drawing.normalized);
      if (drawing.state !== undefined) handle._source.state = () => ({ points: clone(drawing.state) });
    }
    return [id, handle];
  }));
  const facade = { _chartWidget: widget, symbol: () => 'EXCHANGE:TEST', resolution: () => '60', chartType: () => 1,
    getAllStudies: () => [{ id: 'study', name: 'Test study' }],
    getStudyById: () => ({ getInputValues: () => clone(inputs), getInputsInfo: () => clone(definitions), getProperties: () => ({ visible: true }) }),
    getAllShapes: () => [...handles.keys()].map(id => ({ id, name: 'horizontal_line' })), getShapeById: id => handles.get(id) };
  const api = { activeChart: () => facade, chart: () => facade, layout: () => 's',
    getSaveChartService: () => ({ layoutId: () => 'Source01', hasChanges: () => false }),
    _chartWidgetCollection: { getAll: () => [widget], readOnly: () => false, metaInfo: { name: 'Source' } } };
  const environment = vm.createContext({ window: { TradingViewApi: api }, location: { origin: 'https://www.tradingview.com', pathname: '/chart/Source01/' }, args: { operation: 'snapshot' } });
  return { reads, capture: async () => JSON.parse(JSON.stringify(await vm.runInContext(`(${layoutPage.toString()})(args)`, environment))) };
}

test('verified hidden integer viewport inputs are reported separately from user configuration', async () => {
  const inputs = value => [{ id: 'length', value: 14 }, { id: 'first_visible_bar_time', value }, { id: 'last_visible_bar_time', value: value + 100 }];
  const definitions = ['first_visible_bar_time', 'last_visible_bar_time'].map(id => ({ id, isHidden: true, type: 'integer' }));
  const source = await snapshotFixture({ inputs: inputs(100), definitions }).capture();
  const destination = await snapshotFixture({ inputs: inputs(200), definitions }).capture();
  assert.deepEqual(source.panes[0].studies[0].inputs, [{ id: 'length', value: 14 }]);
  assert.equal(source.panes[0].studies[0].viewport_inputs.length, 2);
  const result = compareLayoutSnapshots(source, destination);
  assert.equal(result.chart_verified, true); assert.equal(result.viewport_inputs_comparison.different, 1);
  assert.equal(result.viewport_inputs_comparison.unverified, 0); assert.equal(result.mismatch_count, 0);
});

test('unknown viewport metadata stays fail-closed and does not remove the original inputs', async () => {
  const inputs = [{ id: 'first_visible_bar_time', value: 100 }];
  for (const definitions of [undefined, [], [{ id: 'first_visible_bar_time', type: 'integer' }], [{ id: 'first_visible_bar_time', type: 'integer', isHidden: true }, { id: 'first_visible_bar_time', type: 'integer', isHidden: true }]]) {
    const source = await snapshotFixture({ inputs, definitions }).capture();
    assert.deepEqual(source.panes[0].studies[0].inputs, inputs);
    assert.equal(source.panes[0].studies[0].viewport_inputs, null);
    const result = compareLayoutSnapshots(source, source);
    assert.equal(result.chart_verified, false); assert.equal(result.viewport_inputs_comparison.unverified, 1);
  }
});

test('visible, noninteger and other hidden inputs are never silently excluded', async () => {
  for (const definition of [{ id: 'first_visible_bar_time', type: 'integer', isHidden: false }, { id: 'first_visible_bar_time', type: 'text', isHidden: true }, { id: 'other_hidden_input', type: 'integer', isHidden: true }]) {
    const a = await snapshotFixture({ inputs: [{ id: definition.id, value: 100 }], definitions: [definition] }).capture();
    const b = await snapshotFixture({ inputs: [{ id: definition.id, value: 200 }], definitions: [definition] }).capture();
    assert.equal(a.panes[0].studies[0].inputs.length, 1);
    assert.equal(compareLayoutSnapshots(a, b).chart_verified, false);
  }
});

test('a pane uses only identity-bound normalized points when public drawing points differ', async () => {
  const drawings = [{ native: true, normalized: normalizedPoint(10), state: normalizedPoint(10), publicPoints: [] }, { native: true, normalized: normalizedPoint(20), state: normalizedPoint(20), publicPoints: [] }];
  const a = snapshotFixture({ drawings }), b = snapshotFixture({ drawings: drawings.map(drawing => ({ ...drawing, publicPoints: [{ time: 999, price: 1 }] })) });
  const source = await a.capture(), destination = await b.capture();
  assert.equal(source.panes[0].drawing_points_representation, 'native_normalized');
  assert.equal(source.panes[0].drawing_points_source, 'normalizedPoints');
  assert.deepEqual(source.panes[0].drawings[0].points, normalizedPoint(10));
  assert.equal(a.reads.public, 0); assert.equal(b.reads.public, 0);
  assert.equal(compareLayoutSnapshots(source, destination).chart_verified, true);
});

test('uniform state points are supported but a pane never mixes native methods or public coordinates', async () => {
  const stateOnly = snapshotFixture({ drawings: [{ native: true, state: normalizedPoint(1) }, { native: true, state: normalizedPoint(2) }] });
  const stateSnapshot = await stateOnly.capture(); assert.equal(stateSnapshot.panes[0].drawing_points_source, 'state.points'); assert.equal(stateOnly.reads.public, 0);
  const mixed = snapshotFixture({ drawings: [{ native: true, normalized: normalizedPoint(1) }, { native: true, state: normalizedPoint(2) }] });
  const mixedSnapshot = await mixed.capture();
  assert.equal(mixedSnapshot.panes[0].drawing_points_representation, 'public_time'); assert.equal(mixed.reads.public, 2);
  assert.ok(mixedSnapshot.unverified_fields.includes('panes.0.drawings.native_points'));
  assert.equal(compareLayoutSnapshots(mixedSnapshot, mixedSnapshot).chart_verified, false);
});

test('wrong native source identity and unrecognised point schemas fall back for the whole pane', async () => {
  for (const invalid of [{ sourceId: 'unrelated', normalized: normalizedPoint(1) }, { normalized: [{ time: 123, price: 1 }] }, { normalized: [{ ...normalizedPoint(1)[0], price: Infinity }] }]) {
    const f = snapshotFixture({ drawings: [{ native: true, normalized: normalizedPoint(2) }, { native: true, ...invalid }] });
    const snapshot = await f.capture(); assert.equal(snapshot.panes[0].drawing_points_representation, 'public_time'); assert.equal(f.reads.public, 2);
    assert.equal(compareLayoutSnapshots(snapshot, snapshot).chart_verified, false);
  }
});

test('drawing coordinate representations cannot be mixed across compared panes or expose untrusted metadata', async () => {
  const source = await snapshotFixture({ drawings: [{ native: true, normalized: normalizedPoint(1) }] }).capture();
  const destination = await snapshotFixture({ drawings: [{ publicPoints: normalizedPoint(1) }] }).capture();
  const result = compareLayoutSnapshots(source, destination); assert.equal(result.chart_verified, false);
  assert.ok(result.unverified_fields.includes('panes.0.drawings.representation'));
  destination.panes[0].drawing_points_representation = 'PRIVATE_UNTRUSTED_METADATA';
  assert.equal(JSON.stringify(compareLayoutSnapshots(source, destination)).includes('PRIVATE_'), false);
});

function drawingInventory() {
  return { charts: new Map([
    ['chart-0', new Map([['EXCHANGE:PRIVATE_SYMBOL', { countSources: 2, sizeBytes: 300, ids: ['PRIVATE_DRAWING_B', 'PRIVATE_DRAWING_A'] }]])],
    ['_shared', new Map([['EXCHANGE:OTHER_PRIVATE', { countSources: 1, sizeBytes: 120, ids: ['PRIVATE_DRAWING_C'] }]])],
  ]), countSourcesTotal: 3, limitBytesTotal: 10000, sizeBytesTotal: 999 };
}
function installInventory(f, beforeRead) {
  const inventories = new Map([['Source01', drawingInventory()], ['Copied02', drawingInventory()]]), calls = [], counts = new Map();
  const storage = { getLayoutDrawingsSizeInfo: async function (uid, chartId) {
    assert.equal(this, storage); assert.equal(chartId, 'chart-0');
    calls.push({ uid, chartId }); const count = (counts.get(uid) ?? 0) + 1; counts.set(uid, count);
    beforeRead?.(uid, count, inventories); return inventories.get(uid);
  } };
  f.api.getChartStorage = async function () { assert.equal(this, f.api); return storage; };
  return { inventories, calls, counts };
}

test('saved drawing inventory compares exact sorted membership privately and ignores physical account totals', async () => {
  const f = harness(), installed = installInventory(f);
  const baseline = await f.fingerprint();
  const copy = installed.inventories.get('Copied02');
  copy.charts = new Map([...copy.charts].reverse().map(([chartId, symbols]) => [chartId, new Map([...symbols].reverse().map(([symbol, bucket]) => [symbol, { ...bucket, ids: [...bucket.ids].reverse() }]))]));
  copy.limitBytesTotal = 99999; copy.sizeBytesTotal = 8888;
  const result = await f.compare(baseline), proof = result.saved_drawings_inventory_verification;
  assert.equal(proof.available, true); assert.equal(proof.inventory_verified, true); assert.equal(proof.current_saved_inventory_equal, true);
  assert.equal(proof.source_unchanged_since_baseline, true); assert.equal(proof.source.source_count, 3); assert.equal(proof.source.chart_count, 2); assert.equal(proof.source.bucket_count, 2);
  assert.equal(proof.contents_verified, false); assert.equal(result.drawings_covered, false); assert.equal(result.full_fidelity_verified, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false); assert.equal(JSON.stringify(baseline).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(proof).includes('limitBytesTotal'), false); assert.equal(JSON.stringify(proof).includes('sizeBytesTotal'), false);
  assert.ok(JSON.stringify(proof).length < 2000); assert.equal(installed.calls.length, 6);
});

for (const [label, mutate] of [
  ['membership', dto => { dto.charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').ids[0] = 'PRIVATE_DIFFERENT_ID'; }],
  ['per-bucket bytes', dto => { dto.charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').sizeBytes++; }],
  ['symbol', dto => { const map = dto.charts.get('chart-0'), bucket = map.get('EXCHANGE:PRIVATE_SYMBOL'); map.clear(); map.set('EXCHANGE:PRIVATE_ALTERNATE', bucket); }],
  ['chart', dto => { const bucket = dto.charts.get('chart-0'); dto.charts.delete('chart-0'); dto.charts.set('PRIVATE_OTHER_CHART', bucket); }],
]) test(`saved drawing inventory detects differing ${label} without exposing values`, async () => {
  const f = harness(), installed = installInventory(f), baseline = await f.fingerprint(); mutate(installed.inventories.get('Copied02'));
  const result = await f.compare(baseline), proof = result.saved_drawings_inventory_verification;
  assert.equal(result.saved_configuration_verified, true); assert.equal(proof.available, true);
  assert.equal(proof.inventory_verified, false); assert.equal(proof.current_saved_inventory_equal, false); assert.equal(JSON.stringify(proof).includes('PRIVATE_'), false);
});

for (const [label, mutate] of [
  ['missing map', dto => { dto.charts = {}; }],
  ['empty dto', dto => { dto.charts = new Map(); dto.countSourcesTotal = 0; dto.limitBytesTotal = 0; dto.sizeBytesTotal = 0; }],
  ['unknown schema', dto => { dto.unrecognized = true; }],
  ['sum mismatch', dto => { dto.countSourcesTotal++; }],
  ['duplicate ids', dto => { dto.charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').ids = ['DUPLICATE', 'DUPLICATE']; }],
  ['count mismatch', dto => { dto.charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').countSources++; }],
  ['invalid source id', dto => { dto.charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').ids[0] = ''; }],
  ['oversized source id', dto => { dto.charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').ids[0] = 'x'.repeat(257); }],
  ['negative size', dto => { dto.charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').sizeBytes = -1; }],
  ['source count bound', dto => { dto.countSourcesTotal = 100001; }],
  ['chart bound', dto => { dto.charts = new Map(Array.from({ length: 101 }, (_, n) => [`chart-${n}`, new Map()])); }],
  ['byte bound', dto => { dto.charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').sizeBytes = 512 * 1024 * 1024 + 1; }],
]) test(`malformed drawing inventory ${label} stays unavailable without failing saved layout proof`, async () => {
  const f = harness(), installed = installInventory(f), baseline = await f.fingerprint(); mutate(installed.inventories.get('Copied02'));
  const result = await f.compare(baseline), proof = result.saved_drawings_inventory_verification;
  assert.equal(result.saved_configuration_verified, true); assert.equal(proof.available, false); assert.equal(proof.inventory_verified, false);
  assert.equal(proof.current_saved_inventory_equal, null); assert.equal(JSON.stringify(proof).includes('PRIVATE_'), false);
});

test('changing drawing inventory fails its own stability check without losing layout-content verification', async () => {
  const f = harness(), installed = installInventory(f), baseline = await f.fingerprint();
  const original = f.api.getChartStorage;
  let count = 0;
  f.api.getChartStorage = async function () {
    const storage = await original.call(this);
    return { getLayoutDrawingsSizeInfo: async (uid, chartId) => {
      if (uid === 'Copied02' && ++count === 2) installed.inventories.get(uid).charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').sizeBytes++;
      return storage.getLayoutDrawingsSizeInfo.call(storage, uid, chartId);
    } };
  };
  const result = await f.compare(baseline);
  assert.equal(result.saved_configuration_verified, true); assert.equal(result.saved_drawings_inventory_verification.inventory_verified, false);
  assert.equal(result.saved_drawings_inventory_verification.available, false);
});

test('drawing inventory source changes and missing baseline never establish preservation', async () => {
  const f = harness(), installed = installInventory(f), baseline = await f.fingerprint();
  for (const dto of installed.inventories.values()) dto.charts.get('chart-0').get('EXCHANGE:PRIVATE_SYMBOL').sizeBytes++;
  let proof = (await f.compare(baseline)).saved_drawings_inventory_verification;
  assert.equal(proof.current_saved_inventory_equal, true); assert.equal(proof.source_unchanged_since_baseline, false); assert.equal(proof.inventory_verified, false);
  proof = (await f.compare({ ...baseline, drawings_inventory: { available: false } })).saved_drawings_inventory_verification;
  assert.equal(proof.source_unchanged_since_baseline, null); assert.equal(proof.inventory_verified, false);
});

test('unknown storage API and absent or unsupported saved chart IDs are gracefully unavailable', async () => {
  for (const chartId of [undefined, '', 'invalid/id']) {
    const f = harness(), installed = installInventory(f);
    for (const item of f.rows.values()) { const c = JSON.parse(item.content); if (chartId === undefined) delete c.charts[0].chartId; else c.charts[0].chartId = chartId; item.content = JSON.stringify(c); }
    const baseline = await f.fingerprint(), result = await f.compare(baseline);
    assert.equal(result.saved_configuration_verified, true); assert.equal(result.saved_drawings_inventory_verification.available, false); assert.equal(installed.calls.length, 0);
  }
  const f = harness(); f.api.getChartStorage = async () => { throw new Error('PRIVATE_BACKEND_ERROR'); };
  const baseline = await f.fingerprint(), result = await f.compare(baseline);
  assert.equal(result.saved_configuration_verified, true); assert.equal(result.saved_drawings_inventory_verification.available, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_BACKEND_ERROR'), false);
});

function desktopCloneHarness() {
  const state = { sourceId: 'Source01', dirty: false, location: '/chart/Copied02/', ok: true, loseAcknowledgement: false, legacyCalls: 0, postCalls: [], onPost: null };
  const api = { getSaveChartService: () => ({ layoutId: () => state.sourceId, hasChanges: () => state.dirty,
    getSaveAsController: () => ({ _actionHandler: async () => { state.legacyCalls++; } }) }) };
  const environment = vm.createContext({ window: { TradingViewApi: api }, location: { origin: 'https://www.tradingview.com', pathname: '/chart/Source01/' }, URL,
    fetch: async (url, options) => {
      state.postCalls.push({ url, options }); state.onPost?.();
      if (state.loseAcknowledgement) throw new Error('Connection lost after submission');
      return { ok: state.ok, headers: { get: key => key === 'location' ? state.location : null } };
    } });
  const call = async (data = {}) => { environment.args = { operation: 'copy', data: { desktop_direct: true, source_layout_id: 'Source01', name: 'Copy', ...data } }; return JSON.parse(JSON.stringify(await vm.runInContext(`(${layoutPage.toString()})(args)`, environment))); };
  return { state, call };
}

test('Desktop directly awaits one fixed clone POST and never invokes the delayed legacy opener', async () => {
  const f = desktopCloneHarness(), result = await f.call();
  assert.equal(result.copy_layout_id, 'Copied02'); assert.equal(result.transport, 'native_saved_layout_clone');
  assert.equal(f.state.legacyCalls, 0); assert.equal(f.state.postCalls.length, 1);
  const request = f.state.postCalls[0]; assert.equal(request.url, 'https://www.tradingview.com/charts/Source01/clone/');
  assert.deepEqual(JSON.parse(request.options.body), { name: 'Copy' }); assert.equal(request.options.method, 'POST'); assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.redirect, 'error'); assert.equal(request.options.headers, undefined);
});

test('Desktop refuses dirty or mismatched source immediately before clone and Chrome retains the native controller', async () => {
  const dirty = desktopCloneHarness(); dirty.state.dirty = true; await assert.rejects(dirty.call(), /CLONE_SOURCE_NOT_CLEAN/); assert.equal(dirty.state.postCalls.length, 0);
  const mismatch = desktopCloneHarness(); mismatch.state.sourceId = 'Other001'; await assert.rejects(mismatch.call(), /CLONE_SOURCE_IDENTITY_UNVERIFIED/); assert.equal(mismatch.state.postCalls.length, 0);
  const invalid = desktopCloneHarness(); await assert.rejects(invalid.call({ name: '' }), /CLONE_SOURCE_IDENTITY_UNVERIFIED/); assert.equal(invalid.state.postCalls.length, 0);
  const chrome = desktopCloneHarness(); const result = await chrome.call({ desktop_direct: false }); assert.equal(result.submitted, true); assert.equal(chrome.state.legacyCalls, 1); assert.equal(chrome.state.postCalls.length, 0);
});

for (const location of [null, '', 'https://hostile.invalid/chart/Copied02/', 'javascript:alert(1)', '/chart/Source01/', '/chart/Copied02/?token=private', '/chart/Copied02/#fragment', 'https://user:pass@www.tradingview.com/chart/Copied02/', '/not-a-chart/Copied02/']) test(`Desktop never follows or trusts invalid clone Location ${String(location).slice(0, 30)}`, async () => {
  const f = desktopCloneHarness(); f.state.location = location;
  await assert.rejects(f.call(), /CLONE_RESPONSE_UNVERIFIED/); assert.equal(f.state.postCalls.length, 1); assert.equal(f.state.legacyCalls, 0);
});

test('Desktop missing Location and lost acknowledgements reconcile the saved ID without a second POST', async () => {
  for (const lost of [false, true]) {
    const native = desktopCloneHarness(); native.state.location = null; native.state.loseAcknowledgement = lost;
    const checkpoints = new Map(), rows = [{ layout_id: 'Source01', numeric_id: '1', name: 'Source' }];
    native.state.onPost = () => rows.push({ layout_id: 'Copied02', numeric_id: '2', name: 'Copy' });
    const ctx = { targetId: 'source-tab', expectedLayoutId: 'Source01', assertLayout: async () => {},
      loadCheckpoint: async key => clone(checkpoints.get(key)), checkpoint: async (key, value) => checkpoints.set(key, clone(value)),
      poll: async (read, predicate) => { const value = await read(); if (!predicate(value)) throw new ToolError('TIMEOUT', 'Fixture'); return value; },
      browser: { isDesktop: async () => true, listTargets: async () => [{ id: 'source-tab', url: 'https://www.tradingview.com/chart/Source01/' }], openTarget: async () => { throw new ToolError('CDP_HTTP_ERROR', 'Fixture'); } },
      callPage: async (_fn, { operation, data }) => {
        if (operation === 'snapshot') return { layout_id: 'Source01', unsaved_changes: false, panes: [] };
        if (operation === 'list') return clone(rows);
        if (operation === 'copy') return native.call(data);
        throw new Error('Saved proof intentionally unavailable in this transport fixture');
      } };
    const args = { name: 'Copy', idempotency_key: `direct-clone-reconcile-${lost}` };
    await assert.rejects(copyLayout(args, ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.layout_id === 'Copied02');
    await assert.rejects(copyLayout(args, ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.layout_id === 'Copied02');
    assert.equal(native.state.postCalls.length, 1); assert.equal(native.state.legacyCalls, 0); assert.equal(rows.length, 2);
  }
});

test('Desktop keeps a Location candidate for exact same-key recovery and never reposts after an unknown outcome', async () => {
  const native = desktopCloneHarness(), checkpoints = new Map(); let revealCopy = false;
  const rows = [{ layout_id: 'Source01', numeric_id: '1', name: 'Source' }, { layout_id: 'Copied02', numeric_id: '2', name: 'Copy' }, { layout_id: 'Other002', numeric_id: '3', name: 'Copy' }];
  const ctx = { targetId: 'source-tab', expectedLayoutId: 'Source01', assertLayout: async () => {},
    loadCheckpoint: async key => clone(checkpoints.get(key)), checkpoint: async (key, value) => checkpoints.set(key, clone(value)),
    poll: async (read, predicate) => { const value = await read(); if (!predicate(value)) throw new ToolError('TIMEOUT', 'Fixture'); return value; },
    browser: { isDesktop: async () => true, listTargets: async () => [{ id: 'source-tab', url: 'https://www.tradingview.com/chart/Source01/' }], openTarget: async () => { throw new ToolError('CDP_HTTP_ERROR', 'Fixture'); } },
    callPage: async (_fn, { operation, data }) => {
      if (operation === 'snapshot') return { layout_id: 'Source01', unsaved_changes: false, panes: [] };
      if (operation === 'list') return clone(revealCopy ? rows : rows.slice(0, 1));
      if (operation === 'copy') return native.call(data);
      throw new Error('Saved proof intentionally unavailable in this transport fixture');
    } };
  const args = { name: 'Copy', idempotency_key: 'direct-clone-candidate' };
  await assert.rejects(copyLayout(args, ctx), error => error.code === 'UNCERTAIN_MUTATION');
  assert.equal([...checkpoints.values()][0].stage, 'submitted'); assert.equal([...checkpoints.values()][0].submitted_copy_layout_id, 'Copied02');
  await assert.rejects(copyLayout(args, ctx), error => error.code === 'UNCERTAIN_MUTATION');
  revealCopy = true;
  await assert.rejects(copyLayout(args, ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.layout_id === 'Copied02');
  assert.equal(native.state.postCalls.length, 1); assert.equal(native.state.legacyCalls, 0);
});

function uncertainTabFixture() {
  const checkpoints = new Map(), events = [];
  const source = { layout_id: 'Source01', numeric_id: '1', name: 'Source' }, copy = { layout_id: 'Copied02', numeric_id: '2', name: 'Copy' };
  const target = id => ({ id, url: 'https://www.tradingview.com/chart/Copied02/' });
  const state = { clones: 0, opens: 0, copies: [], pollReads: 3, revealAfterReads: null, existingOnCreate: false, desktop: true, hideCreated: false, nativeDelayReads: null };
  const browser = { isDesktop: async () => state.desktop, listTargets: async () => {
    if (state.revealAfterReads !== null && --state.revealAfterReads <= 0) { state.copies = [target('delayed-copy')]; state.revealAfterReads = null; }
    return [{ id: 'source-tab', url: 'https://www.tradingview.com/chart/Source01/' }, ...state.copies];
  }, openTarget: async () => {
    state.opens++; const checkpoint = [...checkpoints.values()][0];
    assert.equal(checkpoint.tab_open_intent, true); assert.equal(checkpoint.stage, 'tab_open_submitted');
    events.push('open'); throw new ToolError('TAB_CREATE_UNVERIFIED', 'The submitted open is delayed');
  } };
  const context = (targetId = 'source-tab', expectedLayoutId = 'Source01') => ({ targetId, expectedLayoutId, browser,
    assertLayout: async () => {}, forTarget: async (id, layout) => context(id, layout),
    loadCheckpoint: async key => clone(checkpoints.get(key)), checkpoint: async (key, value) => { events.push(value.stage); checkpoints.set(key, clone(value)); },
    poll: async (read, predicate) => { for (let i = 0; i < state.pollReads; i++) { const value = await read(); if (predicate(value)) return value; } throw new ToolError('TIMEOUT', 'Read-only fixture reconciliation timed out'); },
    callPage: async (_fn, { operation }) => {
      if (operation === 'list') return state.clones && !state.hideCreated ? [source, copy] : [source];
      if (operation === 'snapshot' || operation === 'get') return { layout_id: expectedLayoutId, unsaved_changes: false, symbol: 'EXCHANGE:TEST', resolution: '60', panes: [], unverified_fields: [] };
      if (operation === 'copy') { state.clones++; if (state.existingOnCreate) state.copies = [target('existing-copy')]; if (state.nativeDelayReads !== null) state.revealAfterReads = state.nativeDelayReads; return { submitted: true }; }
      throw new Error('Saved proof is unrelated to this tab recovery fixture');
    } });
  return { ctx: context(), context, state, checkpoints, events, target };
}

test('same-key recovery waits for a delayed first target without another open or clone', async () => {
  const f = uncertainTabFixture(), args = { name: 'Copy', idempotency_key: 'durable-delayed-tab' };
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.verification_error === 'TAB_CREATE_UNVERIFIED');
  assert.equal(f.state.clones, 1); assert.equal(f.state.opens, 1); assert.equal([...f.checkpoints.values()][0].tab_open_intent, true);
  f.state.revealAfterReads = 2;
  const result = await copyLayout(args, f.ctx);
  assert.equal(result.target_id, 'delayed-copy'); assert.equal(result.chart_verified, true);
  assert.equal(f.state.clones, 1); assert.equal(f.state.opens, 1);
  assert.equal([...f.checkpoints.values()][0].target_id, 'delayed-copy');
});

test('timed-out tab recovery never reopens, and duplicate unconfirmed targets fail closed', async () => {
  const f = uncertainTabFixture(), args = { name: 'Copy', idempotency_key: 'durable-uncertain-tab' };
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED');
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.verification_error === 'TIMEOUT');
  assert.equal(f.state.clones, 1); assert.equal(f.state.opens, 1);
  f.state.copies = [f.target('copy-a'), f.target('copy-b')];
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.verification_error === 'AMBIGUOUS_LAYOUT_TARGET');
  assert.equal(f.state.clones, 1); assert.equal(f.state.opens, 1); assert.equal([...f.checkpoints.values()][0].target_id, undefined);
  f.state.copies = [f.target('copy-a')];
  const resolved = await copyLayout(args, f.ctx); assert.equal(resolved.target_id, 'copy-a');
  f.state.copies.push(f.target('copy-b'));
  const confirmed = await copyLayout(args, f.ctx); assert.equal(confirmed.target_id, 'copy-a');
  assert.equal(f.state.clones, 1); assert.equal(f.state.opens, 1);
});

test('a pre-existing exact copy target is verified before any controlled open intent', async () => {
  const f = uncertainTabFixture(); f.state.existingOnCreate = true;
  const args = { name: 'Copy', idempotency_key: 'already-open-copy' };
  const result = await copyLayout(args, f.ctx);
  assert.equal(result.target_id, 'existing-copy'); assert.equal(f.state.clones, 1); assert.equal(f.state.opens, 0);
  assert.equal([...f.checkpoints.values()][0].tab_open_intent, false);
  f.state.copies = [];
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.verification_error === 'TAB_CREATE_UNVERIFIED');
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.verification_error === 'TIMEOUT');
  assert.equal(f.state.opens, 1); assert.equal(f.state.clones, 1);
});

test('legacy checkpoints with unknown tab-open history permit only read-only reconciliation', async () => {
  const f = uncertainTabFixture(), args = { name: 'Copy', idempotency_key: 'legacy-uncertain-tab' };
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED');
  delete [...f.checkpoints.values()][0].tab_open_intent;
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.verification_error === 'TIMEOUT');
  assert.equal(f.state.opens, 1); assert.equal(f.state.clones, 1);
  assert.equal([...f.checkpoints.values()][0].tab_open_intent, true);
});

test('legacy submitted clone recovery never starts another open while its native target is delayed', async () => {
  const f = uncertainTabFixture(), args = { name: 'Copy', idempotency_key: 'legacy-submitted-delayed-tab' };
  f.state.desktop = false; f.state.hideCreated = true;
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'UNCERTAIN_MUTATION');
  const submitted = [...f.checkpoints.values()][0]; assert.equal(submitted.stage, 'submitted'); assert.equal(submitted.copy_layout_id, undefined);
  delete submitted.clone_open_protocol;
  f.state.hideCreated = false;
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.verification_error === 'TIMEOUT');
  assert.equal(f.state.opens, 0); assert.equal(f.state.clones, 1); assert.equal([...f.checkpoints.values()][0].tab_open_intent, true);
  f.state.revealAfterReads = 2;
  const recovered = await copyLayout(args, f.ctx);
  assert.equal(recovered.target_id, 'delayed-copy'); assert.equal(f.state.opens, 0); assert.equal(f.state.clones, 1);
});

test('new Chrome native clone records its possible auto-opener and only waits for that target', async () => {
  const f = uncertainTabFixture(); f.state.desktop = false; f.state.nativeDelayReads = 3;
  const result = await copyLayout({ name: 'Copy', idempotency_key: 'chrome-native-delayed-tab' }, f.ctx);
  assert.equal(result.target_id, 'delayed-copy'); assert.equal(result.chart_verified, true);
  assert.equal(f.state.opens, 0); assert.equal(f.state.clones, 1);
  const checkpoint = [...f.checkpoints.values()][0];
  assert.equal(checkpoint.clone_open_protocol, 'native-controller-autoopen-or-unknown-v1'); assert.equal(checkpoint.tab_open_intent, true);
});

test('new direct Desktop records no-autoopen proof before submission and preserves it during recovery', async () => {
  const f = uncertainTabFixture(), args = { name: 'Copy', idempotency_key: 'desktop-direct-protocol-proof' };
  f.state.hideCreated = true;
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'UNCERTAIN_MUTATION');
  const submitted = [...f.checkpoints.values()][0]; assert.equal(submitted.clone_open_protocol, 'desktop-direct-no-autoopen-v1'); assert.equal(submitted.copy_layout_id, undefined);
  f.state.hideCreated = false;
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.verification_error === 'TAB_CREATE_UNVERIFIED');
  assert.equal(f.state.opens, 1); assert.equal(f.state.clones, 1);
  assert.equal([...f.checkpoints.values()][0].clone_open_protocol, 'desktop-direct-no-autoopen-v1');
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.verification_error === 'TIMEOUT');
  assert.equal(f.state.opens, 1); assert.equal(f.state.clones, 1);
});

test('generic layout resolution rejects multiple exact targets unless one confirmed target is explicit', async () => {
  const f = uncertainTabFixture(); f.state.copies = [f.target('copy-a'), f.target('copy-b')];
  await assert.rejects(findLayoutContext(f.ctx, 'Copied02'), error => error.code === 'AMBIGUOUS_LAYOUT_TARGET');
  await assert.rejects(findLayoutContext(f.ctx, 'Copied02', { preferredTargetId: 'absent' }), error => error.code === 'AMBIGUOUS_LAYOUT_TARGET');
  const selected = await findLayoutContext(f.ctx, 'Copied02', { preferredTargetId: 'copy-b' });
  assert.equal(selected.targetId, 'copy-b'); assert.equal(f.state.opens, 0);
});
