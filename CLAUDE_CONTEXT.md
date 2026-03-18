# Kora — Complete Project Context

> This document contains full context for continuing development of Kora. Feed this to a new Claude session to get up to speed instantly.

## What Is Kora

Kora is a multi-agent orchestration platform for AI coding CLI agents. It runs multiple agents (Claude Code, Codex, Aider, Kiro, Goose) simultaneously on the same project, with a browser-based dashboard for monitoring, communication, task management, and terminal access.

**Architecture**: Daemon (Node.js) + Dashboard (React) + Per-agent MCP servers. Monorepo with 3 packages.

## Repository Structure

```
/Users/ashishranjan738/Projects/Kora/
├── package.json                    # Root — name: "kora", workspaces
├── tsconfig.json                   # Root tsconfig with composite project references
├── packages/
│   ├── shared/                     # @kora/shared — Types, API contracts, constants
│   │   ├── src/
│   │   │   ├── types.ts            # Core domain types (Session, Agent, Task, Event, etc.)
│   │   │   ├── api.ts              # API request/response types
│   │   │   ├── providers.ts        # CLIProvider interface
│   │   │   ├── constants.ts        # DAEMON_DIR=".kora", ports, limits
│   │   │   └── index.ts            # Re-exports everything
│   │   └── tsconfig.json           # outDir: dist, composite: true
│   │
│   ├── daemon/                     # @kora/daemon — Express + WS + SQLite + holdpty/tmux
│   │   ├── src/
│   │   │   ├── cli.ts              # CLI entry point (start/stop/status, --dev flag)
│   │   │   ├── daemon-lifecycle.ts # PID/port/token file management, getGlobalConfigDir()
│   │   │   ├── index.ts            # Re-export
│   │   │   ├── server/
│   │   │   │   ├── index.ts        # Express app + WS server + token injection
│   │   │   │   ├── api-routes.ts   # All REST endpoints (~1500 lines)
│   │   │   │   └── auth.ts         # Bearer token middleware
│   │   │   ├── core/
│   │   │   │   ├── orchestrator.ts # Main orchestrator — ties everything together
│   │   │   │   ├── agent-manager.ts # Spawn/stop/restore agents via holdpty/tmux
│   │   │   │   ├── database.ts     # SQLite (better-sqlite3) — events, tasks, comments
│   │   │   │   ├── event-log.ts    # Event logging → SQLite (JSONL fallback)
│   │   │   │   ├── logger.ts       # Pino structured JSON logger singleton
│   │   │   │   ├── message-queue.ts # Rate-limited message delivery (MCP + terminal modes)
│   │   │   │   ├── auto-relay.ts   # @mention detection in terminal output
│   │   │   │   ├── persona-builder.ts # Builds system prompts with team awareness
│   │   │   │   ├── tmux-controller.ts # tmux wrapper (fallback backend)
│   │   │   │   ├── holdpty-controller.ts # holdpty wrapper (default backend, detached mode)
│   │   │   │   ├── pty-backend.ts  # IPtyBackend interface for terminal provider abstraction
│   │   │   │   ├── pty-manager.ts  # node-pty for terminal streaming + sendKeys bridge
│   │   │   │   ├── session-manager.ts # Session CRUD, persistence
│   │   │   │   ├── worktree.ts     # Git worktree manager
│   │   │   │   ├── state-persistence.ts # Save/load agent state to disk
│   │   │   │   ├── cost-tracker.ts # Token/cost tracking
│   │   │   │   ├── usage-monitor.ts # Polls terminal for token usage
│   │   │   │   ├── agent-health.ts # Health monitoring via holdpty/tmux
│   │   │   │   ├── agent-control-plane.ts # File-based command system
│   │   │   │   ├── message-bus.ts  # File-based message system
│   │   │   │   ├── notifications.ts # In-memory event bus
│   │   │   │   ├── project-config.ts # .kora.yml parser
│   │   │   │   ├── playbook-loader.ts # Built-in playbook templates
│   │   │   │   ├── model-discovery.ts # Dynamic model discovery via provider CLI
│   │   │   │   └── terminal-stream.ts # Terminal output ring buffer (100K lines)
│   │   │   ├── mcp/
│   │   │   │   └── agent-mcp-server.ts # MCP JSON-RPC server (send/check/list/broadcast/tasks)
│   │   │   └── cli-providers/
│   │   │       ├── claude-code.ts  # Claude Code CLI provider
│   │   │       ├── codex.ts        # Codex provider
│   │   │       ├── aider.ts        # Aider provider
│   │   │       ├── kiro.ts         # Kiro provider
│   │   │       ├── goose.ts        # Goose provider
│   │   │       ├── provider-registry.ts # Registry pattern
│   │   │       ├── index.ts        # Exports registry with all providers
│   │   │       └── arg-validator.ts # CLI argument sanitization
│   │   └── tsconfig.json
│   │
│   └── dashboard/                  # React + Vite dashboard
│       ├── index.html              # Title: "Kora"
│       ├── vite.config.ts
│       ├── postcss.config.cjs      # Mantine PostCSS preset + breakpoint vars
│       ├── src/
│       │   ├── main.tsx            # React entry + MantineProvider wrapper
│       │   ├── App.tsx             # Routes: /, /session/:id, /session/:id/overview, etc.
│       │   ├── theme.ts           # Mantine theme config mapping CSS vars
│       │   ├── index.css           # All CSS (~3200 lines) with CSS variables + responsive media queries
│       │   ├── pages/
│       │   │   ├── AllSessions.tsx  # Home page — session list, playbook launcher
│       │   │   ├── SessionDetail.tsx # Session view — tabs (Editor/Changes/Agents/Tasks/Timeline)
│       │   │   ├── MultiAgentView.tsx # Command Center — react-mosaic tiling
│       │   │   ├── AgentView.tsx    # Single agent chat view
│       │   │   ├── SettingsPage.tsx  # Theme settings + daemon status
│       │   │   └── TaskBoardPage.tsx # Standalone task board
│       │   ├── components/
│       │   │   ├── AgentTerminal.tsx # xterm.js + node-pty WebSocket terminal
│       │   │   ├── AgentCardTerminal.tsx # Small terminal preview for agent cards
│       │   │   ├── EditorTile.tsx   # Monaco editor with file tree + tabs + Ctrl+P search
│       │   │   ├── GitChanges.tsx   # Side-by-side DiffEditor + nested git repo support
│       │   │   ├── TaskBoard.tsx    # Kanban board with Mantine components + drag-and-drop
│       │   │   ├── Timeline.tsx     # Event timeline with expandable details
│       │   │   ├── Navbar.tsx       # Mantine Burger + Drawer for mobile, Select for sessions
│       │   │   ├── FlagIndicator.tsx # Compact flag/channel badges with Popover expand
│       │   │   ├── MarkdownText.tsx # Markdown renderer (marked + DOMPurify + TypographyStylesProvider)
│       │   │   ├── SideTerminalPanel.tsx # Resizable debug terminal panel
│       │   │   ├── SpawnAgentDialog.tsx
│       │   │   ├── ReplaceAgentDialog.tsx
│       │   │   ├── RestartAllDialog.tsx # Professional dialog with progress states
│       │   │   ├── StopSessionDialog.tsx
│       │   │   └── SessionSettingsDialog.tsx
│       │   ├── stores/
│       │   │   ├── themeStore.ts    # Zustand — app/editor/terminal themes with localStorage
│       │   │   └── sessionStore.ts  # Zustand — sessions + API token
│       │   └── hooks/
│       │       ├── useApi.ts        # All API calls with token injection
│       │       └── useWebSocket.ts  # WebSocket hook with auto-reconnect
│       └── tsconfig.json
```

