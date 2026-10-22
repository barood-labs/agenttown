// Parses AI coding agent session logs into a flat list of town events.
// Supported: Claude Code (~/.claude/projects/**/*.jsonl), OpenAI Codex CLI (~/.codex/sessions/**/*.jsonl).

export type EventKind = 'prompt' | 'think' | 'read' | 'search' | 'edit' | 'write' | 'bash' | 'test_pass' | 'test_fail' | 'done';

export interface TownEvent {
  kind: EventKind;
  file?: string;      // repo-relative path when the event touches a file
  label: string;      // short human text for the log
  tokens: number;     // cumulative tokens after this event
}

export interface Session {
  agent: 'claude-code' | 'codex' | 'unknown';
  title: string;
  events: TownEvent[];
  files: string[];
}

const TEST_RE = /\b(test|tests|jest|vitest|pytest|mocha|ava|tap|cargo\s+test|go\s+test|npm\s+t\b|pnpm\s+t\b|rspec|phpunit|unittest)\b/i;
const FAIL_RE = /(\bFAIL(ED)?\b|\b[1-9]\d*\s+(failed|failing|failures?)\b|AssertionError|✗|✖|Traceback|panicked|error\[|Tests?:\s+\d+\s+failed)/i;

function short(s: string, n = 70): string {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function rel(path: string | undefined, root: string): string | undefined {
  if (!path) return undefined;
  let p = String(path).replace(/\\/g, '/');
  if (root && p.startsWith(root + '/')) p = p.slice(root.length + 1);
  p = p.replace(/^\.\//, '');
  if (p.startsWith('/')) {
    // keep the last 3 segments of absolute paths outside the project
    const parts = p.split('/').filter(Boolean);
    p = parts.slice(-3).join('/');
  }
  return p || undefined;
}

function toText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x: any) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n');
  if (c && typeof c === 'object') return (c as any).text ?? JSON.stringify(c);
  return '';
}

function lines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip junk lines */ }
  }
  return out;
}

export function parseSession(text: string): Session {
  const rows = lines(text);
  const isCodex = rows.some(r => r?.type === 'response_item' || r?.type === 'session_meta' || (r?.payload && r?.timestamp));
  const isClaude = rows.some(r => (r?.type === 'assistant' || r?.type === 'user') && r?.message);
  let s: Session;
  if (isClaude) s = parseClaude(rows);
  else if (isCodex) s = parseCodex(rows);
  else throw new Error('Unrecognized session format. AgentTown reads Claude Code and Codex JSONL logs.');
  if (!s.events.length) throw new Error('No replayable events found in this session.');
  s.events.push({ kind: 'done', label: 'Session complete', tokens: s.events[s.events.length - 1].tokens });
  s.files = [...new Set(s.events.map(e => e.file).filter(Boolean) as string[])];
  return s;
}

function bashEvent(cmd: string, root: string): TownEvent {
  const m = cmd.match(/(?:^|\s)(?:cat|less|head|tail|sed -n \S+)\s+([\w./-]+\.\w+)/);
  if (m) return { kind: 'read', file: rel(m[1], root), label: `$ ${short(cmd, 60)}`, tokens: 0 };
  return { kind: 'bash', label: `$ ${short(cmd, 60)}`, tokens: 0 };
}

function parseClaude(rows: any[]): Session {
  const events: TownEvent[] = [];
  const pending = new Map<string, TownEvent>();
  let tokens = 0;
  let root = '';
  let title = '';
  for (const r of rows) {
    if (r.cwd && !root) root = String(r.cwd).replace(/\\/g, '/');
    if (r.type === 'summary' && r.summary && !title) title = r.summary;
    const msg = r.message;
    if (!msg) continue;
    const u = msg.usage;
    if (u) tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || []);
    for (const c of content) {
      if (r.type === 'user' && c.type === 'text' && !r.isMeta) {
        const t = c.text || '';
        if (t.startsWith('<') || t.startsWith('Caveat:')) continue;
        if (!title) title = short(t, 60);
        events.push({ kind: 'prompt', label: `you: ${short(t)}`, tokens });
      } else if (r.type === 'user' && c.type === 'tool_result') {
        const ev = pending.get(c.tool_use_id);
        if (ev && ev.kind === 'bash' && TEST_RE.test(ev.label)) {
          const out = toText(c.content);
          ev.kind = c.is_error || FAIL_RE.test(out) ? 'test_fail' : 'test_pass';
        }
      } else if (r.type === 'assistant' && c.type === 'text' && c.text?.trim()) {
        events.push({ kind: 'think', label: short(c.text), tokens });
      } else if (r.type === 'assistant' && c.type === 'tool_use') {
        const i = c.input || {};
        const f = rel(i.file_path || i.notebook_path || i.path, root);
        let ev: TownEvent;
        switch (c.name) {
          case 'Read': ev = { kind: 'read', file: f, label: `read ${f}`, tokens }; break;
          case 'Edit': case 'MultiEdit': case 'NotebookEdit': ev = { kind: 'edit', file: f, label: `edit ${f}`, tokens }; break;
          case 'Write': ev = { kind: 'write', file: f, label: `write ${f}`, tokens }; break;
          case 'Grep': case 'Glob': case 'LS': ev = { kind: 'search', file: f, label: `${c.name.toLowerCase()} ${short(i.pattern || i.path || '', 50)}`, tokens }; break;
          case 'Bash': ev = { ...bashEvent(i.command || '', root), tokens }; break;
          default: ev = { kind: 'think', label: `${c.name} ${short(JSON.stringify(i), 50)}`, tokens };
        }
        events.push(ev);
        if (c.id) pending.set(c.id, ev);
      }
    }
  }
  return { agent: 'claude-code', title: title || 'Claude Code session', events, files: [] };
}

