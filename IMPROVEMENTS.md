# AgentTown: ranked improvements (research 2026-10-22)

> Status 2026-10-23: v0.2.x shipped live `--watch`, `--gif` CLI, folder labels, building inspector,
> Claude usage dedupe, subagent skip, Codex exit-code parsing, tool mapping, real fixtures.
> Remaining high-value items below. Path redaction + keyboard polish landed in v0.2.1.

## Competitive landscape (live stars)
| Repo | Stars | What it does |
|---|---|---|
| ccusage/ccusage | 19,125 | `npx ccusage` token/cost reports (adjacent: zero-install CLI wins) |
| pixel-agents-hq/pixel-agents | 9,840 | Pixel-art *office* of live Claude Code agents (VS Code + standalone) — closest vibe competitor, live not replay |
| patoles/agent-flow | 1,728 | Live node-graph of Claude Code + Codex, subagents, token/time, file heatmap, JSONL replay |
| simonw/claude-code-transcripts | 1,716 | Publish transcripts as HTML |
| d-kimuson/claude-code-viewer | 1,300 | Web client/viewer for Claude Code |
| daaain/claude-code-log | 1,250 | JSONL → HTML/Markdown; Codex provider, watch mode |
| furkankly/zoetrope | 1,073 | Claude Code + Codex flow graph, TUI + WASM browser, live follow, scrubbable time-travel, subagents |
| es617/claude-replay | 848 | Video-like HTML replay; Claude Code, **Cursor**, Codex, Gemini, OpenCode, Kimi, Hermes; redaction; `--watch`; single-file HTML |
| paulrobello/claude-office | 580 | Real-time pixel office via hooks |
| W17ant/Claude-Office | 274 | Isometric pixel office, hooks + WebSocket |
| JamsusMaximus/codemap | 133 | Real-time pixel-art of Cursor & Claude Code activity |
| rafapetter/agent-town (npm `agent-town` 0.2.0) | 8 | Framework-agnostic pixel office JS library |

Takeaway: the pixel "office" niche is huge (pixel-agents 9.8k) but they are all **live** + office metaphor. AgentTown's unique angle = **replay + city-of-your-repo + shareable GIF**. Gaps vs. leaders: live mode, subagents, more agents (Cursor/Gemini/OpenCode), redaction, shareable link.

## Parser vs real formats — concrete mismatches
1. **Claude token double-count (bug).** Claude Code writes one JSONL line per content block; lines of one API call share `message.id` and repeat `usage`. We sum `usage` on every line → counter inflated (others measured ~2–2.4x). Fix: keep last/max usage per `message.id`. Also we ignore `cache_read_input_tokens` (fine if intentional; label it). Evidence: https://github.com/FullFran/claudeops-tui/blob/main/docs/jsonl-format.md , https://www.bough.run/docs/format/claude-code , https://github.com/Lition13/claude-session-viewer/blob/main/docs/architecture.md
2. **Subagent files picked as "latest session".** CLI `walk()` takes every `*.jsonl` under `~/.claude/projects` up to depth 6, so `<session>/subagents/agent-*.jsonl` (isSidechain) — incl. junk `agent-aprompt_suggestion-*` — can become session #1. Fix: skip `subagents/` in listing; optionally merge them into the parent as a second walker. Evidence: https://github.com/BFriedland/clog/blob/main/docs/SOURCE_FORMATS.md
3. **`Task`/`Agent` tool calls render as generic "think".** Should be a subagent spawn (second character) using `subagent_type`/`description`. Also `TodoWrite`, `WebFetch`, `WebSearch`, MCP `mcp__*` tools fall to default.
4. **Resume/branching:** we read lines in file order; resumed sessions can contain replayed/duplicate records (dedupe by `uuid`) and `file-history-snapshot` rows. https://github.com/anthropics/claude-code/issues/36583
5. **Codex test pass/fail detection is weak (bug).** Current Codex serializes `function_call_output.output` as a **plain string** (`FunctionCallOutputPayload` → `serialize_str`) whose text contains `Exit code: N` / `Wall time: …` (codex-rs/core/src/tools/mod.rs L106-107). Our code looks for `out.metadata.exit_code` (old JSON shape) — never present now — so a failing test without a FAIL keyword is shown as **pass**. Fix: regex `Exit code: (\d+)` (and "Process exited with code N" — unverified for unified exec, test with a real log). Sources: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs , https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/mod.rs
6. **Codex new item types ignored:** `web_search_call`, `tool_search_call`, `agent_message` (subagent/collab), MCP calls; `event_msg` types `patch_apply_end`, `context_compacted`, `turn_aborted` are persisted and usable (patch success/fail, compaction moments). Source: https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs
7. **Detection heuristic** `r.payload && r.timestamp` treats any such JSON as Codex; fine, but Claude check runs first — ok.
8. No real-log test fixtures (only synthetic samples). Need anonymized real sessions from both tools in `test/`.