## Key Technical Decisions

### Naming Convention
- Package scope: `@kora/`
- Config directory: `.kora/` (per-project), `~/.kora/` (global)
- Dev mode: `~/.kora-dev/`, port 7891
- Env vars: `KORA_DEV`, `KORA_CONFIG_DIR`
- Token: `window.__KORA_TOKEN__`
- localStorage keys: `kora-theme`, `kora-editor-theme`, `kora-terminal-theme`, `kora_token`
- CSS classes: `.kora-mosaic-theme`
- MCP server name: `kora-mcp`
- MCP tool prefix: `mcp__kora__`

### Express 5
Uses path-to-regexp v8 — no `*` wildcard for SPA fallback. Uses middleware instead.

### Auth
Bearer token generated on daemon start, injected into HTML as `<script>window.__KORA_TOKEN__="..."</script>` BEFORE module scripts. GET non-API routes skip auth (serves dashboard HTML).

### Agent Spawning Flow
1. Generate agent ID, write persona file
2. Create git worktree for code isolation (if isolated mode + git repo)
3. Generate MCP config with `--project-path` = `path.resolve(runtimeDir, "..")` (NOT worktree)
4. Build CLI command via provider's `buildCommand()` (returns `string[]`, not shell string)
5. Append `--mcp-config` and `--allowedTools` for MCP-capable providers
6. Create holdpty session (`holdpty launch --bg` for detached persistence)
7. Wait for shell prompt (poll capturePane every 200ms, max 3s)
8. Set env vars via `sendKeys("export K=V")` (KORA_DEV, KORA_CONFIG_DIR, user envVars)
9. `cd` to working directory, wait for prompt
10. Send CLI command via `sendKeys`
11. If initialTask: wait 5s then send via sendKeys
12. Start health monitoring + pipe-pane logging

