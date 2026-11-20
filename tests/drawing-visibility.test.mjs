import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import drawingTools, { drawingPage } from '../src/features/drawings.mjs';
import { assertFixedFunction } from '../src/core/security.mjs';
import { ToolError } from '../src/core/errors.mjs';

function fixture({ properties = { visible: true }, method } = {}) {
  const state = { properties: { ...properties }, writes: 0 };
  const shape = {
    getPoints: () => [{ time: 1, price: 2 }],
    getProperties: () => ({ ...state.properties }),
    setVisible: value => { state.properties.visible = value; state.writes++; },
  };
  if (method) shape.isVisible = method;
  const chart = { getAllShapes: () => [{ id: 'test-shape', name: 'horizontal_line' }], getShapeById: () => shape };
  const environment = vm.createContext({ window: { TradingViewApi: { activeChart: () => chart } } });
  const ctx = {
    async assertLayout() {},
    async callPage(fn, args) { environment.args = args; return vm.runInContext(`(${fn.toString()})(args)`, environment); },
    async poll(read, predicate) { const result = await read(); if (predicate(result)) return result; throw new ToolError('VERIFICATION_TIMEOUT', 'Fixture did not verify.'); },
  };
  const tool = (name, args) => drawingTools.find(tool => tool.name === name).handler(args, ctx);
  return { state, tool };
}

test('drawing visibility adapter remains within the fixed-function gate', () => {
  assert.equal(typeof assertFixedFunction(drawingPage), 'string');
});

test('drawing update verifies explicit property visibility when isVisible is absent', async () => {
  const f = fixture();
  const before = await f.tool('drawing_get', { id: 'test-shape' });
  assert.equal(before.visible, true);
  assert.equal(before.visibility_source, 'getProperties.visible');
  assert.equal(before.unavailable.includes('visible'), false);
  const changed = await f.tool('drawing_update', { id: 'test-shape', expected_fingerprint: before.fingerprint, visible: false });
  assert.equal(changed.updated, true);
  assert.equal(changed.drawing.visible, false);
  assert.equal(changed.drawing.visibility_source, 'getProperties.visible');
  assert.notEqual(changed.fingerprint, before.fingerprint);
  assert.equal(f.state.writes, 1);
});

test('drawing visibility uses the native boolean method before properties', async () => {
  const f = fixture({ properties: { visible: false }, method: () => true });
  const result = await f.tool('drawing_get', { id: 'test-shape' });
  assert.equal(result.visible, true);
  assert.equal(result.visibility_source, 'isVisible');
});

for (const properties of [{}, { visible: 'false' }, { visible: 0 }, { visible: null }]) {
  test(`drawing visibility remains unavailable for ${JSON.stringify(properties)}`, async () => {
    const f = fixture({ properties });
    const result = await f.tool('drawing_get', { id: 'test-shape' });
    assert.equal(Object.hasOwn(result, 'visible'), false);
    assert.equal(Object.hasOwn(result, 'visibility_source'), false);
    assert.equal(result.unavailable.includes('visible'), true);
  });
}

test('malformed method visibility is not treated as a boolean', async () => {
  const f = fixture({ properties: {}, method: () => 'false' });
  const result = await f.tool('drawing_get', { id: 'test-shape' });
  assert.equal(Object.hasOwn(result, 'visible'), false);
  assert.equal(result.unavailable.includes('visible'), true);
});
