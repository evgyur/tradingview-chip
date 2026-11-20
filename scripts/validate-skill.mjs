import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const sections = ['Output Contract', 'Quick Test Checklist', 'Done Criteria'];
const hasSection = (text, title) => new RegExp(`^##\\s+${title}\\s*$`, 'im').test(text);
const findingsFor = (text, file, rules) => rules.filter(([, check]) => !check(text)).map(([rule]) => ({ file, rule }));
const frontmatter = text => /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
const unsafeRules = [
  ['real-order-permission', /\b(?:place|submit|execute|cancel|close)\s+(?:real\s+)?broker\s+(?:orders|trades)\b/i],
  ['raw-action-permission', /\b(?:use|allow|enable|provide)\s+(?:a\s+|an\s+|the\s+)?(?:raw_request|raw\s+(?:request|action)\s+(?:wrapper|surface)|trade\(any_payload\))\b/i],
  ['blanket-approval-permission', /\b(?:go|continue|done)\b[^.\n]{0,60}\b(?:authorizes?|approves?|grants?)\b[^.\n]{0,60}\b(?:all|any|future|unspecified)\b/i],
];
const unsafeFindings = (text, file) => {
  const sentences = text.split(/(?<=[.!?])\s+|\r?\n/);
  return unsafeRules.filter(([, pattern]) => sentences.some(sentence =>
    pattern.test(sentence) && !/\b(?:never|do not|must not|forbidden|refuse|cannot|negative|not allowed)\b/i.test(sentence)))
    .map(([rule]) => ({ file, rule }));
};

/** Validate the public operating contract, without returning document contents. */
export function validateSkillDocuments(root, manifest) {
  const rootRules = [
    ['skill-name', text => /^name:\s*["']?tradingview-chip["']?\s*$/m.test(frontmatter(text))],
    ['skill-description', text => { const description = /^description:\s*(.+)$/m.exec(frontmatter(text))?.[1]?.trim(); return !!description && description.length <= 1024; }],
    ['tradingview-mcp-pine-triggers', text => ['TradingView', 'MCP', 'Pine'].every(word => text.includes(word))],
    ['exact-target-and-layout', text => text.includes('target_id') && text.includes('expected_layout_id')],
    ['read-only-default', text => /(?:default[^\n.]{0,100}read.only|read.only[^\n.]{0,100}default)/i.test(text)],
    ['real-orders-forbidden', text => /(?:never|do not|forbid(?:den)?|must not)[^.\n]{0,180}(?:real|broker)[^.\n]{0,80}(?:order|trade)/i.test(text)],
    ['secrets-forbidden', text => /(?:never|do not|forbid(?:den)?|must not)[^.\n]{0,160}(?:extract|export|collect|request|print|store)[^.\n]{0,160}(?:secret|credential|cookie|token|session)/i.test(text)],
    ['uncertain-mutation-reconciliation', text => /uncertain/i.test(text) && /reconcil/i.test(text) && /idempotency/i.test(text)],
    ['permission-manifest-link', text => /\]\(references\/permission-manifest\.md(?:#[^)]+)?\)/.test(text)],
    ...sections.map(title => [`section-${title.toLowerCase().replaceAll(' ', '-')}`, text => hasSection(text, title)]),
  ];
  const manifestRules = [
    ['manifest-identity', text => text.includes('tradingview-chip')],
    ['manifest-allowed-surface', text => /allowed/i.test(text) && /(?:tools|network|API)/i.test(text)],
    ['manifest-forbidden-surface', text => /forbidden/i.test(text) && /broker/i.test(text)],
    ['manifest-authorization', text => /(?:authorization|approval)/i.test(text) && /(?:exact|specific|explicit)/i.test(text)],
    ['manifest-secret-boundary', text => /(?:secret|credential)/i.test(text) && /(?:never|do not|forbid(?:den)?)/i.test(text)],
    ['manifest-readback', text => /(?:readback|read.back|verify|verification)/i.test(text)],
  ];
  return [...findingsFor(root, 'SKILL.md', rootRules), ...findingsFor(manifest, 'references/permission-manifest.md', manifestRules),
    ...unsafeFindings(root, 'SKILL.md'), ...unsafeFindings(manifest, 'references/permission-manifest.md')];
}

const privatePatterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential-shaped-value', /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,})\b/],
  ['private-home-path', /(?:\/(?:Users|home)\/[A-Za-z0-9_.-]+\/|[A-Za-z]:(?:\\|\/)+Users(?:\\|\/)+[A-Za-z0-9_.-]+(?:\\|\/)+)/],
];

export async function validateSkillDirectory(skillDirectory) {
  const directory = resolve(skillDirectory), findings = [];
  const read = async file => {
    try { return await readFile(resolve(directory, file), 'utf8'); }
    catch { findings.push({ file, rule: 'required-file-unreadable' }); return ''; }
  };
  const root = await read('SKILL.md'), manifest = await read('references/permission-manifest.md');
  findings.push(...validateSkillDocuments(root, manifest));
  const documents = [];
  async function visit(folder) {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.md$/i.test(entry.name)) documents.push(path);
    }
  }
  await visit(directory);
  for (const path of documents) {
    const file = relative(directory, path).replaceAll('\\', '/'), text = await readFile(path, 'utf8');
    for (const [rule, pattern] of privatePatterns) if (pattern.test(text)) findings.push({ file, rule });
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1];
      if (/^(?:https?:|mailto:|#)/i.test(href)) continue;
      const link = href.split('#')[0];
      let decoded;
      try { decoded = decodeURIComponent(link); } catch { findings.push({ file, rule: 'invalid-local-link' }); continue; }
      const target = resolve(dirname(path), decoded), offset = relative(directory, target);
      if (isAbsolute(decoded) || /^[A-Za-z]:/.test(decoded) || offset === '..' || offset.startsWith('..\\') || offset.startsWith('../') || isAbsolute(offset)) {
        findings.push({ file, rule: 'local-link-outside-skill' }); continue;
      }
      try { if (!(await stat(target)).isFile()) throw new Error('not a file'); }
      catch { findings.push({ file, rule: 'local-link-missing' }); }
    }
  }
  return { passed: findings.length === 0, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await validateSkillDirectory(process.argv[2] ?? 'skills/tradingview-chip');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.passed) process.exitCode = 1;
}