### Terminal Backend: Holdpty (Default) vs Tmux (Fallback)
- **holdpty** (default): Uses `holdpty launch --bg` for detached PTY sessions that survive daemon restart. Communication via Unix socket binary protocol. Sessions discovered via metadata files at `/tmp/dt-{UID}/`.
- **tmux** (fallback): Uses tmux sessions with `mouse off`. Selected via `--terminal-backend tmux`.
- **IPtyBackend interface**: Both backends implement `newSession`, `hasSession`, `killSession`, `sendKeys`, `capturePane`, `setEnvironment`, `listSessions`, `pipePaneStart/Stop`, `getPanePID`, `getAttachCommand`.
- **PtyManager bridge**: When dashboard terminal holds exclusive holdpty attach, `sendKeys` routes through PtyManager's existing PTY connection.
- **Session persistence**: holdpty `--bg` sessions survive daemon restart. On startup, `orchestrator.restore()` checks `isSessionActive()` (PID-based) and re-registers alive agents.

### Structured Logging (pino)
- Logger singleton at `packages/daemon/src/core/logger.ts`
- Structured JSON output with timestamps
- Log levels via `KORA_LOG_LEVEL` env var (default: info)
- Dev mode: `pino-pretty` for colored output
- Express request logging via `pino-http` middleware
- `make logs-dev` pipes through `pino-pretty`

### MCP Inter-Agent Messaging
- MCP server runs per-agent as a child process (JSON-RPC over stdio)
- Tools: `send_message`, `check_messages`, `list_agents`, `broadcast`, `list_tasks`, `update_task`
- Messages delivered via file-based inbox (`{project}/.kora/messages/inbox-{agentId}/`)
- Short tmux notification sent after file write: `[New message from X. Use check_messages tool to read it.]`
- Token/port read dynamically from `~/.kora/` (or `~/.kora-dev/`) on every API call — survives daemon restarts
- Circuit breaker: 10 send_message calls per 2 minutes

### Message Queue
- `messagingMode`: "mcp" (default), "terminal", or "manual"
- MCP mode: writes full message to inbox file, sends short notification to tmux
- Terminal mode: collapses newlines to `" | "`, truncates to 500 chars, sends via tmux send-keys
- Rate limiting: 10 messages per agent per 60 seconds
- Conversation loop detection: 8 messages between same pair per 2 minutes
- Prompt detection: checks for `❯`, `>`, `$`, `%`, `? for shortcuts` before delivering
- 60-second timeout: force delivers if agent never reaches prompt

### SQLite (better-sqlite3)
- One `data.db` per session at `{project}/.kora/data.db`
- WAL mode for concurrent reads during writes
- Tables: `events`, `tasks`, `task_comments`
- All task operations are synchronous (better-sqlite3 is sync)
- Events are indexed by `(session_id, timestamp DESC)` and `(type)`
- EventLog class has SQLite primary path with JSONL fallback

### Activity Detection
- Polls agent terminal output every 3 seconds (last 15 lines)
- Hashes output text to detect changes
- If text is flowing (hash changed): working (with sub-classification via pattern matching)
- If no change for 3+ minutes: idle
- Pattern matching for specific states: Reading files, Writing files, Running command
- Crashed/stopped agents mapped directly from API status

