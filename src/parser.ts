// Parses AI coding agent session logs into a flat list of town events.
// Supported: Claude Code (~/.claude/projects/**/*.jsonl), OpenAI Codex CLI (~/.codex/sessions/**/*.jsonl).

export type EventKind = 'prompt' | 'think' | 'read' | 'search' | 'edit' | 'write' | 'bash' | 'test_pass' | 'test_fail'
  | 'agent' | 'web' | 'todo' | 'mcp' | 'compact' | 'done';

export interface TownEvent {
  kind: EventKind;
  file?: string;      // repo-relative path when the event touches a file
  label: string;      // short human text for the log
  tokens: number;     // cumulative tokens after this event
  failed?: boolean;   // a non-test command / patch that failed
}

export interface Session {
  agent: 'claude-code' | 'codex' | 'unknown';
  title: string;
  events: TownEvent[];
  files: string[];
}

const TEST_RE = /\b(test|tests|jest|vitest|pytest|mocha|ava|tap|cargo\s+test|go\s+test|npm\s+t\b|pnpm\s+t\b|rspec|phpunit|unittest)\b/i;
const FAIL_RE = /(\bFAIL(ED)?\b|\b[1-9]\d*\s+(failed|failing|failures?)\b|AssertionError|✗|✖|Traceback|panicked|error\[|Tests?:\s+\d+\s+failed)/i;

/** Strip home-directory prefixes so GIF/exports don't leak usernames. */
function redact(s: string): string {
  return String(s ?? '')
    .replace(/[A-Za-z]:\\Users\\[^\\]+/gi, '~')
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~');
}

function short(s: string, n = 70): string {
  s = redact(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function rel(path: string | undefined, root: string): string | undefined {
  if (!path) return undefined;
  let p = redact(String(path)).replace(/\\/g, '/');
  if (root) {
    const r = redact(root).replace(/\\/g, '/');
    if (p.startsWith(r + '/')) p = p.slice(r.length + 1);
  }
  p = p.replace(/^\.\//, '');
  if (p.startsWith('/') || p.startsWith('~/')) {
    const parts = p.replace(/^~\//, '').split('/').filter(Boolean);
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
  if (/^\s*(rg|grep|find|fd|ls)\b/.test(cmd)) return { kind: 'search', label: `$ ${short(cmd, 60)}`, tokens: 0 };
  return { kind: 'bash', label: `$ ${short(cmd, 60)}`, tokens: 0 };
}

/** Exit code from a Codex tool output string ("Exit code: N" / "Process exited with code N"). */
export function exitCodeOf(text: string): number | undefined {
  const m = String(text ?? '').match(/(?:^|\n)\s*Exit code:\s*(-?\d+)|Process exited with code\s+(-?\d+)/i);
  return m ? Number(m[1] ?? m[2]) : undefined;
}

function settle(ev: TownEvent | undefined, failed: boolean, out: string) {
  if (!ev) return;
  if (ev.kind === 'bash' && TEST_RE.test(ev.label)) ev.kind = failed || FAIL_RE.test(out) ? 'test_fail' : 'test_pass';
  else if (failed) ev.failed = true;
}

function claudeTool(name: string, i: any, root: string): Omit<TownEvent, 'tokens'> {
  const f = rel(i.file_path || i.notebook_path || i.path, root);
  switch (name) {
    case 'Read': return { kind: 'read', file: f, label: `read ${f}` };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { kind: 'edit', file: f, label: `edit ${f}` };
    case 'Write': return { kind: 'write', file: f, label: `write ${f}` };
    case 'Grep': case 'Glob': case 'LS': return { kind: 'search', file: f, label: `${name.toLowerCase()} ${short(i.pattern || i.path || '', 50)}` };
    case 'Bash': return bashEvent(i.command || '', root);
    case 'Task': case 'Agent': return { kind: 'agent', label: `subagent${i.subagent_type ? ` (${i.subagent_type})` : ''}: ${short(i.description || i.prompt || '', 50)}` };
    case 'WebSearch': return { kind: 'web', label: `web search: ${short(i.query || '', 50)}` };
    case 'WebFetch': return { kind: 'web', label: `fetch ${short(i.url || '', 55)}` };
    case 'TodoWrite': {
      const todos: any[] = Array.isArray(i.todos) ? i.todos : [];
      const done = todos.filter(t => t?.status === 'completed').length;
      return { kind: 'todo', label: `todo list ${done}/${todos.length} done` };
    }
  }
  if (name.startsWith('mcp__')) { const [, srv, ...tool] = name.split('__'); return { kind: 'mcp', label: `mcp ${srv}: ${tool.join('__')}` }; }
  return { kind: 'think', label: `${name} ${short(JSON.stringify(i), 50)}` };
}

function parseClaude(rows: any[]): Session {
  const events: TownEvent[] = [];
  const pending = new Map<string, TownEvent>();
  const seenUuid = new Set<string>();
  const usageById = new Map<string, number>();
  let tokens = 0, anon = 0;
  let root = '';
  let title = '';
  for (const r of rows) {
    // resumed / forked sessions can replay earlier records verbatim
    if (r.uuid) { if (seenUuid.has(r.uuid)) continue; seenUuid.add(r.uuid); }
    if (r.cwd && !root) root = String(r.cwd).replace(/\\/g, '/');
    if (r.type === 'summary' && r.summary && !title) title = r.summary;
    const msg = r.message;
    if (!msg) continue;
    const u = msg.usage;
    if (u) {
      // one API response is split over several lines that share message.id and repeat usage: count it once
      const key = msg.id || `anon${anon++}`;
      const v = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const prev = usageById.get(key) ?? 0;
      if (v > prev) { tokens += v - prev; usageById.set(key, v); }
    }
    const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || []);
    for (const c of content) {
      if (r.type === 'user' && c.type === 'text' && !r.isMeta) {
        const t = c.text || '';
        if (t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) continue;
        if (r.isCompactSummary || t.startsWith('This session is being continued from a previous conversation')) {
          events.push({ kind: 'compact', label: 'context compacted', tokens }); continue;
        }
        if (!title) title = short(t, 60);
        events.push({ kind: 'prompt', label: `you: ${short(t)}`, tokens });
      } else if (r.type === 'user' && c.type === 'tool_result') {
        settle(pending.get(c.tool_use_id), !!c.is_error, toText(c.content));
      } else if (r.type === 'assistant' && c.type === 'text' && c.text?.trim()) {
        events.push({ kind: 'think', label: short(c.text), tokens });
      } else if (r.type === 'assistant' && (c.type === 'tool_use' || c.type === 'server_tool_use')) {
        const ev: TownEvent = { ...claudeTool(c.name || '', c.input || {}, root), tokens };
        events.push(ev);
        if (c.id) pending.set(c.id, ev);
      }
    }
  }
  for (const e of events) e.tokens = e.tokens || 0;
  return { agent: 'claude-code', title: title || 'Claude Code session', events, files: [] };
}

const CODEX_SHELL = new Set(['shell', 'container.exec', 'exec_command', 'local_shell', 'shell_command', 'unified_exec']);

function parseCodex(rows: any[]): Session {
  const events: TownEvent[] = [];
  const pending = new Map<string, TownEvent[]>();
  let tokens = 0;
  let root = '';
  let title = '';
  const push = (ev: TownEvent, id?: string) => { events.push(ev); if (id) { if (!pending.has(id)) pending.set(id, []); pending.get(id)!.push(ev); } };
  for (const r of rows) {
    const p = r.payload ?? r;
    if (p.cwd && !root) root = String(p.cwd).replace(/\\/g, '/');
    if (r.type === 'event_msg') {
      if (p.type === 'token_count') {
        const t = p.info?.total_token_usage?.total_tokens;
        if (typeof t === 'number') tokens = t;
      } else if (p.type === 'patch_apply_end') {
        if (p.success === false) for (const ev of pending.get(p.call_id) ?? []) ev.failed = true;
      } else if (p.type === 'context_compacted') {
        events.push({ kind: 'compact', label: 'context compacted', tokens });
      } else if (p.type === 'turn_aborted') {
        events.push({ kind: 'think', label: `turn aborted${p.reason ? ` (${p.reason})` : ''}`, tokens });
      }
      continue;
    }
    if (r.type === 'compacted') { events.push({ kind: 'compact', label: 'context compacted', tokens }); continue; }
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
    } else if (p.type === 'web_search_call') {
      const a = p.action ?? {};
      const q = a.query ?? a.queries?.[0] ?? a.url ?? '';
      events.push({ kind: 'web', label: a.type === 'open_page' ? `open ${short(q, 55)}` : `web search${q ? ': ' + short(q, 50) : ''}`, tokens });
    } else if (p.type === 'tool_search_call') {
      events.push({ kind: 'search', label: 'tool search', tokens });
    } else if (p.type === 'agent_message' || p.type === 'collab_agent_spawn' || /^collab_/.test(p.type ?? '')) {
      events.push({ kind: 'agent', label: `subagent: ${short(toText(p.content ?? p.message ?? p.prompt ?? ''), 55)}`, tokens });
    } else if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
      let args: any = p.arguments ?? p.action ?? p.input ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { input: args }; } }
      const name = String(p.name ?? '');
      const patch: string = typeof args.input === 'string' ? args.input : (name === 'apply_patch' ? JSON.stringify(args) : '');
      const fileOps = [...patch.matchAll(/\*\*\* (Update|Add|Delete) File: (.+)/g)];
      if (fileOps.length) {
        for (const m of fileOps) {
          const f = rel(m[2].trim(), root);
          push({ kind: m[1] === 'Add' ? 'write' : 'edit', file: f, label: `${m[1] === 'Add' ? 'write' : 'edit'} ${f}`, tokens }, p.call_id);
        }
        continue;
      }
      let cmd = args.command ?? args.cmd ?? '';
      if (Array.isArray(cmd)) cmd = cmd[0] === 'bash' && cmd[1] === '-lc' ? cmd.slice(2).join(' ') : cmd.join(' ');
      const inner = String(cmd).match(/apply_patch[\s\S]*/);
      if (inner && /\*\*\* (Update|Add) File:/.test(inner[0])) {
        for (const m of inner[0].matchAll(/\*\*\* (Update|Add) File: (.+)/g)) {
          const f = rel(m[2].trim(), root);
          push({ kind: m[1] === 'Add' ? 'write' : 'edit', file: f, label: `edit ${f}`, tokens }, p.call_id);
        }
        continue;
      }
      if (!cmd && p.type === 'function_call' && name && !CODEX_SHELL.has(name)) {
        if (name === 'update_plan') { const pl: any[] = args.plan ?? []; push({ kind: 'todo', label: `plan ${pl.filter(x => x?.status === 'completed').length}/${pl.length} done`, tokens }, p.call_id); continue; }
        if (name === 'view_image') { push({ kind: 'read', file: rel(args.path, root), label: `view ${rel(args.path, root)}`, tokens }, p.call_id); continue; }
        if (name === 'write_stdin') continue;
        if (/^(spawn_agent|send_input|wait|close_agent|resume_agent)$/.test(name)) { push({ kind: 'agent', label: `subagent: ${name}`, tokens }, p.call_id); continue; }
        // anything else is an MCP / dynamic tool ("server__tool" or "mcp__server__tool")
        const parts = name.replace(/^mcp__/, '').split('__');
        push({ kind: 'mcp', label: parts.length > 1 ? `mcp ${parts[0]}: ${parts.slice(1).join('__')}` : `tool ${name}`, tokens }, p.call_id);
        continue;
      }
      push({ ...bashEvent(String(cmd), root), tokens }, p.call_id);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      let out: any = p.output;
      if (out && typeof out === 'object' && !Array.isArray(out) && 'content' in out && !('output' in out)) out = out.content;
      if (Array.isArray(out)) out = toText(out);
      if (typeof out === 'string') { try { const j = JSON.parse(out); if (j && typeof j === 'object') out = j; } catch { /* plain string (current Codex) */ } }
      const text = typeof out === 'string' ? out : (out?.output ?? JSON.stringify(out));
      let code: number | undefined = typeof out?.metadata?.exit_code === 'number' ? out.metadata.exit_code : exitCodeOf(text);
      const failed = (code !== undefined && code !== 0) || out?.success === false;
      for (const ev of pending.get(p.call_id) ?? []) settle(ev, failed, text);
    }
  }
  for (const e of events) if (!e.tokens) e.tokens = 0;
  return { agent: 'codex', title: title || 'Codex session', events, files: [] };
}
