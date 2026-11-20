import test from 'node:test';
import assert from 'node:assert/strict';
import { pinePage } from '../src/features/pine.mjs';
import { createFakeCdp } from './fake-cdp.mjs';

async function fixture(t, { ambiguous = false, detached = false, legacyOnly = false } = {}) {
  const state = { open: false, clicks: 0, legacy: 0 };
  const dom = { isConnected: !detached, getBoundingClientRect: () => ({ width: 800, height: 400 }), contains(other) { return other === this; } };
  const opener = { isConnected: true, getBoundingClientRect: () => ({ width: 40, height: 40 }), click() { state.clicks++;state.open = true; } };
  const editor = { getDomNode: () => dom, getValue: () => 'plot(close)' };
  const h = createFakeCdp({ page: {
    TradingView: { bottomWidgetBar: { activateScriptEditorTab() { state.legacy++;if (legacyOnly) state.open = true; } } },
    monaco: { editor: { getEditors: () => state.open ? [editor] : [] } },
    document: { querySelectorAll(selector) {
      if (selector === '.monaco-editor.pine-editor-monaco') return state.open ? [dom] : [];
      if (selector.includes('[aria-label="Pine Editor"]')) return legacyOnly ? [] : ambiguous ? [opener, { ...opener }] : [opener];
      return [];
    } }
  } });
  t.after(() => h.close());
  const open = () => h.browser.evaluate('chart-1', pinePage, { op: 'open' });
  return { state, open };
}

test('Pine opening prefers a unique current UI control when the legacy opener is a no-op', async t => {
  const f = await fixture(t);
  const result = await f.open();
  assert.equal(result.editor_open, true);
  assert.equal(result.verified, true);
  assert.equal(f.state.clicks, 1);
  assert.equal(f.state.legacy, 0);
  assert.equal((await f.open()).already_open, true);
  assert.equal(f.state.clicks, 1);
});

test('Pine opening refuses ambiguous UI controls before dispatching an opener', async t => {
  const f = await fixture(t, { ambiguous: true });
  const result = await f.open();
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.state.clicks, 0);
  assert.equal(f.state.legacy, 0);
});

test('Pine opening retains legacy support when there is no current UI opener', async t => {
  const f = await fixture(t, { legacyOnly: true });
  assert.equal((await f.open()).verified, true);
  assert.equal(f.state.legacy, 1);
});

test('Pine opening never reports success for a detached editor after clicking its opener', async t => {
  const f = await fixture(t, { detached: true });
  const result = await f.open();
  assert.equal(result.code, 'VERIFICATION_FAILED');
  assert.equal(result.mutation_attempted, true);
  assert.equal(f.state.clicks, 1);
});