### Theme System
- Zustand store with `mode` (system/light/dark), `editorTheme` (auto/vs-dark/vs/hc-black), `terminalTheme` (auto/dark/light)
- All persisted to localStorage with `kora-` prefix
- CSS variables: `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--border-color`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent-blue/green/yellow/red/purple`
- `[data-theme="light"]` overrides in CSS
- Terminal themes are xterm.js color objects (DARK_TERMINAL / LIGHT_TERMINAL)
- Editor theme from `resolvedEditorTheme` applied to Monaco `<Editor theme={...}>`

### Scale Protections
- Stale tmux cleanup: on startup (kills sessions not matching any active session), periodic (5 min), on session delete
- Terminal log rotation: 5MB cap, truncates to last 1MB, checked every 60s
- WebSocket push: server broadcasts `agent-spawned`, `agent-removed`, `task-created`, `task-updated`, `task-deleted`, `session-stopped` — dashboard listens and refreshes instantly
- Polling reduced from 3s to 10s (WebSocket handles instant updates)
- Git worktree cleanup on agent stop and session delete
- Message rate limiting prevents agent chat loops

### Dev Mode
- `--dev` flag or `KORA_DEV=1` env var
- Uses port 7891 (vs 7890 production)
- Config dir: `~/.kora-dev/` (vs `~/.kora/`)
- Propagated to agent MCP servers via tmux environment
- Both instances can run simultaneously with zero interference

## How to Build

```bash
cd /Users/ashishranjan738/Projects/Kora

# If "Cannot find module @kora/shared" — clean build:
rm -f packages/shared/tsconfig.tsbuildinfo
npm run build:shared

# Daemon
npx tsc -p packages/daemon/tsconfig.json

# Dashboard (install deps first for Mantine + marked + dompurify)
cd packages/dashboard && npm install && npm run build && cd ../..
```

## How to Run

```bash
# Production (holdpty default backend)
node packages/daemon/dist/cli.js start
# → http://localhost:7890, config ~/.kora/

# Dev mode
node packages/daemon/dist/cli.js start --dev
# → http://localhost:7891, config ~/.kora-dev/

# With tmux fallback backend
node packages/daemon/dist/cli.js start --dev --terminal-backend tmux

# With debug logging
KORA_LOG_LEVEL=debug node packages/daemon/dist/cli.js start --dev

# Stop
node packages/daemon/dist/cli.js stop
```

## Known Issues / Pending Work

### Priority 1 — Ship Blockers
1. **npm packaging** — Need prepublish script to bundle dashboard dist into daemon for `npx kora start`
2. **Messages still file-based** — 14K+ inbox files accumulate. Should move to SQLite like tasks/events
3. **Disaster recovery** — No daemon auto-restart, no agent work checkpointing. See `DISASTER_RECOVERY.md` for full plan.
4. **Holdpty exclusive attach conflict** — sendKeys via socket fails when PtyManager holds dashboard terminal attach. PtyManager bridge routes sendKeys through existing connection as workaround.

### Priority 2 — Quality
5. **Event routing (Tier 1+2)** — Session-scoped WS filtering + event-type filtering. See `ORCHESTRATOR_EVENT_ROUTING.md`
6. **Cost tracking shows $0** — UsageMonitor code exists but doesn't parse actual token usage from CLI output
7. **Bundle size optimization** — Dashboard JS is ~1.2MB (Mantine + Monaco + xterm). Needs code-splitting.
8. **Unit tests** — 100 tests passing (vitest): worktree-mode (21), message-queue (18), MCP tools (15), terminal-stream (14), holdpty (12), spawn-performance (6), message-notification (8), playbook-config (6). Run: `npm run test -w packages/daemon`
9. **API rate limiting** — No Express rate-limiter middleware
10. **YAML playbook import** — Design complete (YAML_PLAYBOOK_DESIGN.md), not yet implemented. Needs `js-yaml` dependency.

### Priority 3 — Features
11. **VS Code extension** — Phase 4. Empty package exists at `packages/vscode-extension/`
12. **Jira/Asana integration** — External task management sync
13. **Agent templates marketplace** — Pre-built personas for common roles
14. **PM2 integration** — Process supervisor for daemon auto-restart on crash
15. **Agent auto-checkpoint** — Periodic git commit in agent worktrees to prevent code loss
16. **Multi-user support** — Single-user only, no role-based access
17. **Recent suggestions** — Autocomplete for paths/flags/models from past usage (design done, not implemented)

## Important Patterns

### Adding a new CLI provider
Create a file in `packages/daemon/src/cli-providers/` implementing the `CLIProvider` interface from `@kora/shared`. Register it in `index.ts`. The `buildCommand()` method returns `string[]` (not a shell string).

### Adding a new API endpoint
Add to `packages/daemon/src/server/api-routes.ts`. Use `broadcastEvent()` after mutations for WebSocket push. For task operations, use `getDb(sid)` to get the SQLite database instance.

### Adding a new MCP tool
1. Add tool definition to `TOOL_DEFINITIONS` array in `packages/daemon/src/mcp/agent-mcp-server.ts`
2. Add handler in the `handleToolCall` switch statement
3. Pre-approve in `packages/daemon/src/core/agent-manager.ts` `--allowedTools` list (prefix: `mcp__kora__`)
4. Document in persona builder (`packages/daemon/src/core/persona-builder.ts`)

### CSS theming
All colors must use CSS variables (no hardcoded `#hex`). Check both `[data-theme="dark"]` and `[data-theme="light"]` work. Terminal preview areas (`.agent-terminal-preview`) stay dark always.

