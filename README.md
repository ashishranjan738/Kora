# Kora

**Multi-agent orchestration platform for AI coding agents.**

Kora lets you run multiple AI coding agents simultaneously on the same project — Claude Code, Codex, Aider, Kiro, Goose — with a browser-based dashboard for real-time monitoring, inter-agent communication, task management, and full terminal access.

Think of it as a mission control for your AI coding team.

```bash
make install && make build && make prod
# → http://localhost:7890
```

---

## Why Kora?

Most AI coding tools run a single agent at a time. Real software projects need **specialists working in parallel** — an architect planning, a frontend dev building UI, a backend dev writing APIs, a tester verifying, and a reviewer catching bugs. Kora makes this possible.

**Before Kora**: You manually switch between terminal windows, copy-paste context between agents, and hope they don't step on each other's code.

**With Kora**: Agents communicate via MCP tools, work in isolated git worktrees, and you monitor everything from a single dashboard.

---

## Features

### Agent Management
- **Multi-CLI support** — Claude Code, Codex, Aider, Kiro, Goose (pluggable provider system)
- **Any model** — Use whatever model your CLI supports. No model validation — pass through freely
- **Git worktree isolation** — Each agent gets its own worktree. No merge conflicts during work
- **Automatic worktree cleanup** — Stale worktrees and branches pruned on agent stop, session delete, and daemon startup
- **Session persistence** — Agents survive daemon restarts via tmux. Pick up where you left off
- **Playbook templates** — Pre-configured team topologies (Full Stack Team, Master + Workers, Solo Agent)
- **Skill-aware auto-assign** — Idle agents automatically assigned matching tasks based on persona and labels
- **Activity detection** — Spinner pattern recognition, idle/working classification, frozen timestamp detection
- **Cost tracking** — Token usage and cost parsed from CLI output including spinner indicators

### Inter-Agent Communication
- **MCP Tools (primary)** — Agents use `send_message`, `check_messages`, `list_agents`, `broadcast` natively
- **Terminal @mentions (fallback)** — `@AgentName: message` auto-relayed between terminals
- **Rate limiting** — Role-based limits (master: 25/min, worker: 10/min) + conversation loop detection
- **Broadcast persistence** — Long broadcasts (500+ chars) stored in SQLite, retrievable via `check_messages`
- **File + SQLite dual storage** — Messages persisted to both inbox files and SQLite for reliability
- **Nudge system** — Dashboard button to remind agents about unread messages with Enter key delivery

### Task Management
- **Kanban board** — Drag-and-drop tasks between Pending, In Progress, Review, Done
- **Configurable workflow** — Custom pipeline states with enforced transitions and skippable stages
- **Approval gates** — Require human sign-off before tasks enter specific states
- **Agent assignment** — Assign tasks to agents, they get notified via MCP
- **Comments** — Both users and agents can post updates on tasks
- **MCP task tools** — Agents see tasks via `list_tasks` and post progress via `update_task`
- **Cycle time analytics** — Track time per state, rework count, rolling averages, cumulative flow
- **Stale task watchdog** — Auto-nudge agents and escalate when tasks stall
- **SQLite storage** — Concurrent-safe, indexed, scales to thousands of tasks

### Dashboard
- **Command Center** — VS Code-style mosaic tiling with free-form resize (react-mosaic)
- **Agent hover panel** — HoverCard with full agent details, activity, and current task
- **Live terminals** — xterm.js + node-pty streaming with full interactive input
- **Monaco editor** — File editing with tabs, Ctrl+S save, Ctrl+P quick file search
- **Side-by-side diff** — Monaco DiffEditor for git changes with nested repo support
- **Event timeline** — Rich event log with expandable details and filtering
- **Theme system** — Dark/Light/System + independently configurable editor and terminal themes
- **Activity detection** — Real-time agent status via terminal text-flow analysis
- **Session maintenance** — Stale resource cleanup UI (worktrees, branches, tmux sessions)

### Security
- **Bearer token auth** — Generated on daemon start, required for all API calls
- **Shell injection protection** — All terminal commands use shell-escaped paths
- **Webhook HMAC verification** — Timing-safe signature validation, signatures required
- **MCP role permissions** — Deny-by-default for unknown roles, master/worker tool separation
- **Path traversal protection** — Image sharing and file access confined to project directory
- **SQL injection prevention** — Parameterized queries with LIKE wildcard escaping

