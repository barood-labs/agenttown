import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
// compile the TS parser on the fly with esbuild (bundled with vite)
const { transform } = await import('esbuild');
const src = (await transform(readFileSync('src/parser.ts', 'utf8'), { loader: 'ts', format: 'esm' })).code;
const { parseSession } = await import('data:text/javascript,' + encodeURIComponent(src));

for (const f of ['claude-code-demo', 'codex-demo']) {
  test(`parses ${f}`, () => {
    const s = parseSession(readFileSync(`public/samples/${f}.jsonl`, 'utf8'));
    const kinds = s.events.map(e => e.kind);
    assert.ok(s.files.includes('src/timer.ts'), 'has src/timer.ts');
    assert.equal(kinds.filter(k => k === 'test_fail').length, 2);
    assert.equal(kinds.filter(k => k === 'test_pass').length, 2);
    assert.ok(kinds.includes('read') && kinds.includes('edit') && kinds.includes('write'));
    assert.equal(kinds.at(-1), 'done');
  });
}
test('rejects junk', () => assert.throws(() => parseSession('hello\nworld')));