## Codebase Stats

- **100+ source files** across 3 packages
- **~25,000 lines** of TypeScript/TSX/CSS
- **Shared**: 5 files, ~500 LOC
- **Daemon**: 45+ files, ~10,000 LOC
- **Dashboard**: 45+ files, ~14,000 LOC
- **Tests**: 100 passing (vitest)
- **New deps (Sprint 2)**: @mantine/core, @mantine/hooks, postcss-preset-mantine, postcss-simple-vars, marked, dompurify
- **New deps (Sprint 3)**: holdpty, pino, pino-pretty, pino-http

## Session History & Recovery Log

### Session: KoraDev (March 17, 2026)

**Session ID**: `koradev`
**Project Path**: `/Users/ashishranjan738/Projects/Kora`
**Mode**: Dev (port 7891, config `~/.kora-dev/`)
**Production mirror**: `/Users/ashishranjan738/Projects/Kora-prod` (port 7890, do NOT modify)

#### Agent Generations

| Generation | Agents | Outcome |
|------------|--------|---------|
| Gen 1 | architect-572da40e, frontend-6a87dd11, backend-773d8e53, tests-4d2b10fc | Completed features, tester killed daemon via `kill -HUP` |
| Gen 2 | architect-1e283bb9, frontend-3c297bf1, backend-ac4cbd92, tests-83ee63a7 | Short-lived, user removed duplicates |
| Gen 3 (final) | architect-54700bbd, frontend-c92eef9a, backend-0a84f0c2, tester-d8356aa4 | Recovered lost work, shipped 7 PRs, full E2E testing |

#### All Merged PRs

| PR | Title | Key Changes |
|----|-------|-------------|
| #1 | Frontend worktree mode + UI fixes | Worktree mode UI, task dependencies, terminal flicker fixes, typed messages, channel badges, mobile CSS |
| #2 | Backend worktree mode + MCP + messaging | WorktreeMode wiring, new MCP tools (create_task, spawn_agent, remove_agent), adaptive polling, provider-agnostic MCP, typed messages |
| #3 | Frontend CLI flags UI | CLI flags input in SpawnAgentDialog, per-agent overrides in playbook launcher, yellow flag badges |
| #4 | Backend CLI flags | Expanded allowedExtraArgs for all 5 providers, skipArgValidation bypass, extraCliArgs on PlaybookAgent |
| #7 | Unit tests | vitest setup, 54 tests: worktree-mode (21), message-queue (18), MCP tools (15) |
| #9 | Tmux session namespacing | `kora--` prefix (prod) / `kora-dev--` prefix (dev) for all Kora tmux sessions. Cleanup only kills namespaced sessions. |
| #10 | Playbook dialog redesign | Compact 2-col grid, messaging dropdown, collapsed topology, compact agent rows, +flags expand, fixed footer, scrollable |
| #11 | Full dev/prod isolation | `.kora-dev/` runtime dir, `kora-dev--` tmux prefix, MCP CLI args priority over filesystem, KORA_DEV env propagation |
| #12 | MCP server name fix | Reverted MCP config key to always "kora" (not "kora-dev") so --allowedTools matches tool names |

