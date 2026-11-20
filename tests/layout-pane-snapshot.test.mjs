import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { layoutPage, compareLayoutSnapshots, copyLayout } from '../src/features/layouts.mjs';
import { ToolError } from '../src/core/errors.mjs';

function fixture(activeIndex = 0, options = {}) {
  const widgets = Array.from({ length: 3 }, () => ({ model() { throw new Error('Private source projection must not be used.'); } }));
  const facades = widgets.map((widget, index) => ({
    _chartWidget: widget, symbol: () => `EXCHANGE:SYMBOL${index}`, resolution: () => '60', chartType: () => index,
    getAllStudies: () => [{ id: `study-${index}`, name: 'Same indicator' }],
    getStudyById: () => ({ getInputValues: () => [{ id: 'length', value: index + 10 }], getProperties: () => ({ visible: true }) }),
    getAllShapes: () => [{ id: 'shape', name: 'horizontal_line' }],
    getShapeById: () => ({ getPoints: () => [{ time: 123, price: index }], getProperties: () => ({ visible: true }) }),
  }));
  const api = { activeChart: () => facades[activeIndex], chart: index => facades[index], layout: () => '3h',
    getSaveChartService: () => ({ layoutId: () => 'Source01', hasChanges: () => false }),
    _chartWidgetCollection: { getAll: () => widgets, readOnly: () => false, metaInfo: { name: 'Test' } } };
  Object.assign(api, options);
  const context = vm.createContext({ window: { TradingViewApi: api }, location: { origin: 'https://www.tradingview.com', pathname: '/chart/Source01/' }, args: { operation: 'snapshot' } });
  return { api, widgets, facades, capture: async () => JSON.parse(JSON.stringify(await vm.runInContext(`(${layoutPage.toString()})(args)`, context))) };
}

test('all pane snapshots use the same identity-checked facade without moving focus', async () => {
  const f = fixture(1);
  const snapshot = await f.capture();
  assert.equal(snapshot.layout_code, '3h'); assert.equal(snapshot.active_index, 1);
  assert.deepEqual(snapshot.panes.map(p => p.chart_type), [0, 1, 2]);
  assert.deepEqual(snapshot.panes.map(p => p.studies[0].inputs[0].value), [10, 11, 12]);
  assert.deepEqual(snapshot.panes.map(p => p.drawings[0].points[0].price), [0, 1, 2]);
  assert.deepEqual(snapshot.unverified_fields, []);
  assert.equal(f.api.activeChart(), f.facades[1]);
});

test('content comparison ignores active-pane top-level projection and reports focus separately', async () => {
  const source = await fixture(1).capture(), copy = await fixture(0).capture();
  const comparison = compareLayoutSnapshots(source, copy);
  assert.equal(comparison.chart_verified, true); assert.equal(comparison.readable_configuration_verified, true);
  assert.deepEqual(comparison.active_focus, { source_index: 1, destination_index: 0, preserved: false });
  assert.equal(comparison.full_fidelity_verified, false);
});

test('inactive chart type, layout geometry and exact inputs remain checked', async () => {
  const source = await fixture(1).capture(), copy = structuredClone(source);
  copy.panes[2].chart_type = 9;
  copy.layout_code = '3v';
  copy.panes[1].studies[0].inputs[0].value++;
  const comparison = compareLayoutSnapshots(source, copy);
  assert.equal(comparison.chart_verified, false);
  assert.deepEqual(comparison.mismatches.map(m => m.field), ['layout_code', 'panes.1.studies.0.inputs', 'panes.2.chart_type']);
});

test('wrong pane facade and unavailable metadata cannot become verified empty panes', async () => {
  const f = fixture(); f.api.chart = () => f.facades[0]; f.api.layout = () => null;
  const snapshot = await f.capture();
  assert.equal(snapshot.panes[1].studies, null); assert.equal(snapshot.panes[1].drawings, null);
  assert.ok(snapshot.unverified_fields.includes('panes.1.facade'));
  assert.ok(snapshot.unverified_fields.includes('layout_code'));
  assert.equal(compareLayoutSnapshots(snapshot, snapshot).chart_verified, false);
});