## Other code/README gaps
- No folder labels on districts (known). Files capped 9/lot cluster; huge repos (>100 files) untested for layout/perf.
- GIF/WebM export never tested in a real browser; GIF runs synchronously on main thread (UI freeze for long sessions); WebM depends on MediaRecorder (Safari support for webm is limited).
- No timestamps used → pacing is per-event, not real time; no idle-gap compression.
- No click/hover inspection of a building/event; no event log panel search.
- No secret redaction before export (prompts/commands appear in GIF title/labels).
- Windows path handling: `rel()` normalizes `\`, but `cwd` prefix match is case-sensitive (drive letters) — competitors had Windows bugs (claude-replay #8, agent-flow #4).
- CLI has no `--watch`/live mode.

## Ranked improvements (star impact ÷ effort)
| # | Improvement | Impact | Effort | Evidence |
|---|---|---|---|---|
| **1 ★** | **Fix real-log correctness**: dedupe Claude usage by `message.id`, skip/merge `subagents/`, Codex `Exit code: N` parsing, map Task/WebSearch/MCP/Todo tools, add real-log fixtures | High (first real users hit these instantly; bad first run = no star) | S (1 day) | sections above |
| **2 ★** | **Live mode `--watch`**: tail the active session; town builds as the agent works. Every big competitor is live (pixel-agents 9,840★, agent-flow 1,728★, zoetrope 1,073★) | Very high | M (2–3 days; file tail + SSE already have local server) | pixel-agents, agent-flow, zoetrope READMEs; claude-replay added `--watch` after launch (HN 47503166) |
| **3 ★** | **Cursor + Gemini CLI + OpenCode support** (`~/.cursor/projects/*/agent-transcripts/`, `~/.gemini/tmp/*/chats/`) | High (claude-replay lists 7 agents; OpenCode support requested in claude-replay #18, agent-flow #53) | S–M per agent | https://github.com/es617/claude-replay , issues #18, agent-flow #53 |
| 4 | **Subagents as extra characters** walking the town (Task / Codex collab) | High visual "wow", demo-able | M | pixel-agents #380 (teammates seats, 5 comments), agent-flow #56, zoetrope subagent cards |
| 5 | **Shareable replay**: single self-contained HTML export or `?url=` gist link + embed | Med-high (virality loop) | S–M | claude-replay's core feature (single HTML, iframe) |
| 6 | **Folder labels, hover/click inspect** (building shows file path, edit count, last command) | Med | S | agent-flow "click into any tool call", zoetrope inspection |
| 7 | **Redaction before export** (secrets, home paths) | Med (trust; blocks sharing otherwise) | S | claude-replay #1 (PII leak, 7 comments) |
| 8 | **Real-time pacing + idle-gap compression + jump-to-next-prompt** using timestamps | Med | S | claude-replay #11 time-warp (5 c.), #10 jump to next user msg (4 c.), zoetrope gap compression |
| 9 | **GIF/MP4 export hardening**: worker-thread GIF, test in Chrome/Firefox/Safari, `agenttown --gif out.gif` headless CLI | Med (GIFs = social posts; claude-replay #23 "render to gif", top issue 9 c.) | M | https://github.com/es617/claude-replay/issues/23 |
| 10 | **Session health / stats overlay** (loops, error count, tokens per file "heat") | Low-med | S | agent-flow #86 health verdict, file attention heatmaps |

### Top 3 to build next
1. Real-log correctness fixes (#1) — prerequisite; cheap.
2. Live `--watch` mode (#2) — the feature the 9.8k★ pixel-office crowd proves people want, combined with our city metaphor.
3. Cursor (+Gemini/OpenCode) support (#3) — widens audience; Cursor users can't use it today.
Then: headless `--gif` CLI (#9) is the best cheap virality add — note claude-replay's #1 request is exactly GIF output, which we already partly have.