#### Dev/Prod Isolation (Current Architecture)

| Resource | Production | Dev Mode |
|----------|-----------|----------|
| Port | 7890 | 7891 |
| Global config | `~/.kora/` | `~/.kora-dev/` |
| Per-project runtime | `.kora/` | `.kora-dev/` |
| Tmux prefix | `kora--` | `kora-dev--` |
| MCP server key | `kora` | `kora` (same — isolation via port/token) |
| Env var | — | `KORA_DEV=1` |

#### Incident: Daemon Killed by Tester Agent

See `DISASTER_RECOVERY.md` for full post-mortem and recovery plan. Key learnings:
- Tester sent `kill -HUP` to daemon -> Node.js died (no SIGHUP handler)
- 54 unit tests lost (never committed)
- 2 feature commits recovered via `git fsck --unreachable`
- Led to: DISASTER_RECOVERY.md, tmux namespacing, full dev/prod isolation

#### Bugs Found & Fixed During Testing

1. **MCP env propagation** — MCP server read from `~/.kora/` (prod) in dev mode. Fixed: CLI args take priority over filesystem reads.
2. **MCP tool name mismatch** — Changing MCP server key to "kora-dev" broke `--allowedTools`. Fixed: always use "kora" as key.
3. **Stale dashboard cache** — Daemon caches index.html at startup. Documented as known issue; needs file watcher.

#### Key Files Created This Session
- `DISASTER_RECOVERY.md` — Disaster recovery architecture (PM2, auto-checkpoint, Litestream, SIGHUP handler, agent sandboxing)
- `CLAUDE_CONTEXT.md` — This file, full project context + session history
- `.kora/pre-restart-snapshot-20260317-122322.txt` — State snapshot before dev daemon restart

#### Current Git State

```
main branch — fully up to date with origin/main
Latest commits (after all PRs merged):
PR #12 fix: MCP server name — always use "kora"
PR #11 feat: full dev/prod isolation
PR #10 feat: playbook dialog redesign
PR #9  fix: namespace tmux sessions with kora-- prefix
       fix: resolve TypeScript errors in test files
PR #7  test: add unit tests (54 tests)
PR #6  revert tests (then re-added in #7)
PR #5  test: unit tests (reverted)
PR #4  feat: custom CLI flags backend
PR #3  feat: custom CLI flags UI
PR #2  feat: backend worktree mode + MCP + messaging
PR #1  feat: frontend worktree mode + UI
       Fix dev mode config paths
       Add comprehensive README
       Initial Kora codebase
       Initial commit
```

### Session: KaroDev Sprint 2 (March 18, 2026)

**Session ID**: `karodev`
**Project Path**: `/Users/ashishranjan738/Projects/Kora`
**Mode**: Dev (port 7891, config `~/.kora-dev/`)
**Agents**: Architect, Frontend, Backend, Tests, Researcher (5 agents)

#### PRs Merged
| PR | Title | Key Changes |
|----|-------|-------------|
| #18 | fix: terminal bugs, daemon fixes, acknowledge-based messaging | WebGL renderer, scroll settings, right-click copy, terminal rendering fix, WS event leak fix, SQLite guard, tmux stale session handling, log rotation 20s/2MB |
| #19 | feat: Mantine v8 migration + mobile responsive + UI improvements | Mantine v8 installed, Navbar→AppShell+Burger, 5 dialogs→Modal, pages responsive (768px+375px), TaskBoard redesign, markdown rendering (marked+dompurify), agent card flag redesign (Proposal B), AgentView header responsive, nudge button UI |
| #20 | feat: peek/nudge MCP tools + tmux scroll/copy settings | peek_agent + nudge_agent MCP tools, tmux mouse off, auto-copy on selection, set-clipboard, aggressive-resize, unbind right-click menu, token persistence, daemon log file, stale agent restore fix, terminal cd race fix |
| #22 | fix: P0 config fixes | Vite proxy→7891 dev, PRAGMA foreign_keys=ON, SIGHUP handler |