### Architecture
- **Daemon** — Node.js Express + WebSocket server with bearer token auth
- **SQLite** — Events, tasks, messages, and comments stored in `better-sqlite3` (WAL mode, indexed)
- **tmux / holdpty** — Process isolation, session persistence, terminal capture with macOS sleep recovery
- **MCP server** — Per-agent JSON-RPC server for messaging and task tools
- **WebSocket push** — Instant UI updates on agent/task state changes
- **Configurable workflows** — Pipeline enforcement with transitions, approval gates, and skip states

---

## How It Compares

| Feature | Kora | Claude Squad | Roo Code | CrewAI | AutoGen | Cursor |
|---------|------|-------------|----------|--------|---------|--------|
| Multi-agent parallel execution | Yes | Yes | No | Yes | Yes | No |
| Browser dashboard | Yes | No (TUI) | VS Code only | No | No | No |
| CLI-agnostic (any agent) | Yes | Claude only | Roo only | Python only | Python only | Built-in |
| Real terminal access | Yes | Yes | No | No | No | No |
| Inter-agent MCP messaging | Yes | No | No | Custom | Custom | No |
| Git worktree isolation | Yes | Yes | No | No | No | No |
| Task board with comments | Yes | No | No | No | No | No |
| Monaco editor + diff viewer | Yes | No | VS Code | No | No | Yes |
| Session persistence | Yes | Yes | No | No | No | No |
| SQLite storage | Yes | No | No | No | No | No |
| Theme system (dark/light) | Yes | No | VS Code | No | No | Yes |
| Open source | Yes | Yes | Yes | Yes | Yes | No |

---

## Quick Start

### Prerequisites
- **Node.js** 20+
- **tmux** — `brew install tmux` (macOS) or `apt install tmux` (Linux)
- At least one AI coding CLI installed (e.g., `claude` for Claude Code)

### Install & Run

```bash
git clone https://github.com/AshishRanjan738/Kora.git
cd Kora
make install  # npm install
make build    # build shared → daemon → dashboard
make prod     # start on http://localhost:7890
```

Or without Make:

```bash
npm install
npm run build:shared && npx tsc -p packages/daemon/tsconfig.json
cd packages/dashboard && npm run build && cd ../..
node packages/daemon/dist/cli.js start
```

Open `http://localhost:7890` in your browser.

### Create Your First Session

1. Click **"From Playbook"** on the home page
2. Select **"Master + 2 Workers"** — an orchestrator + 2 coding agents
3. Enter your project path and click **"Launch 3 Agents"**
4. Watch agents initialize in the **Command Center**

### Production Mode (PM2)

For production, use PM2 for automatic restart on crash, log management, and system startup:

```bash
npm install -g pm2           # Install PM2 globally (one-time)
make build                   # Build all packages
kora start --pm2             # Start daemon under PM2
kora start --pm2 --startup   # + auto-start on boot (launchd/systemd)
```

PM2 commands:

```bash
pm2 status kora-daemon       # Check daemon status
pm2 logs kora-daemon         # View daemon logs
pm2 restart kora-daemon      # Restart daemon
kora stop --pm2              # Stop daemon and remove from PM2
```

### Dev Mode

```bash
make dev      # build + start on port 7891 (foreground)
make dev-bg   # same but in background
```

Dev mode uses completely isolated resources (`~/.kora-dev/`, port 7891, separate tmux prefix) so you can run dev and prod side by side.

---

## Make Commands

Run `make help` to see all commands. Here's the full list:

### Build

| Command | Description |
|---------|-------------|
| `make build` | Build all packages (shared → daemon → dashboard) |
| `make build-shared` | Build shared types only |
| `make build-daemon` | Build daemon (auto-builds shared first) |
| `make build-dashboard` | Build dashboard only |

### Dev (port 7891)

| Command | Description |
|---------|-------------|
| `make dev` | Build and start dev daemon (foreground) |
| `make dev-bg` | Build and start dev daemon in background |
| `make stop-dev` | Stop dev daemon |
| `make restart-dev` | Rebuild and restart dev daemon |

### Prod (port 7890)

| Command | Description |
|---------|-------------|
| `make prod` | Build and start prod daemon (foreground) |
| `make prod-bg` | Build and start prod daemon in background |
| `make stop-prod` | Stop prod daemon |
| `make restart-prod` | Rebuild and restart prod daemon |

### Quality

| Command | Description |
|---------|-------------|
| `make test` | Run all tests (1800+ vitest tests, 99%+ pass rate) |
| `make test-watch` | Run tests in watch mode |
| `make typecheck` | Type-check daemon + dashboard |
| `make lint` | Lint all source files |
| `make check` | Run all checks (typecheck + test + lint) |

### Clean