test('missing study inputs stay critical while unavailable properties are explicit', async () => {
  const f = fixture();
  f.facades[2].getStudyById = () => ({ getInputValues() { throw new Error('unavailable'); } });
  const snapshot = await f.capture();
  assert.ok(snapshot.unverified_fields.includes('panes.2.studies.0.inputs'));
  assert.ok(snapshot.unverified_fields.includes('panes.2.studies.0.properties'));
  assert.equal(compareLayoutSnapshots(snapshot, snapshot).chart_verified, false);
});

function failedCopyOpenFixture() {
  const checkpoints = new Map(), events = [];
  const state = { copies: 0, hideCreated: false, rows: [{ numeric_id: '1', layout_id: 'Source01', name: 'Source' }] };
  const ctx = { expectedLayoutId: 'Source01', targetId: 'source-tab',
    loadCheckpoint: async key => checkpoints.get(key),
    checkpoint: async (key, value) => { events.push(['checkpoint', value.stage]); checkpoints.set(key, structuredClone(value)); },
    assertLayout: async () => {},
    poll: async (read, predicate) => { const result = await read(); if (!predicate(result)) throw new ToolError('TIMEOUT', 'Fixture timeout'); return result; },
    browser: { isDesktop: async () => true, listTargets: async () => [{ id: 'source-tab', url: 'https://www.tradingview.com/chart/Source01/' }],
      openTarget: async () => { events.push(['open', [...checkpoints.values()][0]?.copy_layout_id]); throw new ToolError('CDP_HTTP_ERROR', 'HTTP 500'); } },
    callPage: async (_fn, { operation }) => {
      if (operation === 'snapshot') return { layout_id: 'Source01', unsaved_changes: false, panes: [] };
      if (operation === 'list') return state.hideCreated && state.copies ? state.rows.slice(0, 1) : structuredClone(state.rows);
      if (operation === 'copy') { state.copies++; state.rows.push({ numeric_id: '2', layout_id: 'Copied02', name: 'Copy' }); return { submitted: true }; }
      throw new Error(`Unexpected ${operation}`);
    },
  };
  return { ctx, state, checkpoints, events };
}

test('created-copy opening failures retain the exact ID and same-key retries never clone again', async () => {
  const f = failedCopyOpenFixture();
  const args = { name: 'Copy', idempotency_key: 'copy-open-failure' };
  const assertReceipt = expectedError => error => {
    assert.equal(error.code, 'COPY_CREATED_UNVERIFIED');
    assert.equal(error.details.layout_id, 'Copied02'); assert.equal(error.details.created, true);
    assert.equal(error.details.source_layout_id, 'Source01'); assert.equal(error.details.chart_verified, false);
    assert.equal(error.details.verification_error, expectedError); assert.equal(error.details.retry_with_same_key, true);
    return true;
  };
  await assert.rejects(copyLayout(args, f.ctx), assertReceipt('CDP_HTTP_ERROR'));
  assert.equal(f.state.copies, 1);
  assert.equal([...f.checkpoints.values()][0].copy_layout_id, 'Copied02');
  assert.deepEqual(f.events.find(event => event[0] === 'open'), ['open', 'Copied02']);
  await assert.rejects(copyLayout(args, f.ctx), assertReceipt('TIMEOUT'));
  assert.equal(f.state.copies, 1);
  assert.equal(f.events.filter(event => event[0] === 'open').length, 1);
});

test('lost-acknowledgement reconciliation checkpoints the discovered ID before opening', async () => {
  const f = failedCopyOpenFixture(); f.state.hideCreated = true;
  const args = { name: 'Copy', idempotency_key: 'copy-reconcile-open-failure' };
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'UNCERTAIN_MUTATION');
  assert.equal([...f.checkpoints.values()][0].stage, 'submitted');
  f.state.hideCreated = false;
  await assert.rejects(copyLayout(args, f.ctx), error => error.code === 'COPY_CREATED_UNVERIFIED' && error.details.layout_id === 'Copied02');
  assert.equal([...f.checkpoints.values()][0].copy_layout_id, 'Copied02');
  assert.deepEqual(f.events.find(event => event[0] === 'open'), ['open', 'Copied02']);
  assert.equal(f.state.copies, 1);
});
