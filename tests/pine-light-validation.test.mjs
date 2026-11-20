import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pinePage } from '../src/features/pine.mjs';

async function check(response) {
  const context = vm.createContext({ URLSearchParams, arg: { op: 'check', source: '//@version=6\nindicator("Test")\nplot(close)' },
    fetch: async () => ({ ok: true, status: 200, json: async () => structuredClone(response) }),
  });
  return vm.runInContext(`(${pinePage.toString()})(arg)`, context);
}
const light = () => ({ success: true, result: { functions2: [], types: [], enums: [] } });

test('recognised native light result proves validation without claiming compiled bytecode', async () => {
  const result = await check(light());
  assert.equal(result.ok, true);
  assert.equal(result.checked, true);
  assert.equal(result.validation_passed, true);
  assert.equal(result.compiled, null);
  assert.equal(result.compiler_mode, 'guest_light');
  assert.match(result.note, /no compiled bytecode/);
});

test('light result with explicit empty diagnostics is accepted', async () => {
  const response = light(); response.result.errors2 = []; response.result.warnings2 = [];
  assert.equal((await check(response)).validation_passed, true);
});

test('native success flag does not hide light validation diagnostics', async () => {
  const response = light(); response.result.errors2 = [{ message: 'Unknown identifier', start: { line: 3, column: 6 } }];
  const result = await check(response);
  assert.equal(result.compiled, false); assert.equal(result.errors.length, 1);
  assert.equal(result.validation_passed, undefined);
});

test('actual compiled output preserves the existing compiled outcome', async () => {
  const result = await check({ result: { ilTemplate: 'compiled-output', errors2: [], warnings2: [] } });
  assert.equal(result.compiled, true); assert.equal(result.compiler_mode, 'guest');
});

for (const kind of ['success-absent', 'success-false', 'success-string', 'functions-absent', 'types-object', 'enums-null', 'errors-object', 'warnings-string', 'empty-result']) {
  test('unknown light shape fails closed: ' + kind, async () => {
    const response = light();
    if (kind === 'success-absent') delete response.success;
    if (kind === 'success-false') response.success = false;
    if (kind === 'success-string') response.success = 'true';
    if (kind === 'functions-absent') delete response.result.functions2;
    if (kind === 'types-object') response.result.types = {};
    if (kind === 'enums-null') response.result.enums = null;
    if (kind === 'errors-object') response.result.errors2 = {};
    if (kind === 'warnings-string') response.result.warnings2 = '';
    if (kind === 'empty-result') response.result = {};
    const result = await check(response);
    assert.equal(result.ok, false); assert.equal(result.code, 'COMPILE_OUTCOME_UNVERIFIED');
  });
}