| Command | Description |
|---------|-------------|
| `make clean` | Remove build artifacts (`dist/` dirs) |
| `make clean-dev` | Stop dev daemon + remove `~/.kora-dev/` runtime files |
| `make clean-prod` | Stop prod daemon + remove `~/.kora/` runtime files |
| `make clean-modules` | Remove all `node_modules/` |
| `make clean-all` | Full nuclear cleanup: stop daemons, remove builds + modules + runtime |

### Other

| Command | Description |
|---------|-------------|
| `make install` | Install all dependencies |
| `make fresh` | Full clean → install → build (start from scratch) |
| `make status` | Show running daemons and their sessions |

---

## Architecture

```
Browser (React Dashboard)
    |
    |-- HTTP API (Express 5)
    |-- WebSocket (real-time events + terminal streaming)
    |
Kora Daemon (Node.js)
    |
    |-- Orchestrator (per session)
    |   |-- AgentManager — spawn, stop, restore agents
    |   |-- MessageQueue — rate-limited delivery with prompt detection
    |   |-- EventLog -> SQLite
    |   |-- TaskManager -> SQLite
    |   |-- PersonaBuilder — team awareness + communication protocol
    |   |-- AutoRelay — @mention detection in terminal output
    |
    |-- Per Agent:
    |   |-- tmux session (process isolation)
    |   |-- node-pty (terminal streaming)
    |   |-- git worktree (code isolation)
    |   |-- MCP server (messaging + task tools)
    |   |-- Log rotation (5MB cap)
    |
    |-- SQLite Database
        |-- events (indexed by session + timestamp)
        |-- tasks (with status, assignment)
        |-- task_comments (with author tracking)
```

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KORA_CONFIG_DIR` | Custom global config directory | `~/.kora` |
| `KORA_DEV` | Enable dev mode (`1`) | unset |

### CLI Flags

```
kora start [--port PORT] [--project PATH] [--dev]
kora stop
kora status
```

### Settings (Dashboard)

- **Appearance** — System / Dark / Light
- **Editor Theme** — Auto / Dark / Light / High Contrast
- **Terminal Theme** — Auto / Dark / Light

---

## MCP Tools (Available to Agents)

Agents automatically get these tools via `--mcp-config`:

| Tool | Description |
|------|-------------|
| `send_message(to, message)` | Send a message to another agent |
| `check_messages()` | Check for unread messages |
| `list_agents()` | See all agents with status, activity, and current task |
| `broadcast(message)` | Message all agents (persisted for 500+ chars) |
| `list_tasks()` | See assigned and unassigned tasks |
| `update_task(taskId, status?, comment?)` | Update task status or post progress |
| `create_task(title, description)` | Create a new task on the board |
| `get_task(taskId)` | Get full task details with comments |
| `request_task()` | Request assignment of next available task |
| `report_idle()` | Signal availability for new work |
| `prepare_pr()` | Prepare a pull request for review |
| `get_workflow_states()` | See pipeline states and valid transitions |
| `save_knowledge(key, value)` | Store knowledge for other agents |
| `verify_work()` | Validate changes (build + tests pass) |

---

## API

All endpoints require `Authorization: Bearer <token>` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/status` | Daemon status |
| GET | `/api/v1/sessions` | List sessions |
| POST | `/api/v1/sessions` | Create session |
| DELETE | `/api/v1/sessions/:sid` | Stop session |
| POST | `/api/v1/sessions/:sid/agents` | Spawn agent |
| DELETE | `/api/v1/sessions/:sid/agents/:aid` | Remove agent |
| POST | `/api/v1/sessions/:sid/relay` | Send message between agents |
| POST | `/api/v1/sessions/:sid/broadcast` | Broadcast to all agents |
| GET | `/api/v1/sessions/:sid/tasks` | List tasks |
| POST | `/api/v1/sessions/:sid/tasks` | Create task |
| PUT | `/api/v1/sessions/:sid/tasks/:tid` | Update task |
| POST | `/api/v1/sessions/:sid/tasks/:tid/comments` | Add comment |
| GET | `/api/v1/sessions/:sid/events` | Query events |
| GET | `/api/v1/sessions/:sid/git/status` | Git status (nested repos) |
| GET | `/api/v1/sessions/:sid/git/diff` | Side-by-side diff |

---

## Contributing

```bash
git clone https://github.com/AshishRanjan738/Kora.git
cd Kora
make install && make build

# Start dev daemon (port 7891, isolated from prod)
make dev-bg

# Check everything is running
make status

# Run tests before pushing
make check
```

For active development with auto-rebuild:

```bash
# Terminal 1: daemon with auto-rebuild
cd packages/daemon && npx tsc -w

# Terminal 2: dashboard with hot reload
cd packages/dashboard && npm run dev
```

---

## License

MIT
