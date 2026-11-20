import test from 'node:test';
import assert from 'node:assert/strict';
import { guarded, sourceHash } from '../src/features/pine.mjs';

const source = '//@version=6\nindicator("New saved test")\nplot(close)';
async function compile(change = {}) {
  let submitted = false;
  const ctx = { callPage: async (_fn, args) => {
    if (args.op === 'get_source') return { ok: true, source: args.script_id && change.savedSource ? 'different' : source, title: 'New saved test' };
    if (args.op === 'native_binding') return { ok: true, source, title: 'New saved test', native_binding: {
      script_id: submitted && change.identity ? 'USER;other' : 'USER;new', version: submitted && change.version ? '2' : '1',
      is_draft: false, is_modified: submitted && change.modified ? true : false,
    } };
    if (args.op === 'chart_pine_versions') {
      if (!submitted) return { ok: true, matches: change.existing ? [{ study_id: 'existing', version: '1' }] : [], study_ids: change.missingInventory ? null : ['existing'] };
      const id = change.reusedEntity ? 'existing' : 'new-entity';
      return { ok: true, matches: change.absent ? [] : change.ambiguous ? [{ study_id: id, version: '1' }, { study_id: 'other', version: '1' }] : [{ study_id: id, version: change.chartVersion ? '2' : '1' }], study_ids: change.missingAfterInventory ? null : ['existing', id] };
    }
    if (args.op === 'compile') { submitted = true; return { ok: false, code: 'VERIFICATION_FAILED', message: 'No immediate success evidence', mutation_attempted: true, action: 'Add to chart' }; }
    if (args.op === 'get_errors') return { ok: true, error_count: change.diagnostics ? 1 : 0 };
    throw new Error('Unexpected operation ' + args.op);
  } };
  return guarded('compile', { expected_source_sha256: sourceHash(source), expected_title: 'New saved test' }, ctx);
}

test('compile reconciles an exact clean saved script on a newly observed chart entity', async () => {
  const result = await compile();
  assert.equal(result.verified, true);
  assert.equal(result.script_id, 'USER;new');
  assert.equal(result.version, '1');
  assert.equal(result.study_id, 'new-entity');
  assert.equal(result.verification_source, 'exact_saved_script_and_source_on_new_chart_study');
});

for (const change of ['savedSource', 'identity', 'version', 'modified', 'existing', 'missingInventory', 'reusedEntity', 'absent', 'ambiguous', 'chartVersion', 'missingAfterInventory', 'diagnostics']) {
  test('new-study compile remains unverified when ' + change + ' differs', async () => {
    await assert.rejects(compile({ [change]: true }), error => error.code === 'VERIFICATION_FAILED');
  });
}
