import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSync } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'agenttown-test-'));
buildSync({ entryPoints: [new URL('../src/parser.ts', import.meta.url).pathname], outfile: join(dir, 'parser.mjs'), format: 'esm', bundle: true, logLevel: 'error' });
const { parseSession, exitCodeOf } = await import(join(dir, 'parser.mjs'));
const fx = n => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const kinds = s => s.events.map(e => e.kind);

test('claude: usage counted once per message.id', () => {
  const s = parseSession(fx('claude-code-v2.jsonl'));
  // msg_A 260 once + 8 messages x 25
  assert.equal(s.events.at(-1).tokens, 260 + 8 * 25);
});

test('claude: duplicate uuids skipped, compact detected, tool mapping', () => {
  const s = parseSession(fx('claude-code-v2.jsonl'));
  assert.equal(s.agent, 'claude-code');
  assert.equal(s.title, 'Fix flaky rate limiter tests');
  assert.deepEqual(kinds(s), ['prompt', 'think', 'read', 'agent', 'web', 'web', 'todo', 'mcp', 'edit', 'test_fail', 'compact', 'test_pass', 'done']);
  assert.match(s.events[3].label, /Explore/);
  assert.match(s.events[6].label, /1\/2/);
  assert.match(s.events[7].label, /github: create_issue/);
  assert.deepEqual(s.files, ['src/limiter.ts']);
});

test('codex: exit code from plain-string output', () => {
  assert.equal(exitCodeOf('Exit code: 1\nWall time: 2s'), 1);
  assert.equal(exitCodeOf('Chunk ID: x\nProcess exited with code 0\n'), 0);
  assert.equal(exitCodeOf('no code here'), undefined);
});

test('codex: v2 rollout maps all item types', () => {
  const s = parseSession(fx('codex-rollout-v2.jsonl'));
  assert.equal(s.agent, 'codex');
  assert.equal(s.title, 'Make the limiter tests pass');
  assert.deepEqual(kinds(s), ['prompt', 'think', 'test_fail', 'web', 'edit', 'test_pass', 'bash', 'mcp', 'todo', 'agent', 'compact', 'think', 'done']);
  assert.equal(s.events[4].failed, true, 'patch_apply_end success:false marks the edit failed');
  assert.equal(s.events[6].failed, true, 'lint exit 2 marks bash failed');
  assert.equal(s.events.at(-1).tokens, 9800);
});

test('legacy samples still parse', () => {
  for (const f of ['claude-code-demo.jsonl', 'codex-demo.jsonl']) {
    const s = parseSession(readFileSync(new URL(`../public/samples/${f}`, import.meta.url), 'utf8'));
    assert.ok(s.events.filter(e => e.kind === 'test_fail').length >= 2, f);
    assert.ok(s.events.some(e => e.kind === 'test_pass'), f);
  }
});

test('cli: --list skips subagent sidechains', async () => {
  const { execFileSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'agenttown-home-'));
  const proj = join(home, '.claude', 'projects', '-Users-dev-acme');
  mkdirSync(join(proj, 'sess1', 'subagents'), { recursive: true });
  const body = fx('claude-code-v2.jsonl');
  writeFileSync(join(proj, 'sess1.jsonl'), body);
  writeFileSync(join(proj, 'sess1', 'subagents', 'agent-a1b2.jsonl'), body);
  writeFileSync(join(proj, 'agent-aprompt_suggestion-123.jsonl'), body);
  const out = execFileSync('node', [new URL('../cli/agenttown.mjs', import.meta.url).pathname, '--list'], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' } }).toString();
  assert.match(out, /sess1\.jsonl/);
  assert.doesNotMatch(out, /agent-/);
});

test('claude: home paths redacted in labels', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenttown-redact-'));
  const body = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, cwd: '/Users/alice/acme', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_R', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat /Users/alice/acme/src/a.ts /home/bob/x' } }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] }, uuid: 'u2', parentUuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z' }),
  ].join('\n');
  const s = parseSession(body);
  const bash = s.events.find(e => e.kind === 'bash' || e.kind === 'read');
  assert.ok(bash, 'has bash/read');
  assert.doesNotMatch(bash.label, /alice|bob/);
  assert.match(bash.label, /~/);
});
