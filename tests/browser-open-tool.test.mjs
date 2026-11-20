import test from 'node:test';
import assert from 'node:assert/strict';
import tools from '../src/features/browser-tools.mjs';

test('browser_open_tab forwards an explicit Desktop source target without choosing another', async () => {
  const tool = tools.find(entry => entry.name === 'browser_open_tab');
  let received;
  const ctx = { browser: { openTarget: async (...args) => { received = args; return { id: 'new-target', url: args[0] }; } } };
  const url = 'https://www.tradingview.com/chart/Copy1234/';
  const result = await tool.handler({ url, source_target_id: 'source-target' }, ctx);
  assert.deepEqual(received, [url, { sourceTargetId: 'source-target' }]);
  assert.equal(result.target_id, 'new-target');
  assert.equal(result.independent_copy, false);
});