function parseCodex(rows: any[]): Session {
  const events: TownEvent[] = [];
  const pending = new Map<string, TownEvent>();
  let tokens = 0;
  let root = '';
  let title = '';
  for (const r of rows) {
    const p = r.payload ?? r;
    if (p.cwd && !root) root = String(p.cwd).replace(/\\/g, '/');
    if (r.type === 'event_msg' && p.type === 'token_count') {
      const t = p.info?.total_token_usage?.total_tokens;
      if (typeof t === 'number') tokens = t;
      continue;
    }
    if (p.type === 'message' && p.role === 'user') {
      const t = toText(p.content);
      if (!t || t.startsWith('<')) continue;
      if (!title) title = short(t, 60);
      events.push({ kind: 'prompt', label: `you: ${short(t)}`, tokens });
    } else if (p.type === 'message' && p.role === 'assistant') {
      const t = toText(p.content);
      if (t.trim()) events.push({ kind: 'think', label: short(t), tokens });
    } else if (p.type === 'reasoning') {
      const t = toText(p.summary);
      if (t.trim()) events.push({ kind: 'think', label: short(t), tokens });
    } else if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
      let args: any = p.arguments ?? p.action ?? p.input ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { input: args }; } }
      const patch: string = typeof args.input === 'string' ? args.input : (p.name === 'apply_patch' ? JSON.stringify(args) : '');
      const fileOps = [...patch.matchAll(/\*\*\* (Update|Add|Delete) File: (.+)/g)];
      if (fileOps.length) {
        for (const m of fileOps) {
          const f = rel(m[2].trim(), root);
          events.push({ kind: m[1] === 'Add' ? 'write' : 'edit', file: f, label: `${m[1] === 'Add' ? 'write' : 'edit'} ${f}`, tokens });
        }
        continue;
      }
      let cmd = args.command ?? args.cmd ?? '';
      if (Array.isArray(cmd)) cmd = cmd[0] === 'bash' && cmd[1] === '-lc' ? cmd.slice(2).join(' ') : cmd.join(' ');
      const inner = String(cmd).match(/apply_patch[\s\S]*/);
      if (inner) {
        for (const m of inner[0].matchAll(/\*\*\* (Update|Add) File: (.+)/g)) {
          const f = rel(m[2].trim(), root);
          events.push({ kind: m[1] === 'Add' ? 'write' : 'edit', file: f, label: `edit ${f}`, tokens });
        }
        continue;
      }
      const ev = { ...bashEvent(String(cmd), root), tokens };
      events.push(ev);
      if (p.call_id) pending.set(p.call_id, ev);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const ev = pending.get(p.call_id);
      if (ev && ev.kind === 'bash' && TEST_RE.test(ev.label)) {
        let out: any = p.output;
        if (typeof out === 'string') { try { out = JSON.parse(out); } catch { /* plain */ } }
        const text = typeof out === 'string' ? out : (out?.output ?? JSON.stringify(out));
        const code = out?.metadata?.exit_code;
        ev.kind = (typeof code === 'number' && code !== 0) || FAIL_RE.test(text) ? 'test_fail' : 'test_pass';
      }
    }
  }
  for (const e of events) if (!e.tokens) e.tokens = 0;
  return { agent: 'codex', title: title || 'Codex session', events, files: [] };
}