#### Architecture Decisions
- **UI Library**: Mantine v8 (over Shadcn/UI, Chakra, MUI, Ant Design) — best fit for existing CSS vars, PostCSS, incremental adoption
- **Markdown Renderer**: marked + DOMPurify + TypographyStylesProvider (over react-markdown — 1 dep vs 104 deps, 25KB vs 50KB)
- **Terminal Backend**: Configurable provider pattern — holdpty (default) + tmux (fallback). TerminalProvider interface with factory + CLI flag `--terminal-backend`
- **Agent Card Flags**: Proposal B — count badge + click-to-expand Popover (from AGENT_CARD_REDESIGN.md)
- **Event Routing**: 3-tier plan — session-scoped WS filtering → event-type filtering → agent-aware MCP routing (from ORCHESTRATOR_EVENT_ROUTING.md)

#### New MCP Tools
- `peek_agent(agentId, lines?)` — view another agent's terminal output (max 50 lines)
- `nudge_agent(agentId, message?)` — instant direct notification bypassing queue delays (5/min rate limit)

#### Key Bugs Found & Fixed
1. Terminal scroll skips pages → WebGL renderer + scroll settings
2. Terminal rendering garbled → delayed resize + debounced refresh
3. Right-click shows tmux menu → tmux mouse off + unbind MouseDown3Pane
4. Text selection clears on release → onSelectionChange auto-copy
5. Raw JSON WS events in terminals → tagged WS connections, broadcast skips terminals
6. SQLite "db not open" → isOpen guard + shutdown ordering
7. tmux "no current client" → graceful error catch
8. 29MB log files → rotation 60s→20s, max 5MB→2MB
9. MCP token stale after restart → token persistence (getOrCreateToken)
10. Terminal cd doesn't execute → prompt wait before sendKeys
11. Stale agent restore → verify tmux pane exists before marking alive
12. Vite proxy hits prod → changed to 7891
13. Missing PRAGMA foreign_keys → added
14. No SIGHUP handler → reload handler (don't exit)

#### Research Docs Created
- `packages/dashboard/AGENT_CARD_REDESIGN.md` — 4 proposals for flag display, Proposal B recommended
- `ORCHESTRATOR_EVENT_ROUTING.md` — 3-tier event routing + agent message delivery + guaranteed delivery
- `TMUX_ALTERNATIVES.md` — 6 options evaluated, holdpty + custom wrapper recommended
- `CONFIG_AUDIT.md` — 4 P0 + multiple P1 findings across all config files
- `MOBILE_BUGS.md` — 40 issues tracked, 30+ fixed

### Session: KaroDev Sprint 3 (March 18, 2026)

**Session ID**: `karodev`
**Project Path**: `/Users/ashishranjan738/Projects/Kora`
**Mode**: Dev (port 7891, config `~/.kora-dev/`)
**Agents**: Architect, Frontend, Backend, Tests, Researcher, Reviewer (6 agents)

#### PRs Merged
| PR | Title | Key Changes |
|----|-------|-------------|
| #23 | feat: HoldptyController + IPtyBackend interface | HoldptyController as tmux replacement, Holder.start() API, node-pty override for macOS ARM |
| #24 | fix: standalone terminal bypasses IPtyBackend | getAttachCommand() on IPtyBackend, PtyManager uses configured backend |
| #25 | fix: terminal tiles show 'Connecting...' after reload | Terminal reconnection fix |
| #26 | feat: optimistic terminal rendering | Command Center terminal tile rendering improvements |
| #28 | feat: terminal-stream ring buffer tests | 14 terminal-stream tests, TERMINAL_RING_BUFFER_LINES=100K verified |
| #29 | sprint3/frontend-fixes | Agent card v2 compact redesign, stats row, model inline display |
| #30 | fix: HoldptyController uses Node.js API | Holder.start() instead of CLI for session management |
| #31 | fix: postinstall to remove holdpty's bundled broken node-pty | npm override for node-pty compatibility |
| #32 | fix: command center fullscreen + scroll | mosaic-window-body-overlay pointer-events fix, JS wheel forwarding, CSS fullscreen via class |
| #33 | fix: fullscreen useCallback deps | fullscreenAgentId added to renderTile useCallback dependencies |

#### Architecture Decisions (Sprint 3)
- **Holdpty detached mode**: `holdpty launch --bg` spawns detached holder processes that survive daemon restart. `Holder.start()` is in-process only (dies with daemon). Metadata at `/tmp/dt-{UID}/{name}.json`, socket at `/tmp/dt-{UID}/{name}.sock`.
- **PtyManager bridge**: sendKeys routes through PtyManager's existing PTY when dashboard holds exclusive holdpty attach. Avoids exclusive attach conflict.
- **Env vars via export**: `setEnvironment()` is a no-op under holdpty. Env vars set via `sendKeys("export K=V")` after shell prompt detected.
- **Structured logging**: pino JSON logger with levels (KORA_LOG_LEVEL env), pino-http for Express, pino-pretty for dev.
- **Notifications use \r**: `literal: false` mode appends `\r` (carriage return) not `\n` for PTY Enter key.
- **Fullscreen via CSS class**: `.agent-panel-fullscreen` with `position: fixed` on the mosaic tile content div (no separate overlay component). `terminalSlideIn` animation uses opacity only (no transform).

#### Key Bugs Found & Fixed
1. sendKeys `\n` vs `\r` — PTY terminals need `\r` for Enter, not `\n`
2. Exclusive holdpty attach conflict — PtyManager bridge for sendKeys
3. Broadcast slow delivery — parallel processQueues
4. Fullscreen CSS broken by transform — removed transform from terminalSlideIn
5. mosaic-window-body-overlay blocking events — pointer-events:none (then reverted, JS wheel forwarding instead)
6. Standalone terminal bypasses IPtyBackend — getAttachCommand() added
7. holdpty Holder.start() is in-process — confirmed via source, must use --bg for persistence
8. setEnvironment no-op under holdpty — env vars stored in Map but never applied to PTY
9. Sequential restart-all — agents stopped/spawned one at a time (bottleneck)
10. capturePane under holdpty spawns subprocess per poll — ~25-50 subprocess spawns per agent

#### Research & Design Docs Created
- `YAML_PLAYBOOK_DESIGN.md` — Full YAML playbook schema, import mechanism, storage, API endpoints, dashboard UI, validation (~20 hrs implementation)
- Logging implementation plan — 65 log statements across 10 files with exact line numbers
- Holdpty detached mode implementation plan — 8 code changes with exact diffs
- Recent suggestions design — JSON file + GET /suggestions endpoint + frontend autocomplete
- Agent spawn performance analysis — full timeline, 3 bottlenecks identified
- Session persistence analysis — Holder.start() vs --bg verified empirically

#### Pending Work (Next Sprint)
1. YAML playbook import implementation (js-yaml, multi-directory discovery)
2. Holdpty detached mode migration (--bg for session persistence)
3. Parallel restart-all (Promise.all instead of sequential for-loop)
4. Socket-based capturePane (replace CLI subprocess per poll)
5. Event routing Tier 1+2 (session-scoped + event-type WS filtering)
6. Recent suggestions implementation (paths/flags/models autocomplete)
7. Bundle size optimization (code splitting for Mantine)
8. Upstream PR: holdpty non-exclusive write mode

### How to Resume Development

```bash
cd /Users/ashishranjan738/Projects/Kora

# 1. Pull latest
git pull origin main

# 2. Build everything
npm run build:shared
npx tsc -p packages/daemon/tsconfig.json
cd packages/dashboard && npm install && npm run build && cd ../..

# 3. Run tests
npm run test -w packages/daemon  # 100 tests should pass

# 4. Start dev daemon
node packages/daemon/dist/cli.js start --dev
# -> http://localhost:7891, config ~/.kora-dev/, runtime .kora-dev/

# 4b. With tmux fallback backend
node packages/daemon/dist/cli.js start --dev --terminal-backend tmux

# 5. Start prod daemon (if needed)
node packages/daemon/dist/cli.js start
# -> http://localhost:7890, config ~/.kora/, runtime .kora/

# 6. View daemon logs
make logs-dev   # tail ~/.kora-dev/daemon.log
make logs-prod  # tail ~/.kora/daemon.log

# Production copy at Kora-prod — pull latest there too:
cd /Users/ashishranjan738/Projects/Kora-prod
git pull origin main
npm run build:shared && npx tsc -p packages/daemon/tsconfig.json
cd packages/dashboard && npm install && npm run build && cd ../..
```

### Agent Rules (established this session)
1. **NEVER push directly to main** — always feature branch + PR
2. **ALWAYS rebase onto origin/main** before pushing
3. **No Co-Authored-By** lines in commit messages
4. **NEVER kill processes you didn't start** — especially the daemon
5. **Dev testing only on port 7891** — never touch 7890 (prod)
