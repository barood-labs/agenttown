// Generates synthetic demo sessions (no real user data) in Claude Code and Codex JSONL formats.
import { writeFileSync, mkdirSync } from 'node:fs';
const ROOT = '/home/demo/pomodoro';
const script = [
  ['prompt', 'Build a tiny pomodoro timer CLI with tests and a nice progress bar'],
  ['think', "I'll look at the project layout first."],
  ['bash', 'ls -la'],
  ['read', 'package.json'], ['read', 'README.md'], ['read', 'tsconfig.json'],
  ['think', 'Plan: timer core, formatter, progress bar UI, CLI entry, tests.'],
  ['write', 'src/timer.ts'], ['write', 'src/format.ts'], ['write', 'src/ui/progress.ts'], ['write', 'src/ui/colors.ts'],
  ['write', 'src/cli.ts'], ['edit', 'package.json'],
  ['write', 'tests/timer.test.ts'], ['write', 'tests/format.test.ts'],
  ['test', 'npm test', false, 'FAIL tests/timer.test.ts\n  ✕ pauses and resumes (12 ms)\nTests: 1 failed, 5 passed'],
  ['think', 'resume() restarts from the full duration instead of the remaining time. Fixing.'],
  ['read', 'src/timer.ts'], ['edit', 'src/timer.ts'],
  ['test', 'npm test', false, 'FAIL tests/format.test.ts\n  ✕ pads seconds\nTests: 1 failed, 5 passed'],
  ['read', 'src/format.ts'], ['edit', 'src/format.ts'],
  ['test', 'npm test', true, 'PASS tests/timer.test.ts\nPASS tests/format.test.ts\nTests: 6 passed, 6 total'],
  ['search', 'TODO'],
  ['edit', 'src/ui/progress.ts'], ['write', 'src/ui/sound.ts'], ['edit', 'src/cli.ts'],
  ['write', 'docs/usage.md'], ['edit', 'README.md'],
  ['bash', 'npm run build'],
  ['test', 'npm test', true, 'Tests: 9 passed, 9 total'],
  ['think', 'Done! `npx pomodoro 25` now runs a 25-minute focus session with a progress bar.'],
];

let ts = Date.parse('2026-10-20T15:00:00Z');
const stamp = () => new Date((ts += 4000 + Math.floor(Math.random() * 3000))).toISOString();
let n = 0; const id = () => 'toolu_demo' + String(++n).padStart(4, '0');

// Claude Code
const cl = [];
const sid = '00000000-demo-4000-8000-agenttown001';
const base = { sessionId: sid, cwd: ROOT, version: '2.0.0', gitBranch: 'main', userType: 'external' };
let tokens = 0;
const usage = () => ({ input_tokens: 800 + Math.floor(Math.random() * 1200), output_tokens: 120 + Math.floor(Math.random() * 400) });
const asst = content => cl.push({ ...base, type: 'assistant', timestamp: stamp(), uuid: id(), message: { role: 'assistant', model: 'demo', content, usage: usage() } });
const result = (tid, content, is_error = false) => cl.push({ ...base, type: 'user', timestamp: stamp(), uuid: id(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content, is_error }] } });
for (const [kind, a, ok, out] of script) {
  if (kind === 'prompt') { cl.push({ ...base, type: 'user', timestamp: stamp(), uuid: id(), message: { role: 'user', content: a } }); continue; }
  if (kind === 'think') { asst([{ type: 'text', text: a }]); continue; }
  const tid = id();
  const tool = { read: ['Read', { file_path: `${ROOT}/${a}` }], write: ['Write', { file_path: `${ROOT}/${a}`, content: '// …' }], edit: ['Edit', { file_path: `${ROOT}/${a}`, old_string: 'a', new_string: 'b' }], search: ['Grep', { pattern: a }], bash: ['Bash', { command: a }], test: ['Bash', { command: a }] }[kind];
  asst([{ type: 'tool_use', id: tid, name: tool[0], input: tool[1] }]);
  result(tid, out ?? 'ok', kind === 'test' && !ok);
}
// Codex
ts = Date.parse('2026-10-21T18:00:00Z');
const cx = [{ timestamp: stamp(), type: 'session_meta', payload: { id: 'demo-codex-session', cwd: ROOT, originator: 'codex_cli_rs', cli_version: '0.50.0' } }];
let tot = 0;
const tok = () => cx.push({ timestamp: stamp(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: (tot += 900 + Math.floor(Math.random() * 1500)) } } } });
for (const [kind, a, ok, out] of script) {
  const ri = payload => cx.push({ timestamp: stamp(), type: 'response_item', payload });
  if (kind === 'prompt') { ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: a }] }); continue; }
  if (kind === 'think') { ri({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: a }] }); tok(); continue; }
  const call = id();
  if (kind === 'write' || kind === 'edit') {
    ri({ type: 'custom_tool_call', name: 'apply_patch', call_id: call, input: `*** Begin Patch\n*** ${kind === 'write' ? 'Add' : 'Update'} File: ${a}\n+// …\n*** End Patch` });
    ri({ type: 'custom_tool_call_output', call_id: call, output: 'Success' });
  } else {
    const cmd = kind === 'read' ? `sed -n 1,200p ${a}` : kind === 'search' ? `rg -n ${a}` : a;
    ri({ type: 'function_call', name: 'shell', call_id: call, arguments: JSON.stringify({ command: ['bash', '-lc', cmd] }) });
    ri({ type: 'function_call_output', call_id: call, output: JSON.stringify({ output: out ?? 'ok', metadata: { exit_code: kind === 'test' && !ok ? 1 : 0 } }) });
  }
  tok();
}
mkdirSync('public/samples', { recursive: true });
writeFileSync('public/samples/claude-code-demo.jsonl', cl.map(x => JSON.stringify(x)).join('\n') + '\n');
writeFileSync('public/samples/codex-demo.jsonl', cx.map(x => JSON.stringify(x)).join('\n') + '\n');
console.log('samples written', cl.length, cx.length);
