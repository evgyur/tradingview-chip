import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSkillDocuments, validateSkillDirectory } from '../scripts/validate-skill.mjs';

const root = `---
name: tradingview-chip
description: Work with TradingView MCP charts and Pine scripts.
---
# TradingView MCP and Pine
Read-only is the default mode.
First resolve the exact target_id and expected_layout_id.
Never submit real broker orders or trades.
Never extract or export secrets, credentials, cookies, tokens, or session material.
Reconcile uncertain mutations with the same idempotency key.
Read the [permission manifest](references/permission-manifest.md).
## Output Contract
Report observed readback and uncertainty.
## Quick Test Checklist
Check the exact target and result.
## Done Criteria
Verify the intended result.
`;
const manifest = `# tradingview-chip permission manifest
Allowed tools and network/API: exact scoped chart reads.
Forbidden: real broker orders.
Mutations need explicit authorization for the specific target.
Never collect secrets or credentials.
Verify results with independent readback.
`;

test('skill contract accepts the minimal complete public operating contract', () => {
  assert.deepEqual(validateSkillDocuments(root, manifest), []);
});

const negativeCases = [
  ['skill-name', 'name: tradingview-chip', 'name: different-name'],
  ['skill-description', 'description: Work with TradingView MCP charts and Pine scripts.', ''],
  ['tradingview-mcp-pine-triggers', /Pine/g, 'script'],
  ['exact-target-and-layout', 'expected_layout_id', 'layout'],
  ['read-only-default', 'Read-only is the default mode.', 'Use read-only mode.'],
  ['real-orders-forbidden', 'Never submit real broker orders or trades.', 'Broker data can be read.'],
  ['secrets-forbidden', 'Never extract or export secrets, credentials, cookies, tokens, or session material.', 'Account data is private.'],
  ['uncertain-mutation-reconciliation', 'Reconcile uncertain mutations with the same idempotency key.', 'Retry actions.'],
  ['permission-manifest-link', '[permission manifest](references/permission-manifest.md)', 'permission manifest'],
  ['section-output-contract', '## Output Contract', '## Results'],
  ['section-quick-test-checklist', '## Quick Test Checklist', '## Examples'],
  ['section-done-criteria', '## Done Criteria', '## Notes'],
];
for (const [rule, before, after] of negativeCases) {
  test(`skill contract rejects removal of ${rule}`, () => {
    const findings = validateSkillDocuments(root.replace(before, after), manifest);
    assert.ok(findings.some(item => item.rule === rule), rule);
  });
}
test('skill contract requires the manifest authorization and secret boundaries', () => {
  const findings = validateSkillDocuments(root, 'tradingview-chip');
  for (const rule of ['manifest-allowed-surface', 'manifest-forbidden-surface', 'manifest-authorization', 'manifest-secret-boundary', 'manifest-readback']) {
    assert.ok(findings.some(item => item.rule === rule), rule);
  }
});
test('skill identity cannot be spoofed with body text outside frontmatter', () => {
  const spoofed = root.replace('name: tradingview-chip', 'name: different-name') + '\nname: tradingview-chip\n';
  assert.ok(validateSkillDocuments(spoofed, manifest).some(item => item.rule === 'skill-name'));
});
for (const [rule, instruction] of [
  ['real-order-permission', 'Place real broker orders.'],
  ['raw-action-permission', 'Use a raw request wrapper.'],
  ['blanket-approval-permission', 'Go authorizes all future mutations.'],
]) {
  test(`skill contract rejects unsafe ${rule}`, () => {
    assert.ok(validateSkillDocuments(root + '\n' + instruction, manifest).some(item => item.rule === rule));
    assert.ok(validateSkillDocuments(root, manifest + '\n' + instruction).some(item => item.rule === rule));
    assert.equal(validateSkillDocuments(root + '\nNever ' + instruction.toLowerCase(), manifest).some(item => item.rule === rule), false);
  });
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'tv-skill-contract-'));
  try {
    await mkdir(join(directory, 'references'));
    await writeFile(join(directory, 'SKILL.md'), root);
    await writeFile(join(directory, 'references', 'permission-manifest.md'), manifest);
    await run(directory);
  } finally {
    const confined = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(confined.startsWith('tv-skill-contract-') && !isAbsolute(confined) && !confined.includes('..'));
    await rm(directory, { recursive: true, force: true });
  }
}
test('directory validator checks links and reports only rule metadata', async () => {
  await fixture(async directory => {
    assert.equal((await validateSkillDirectory(directory)).passed, true);
    await writeFile(join(directory, 'SKILL.md'), root + '\n[Missing reference](references/missing.md)\n');
    const result = await validateSkillDirectory(directory);
    assert.equal(result.passed, false);
    assert.ok(result.findings.some(item => item.rule === 'local-link-missing'));
    assert.equal(JSON.stringify(result).includes(directory), false);
  });
});
test('directory validator rejects links outside the portable skill', async () => {
  await fixture(async directory => {
    await writeFile(join(directory, 'SKILL.md'), root + '\n[External local file](../outside.md)\n');
    assert.ok((await validateSkillDirectory(directory)).findings.some(item => item.rule === 'local-link-outside-skill'));
  });
});
test('directory validator rejects credential-shaped values without echoing them', async () => {
  await fixture(async directory => {
    const credential = 'ghp_' + 'A'.repeat(36);
    await writeFile(join(directory, 'references', 'permission-manifest.md'), manifest + '\n' + credential);
    const result = await validateSkillDirectory(directory);
    assert.ok(result.findings.some(item => item.rule === 'credential-shaped-value'));
    assert.equal(JSON.stringify(result).includes(credential), false);
  });
});
test('published tradingview-chip skill satisfies its operating contract', async () => {
  const result = await validateSkillDirectory(resolve('skills/tradingview-chip'));
  assert.deepEqual(result, { passed: true, findings: [] });
});
