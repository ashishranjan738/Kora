# Kora

**Multi-agent orchestration platform for AI coding agents.**

Kora lets you run multiple AI coding agents simultaneously on the same project — Claude Code, Codex, Aider, Kiro, Goose — with a browser-based dashboard for real-time monitoring, inter-agent communication, task management, and full terminal access.

Think of it as a mission control for your AI coding team.

```bash
npm install && npm run build:shared
npx tsc -p packages/daemon/tsconfig.json
cd packages/dashboard && npm run build && cd ../..
node packages/daemon/dist/cli.js start
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
- **Session persistence** — Agents survive daemon restarts via tmux. Pick up where you left off
- **Playbook templates** — Pre-configured team topologies (Full Stack Team, Master + Workers, Solo Agent)

### Inter-Agent Communication
- **MCP Tools (primary)** — Agents use `send_message`, `check_messages`, `list_agents`, `broadcast` natively
- **Terminal @mentions (fallback)** — `@AgentName: message` auto-relayed between terminals
- **Rate limiting** — Prevents message loops (10 msgs/min per agent, 8 per conversation pair)
- **File-based delivery** — Messages written to inbox files, supports 30K+ char messages

### Task Management
- **Kanban board** — Drag-and-drop tasks between Pending, In Progress, Review, Done
- **Agent assignment** — Assign tasks to agents, they get notified via MCP
- **Comments** — Both users and agents can post updates on tasks
- **MCP task tools** — Agents see tasks via `list_tasks` and post progress via `update_task`
- **SQLite storage** — Concurrent-safe, indexed, scales to thousands of tasks

### Dashboard
- **Command Center** — VS Code-style mosaic tiling with free-form resize (react-mosaic)
- **Live terminals** — xterm.js + node-pty streaming with full interactive input
- **Monaco editor** — File editing with tabs, Ctrl+S save, Ctrl+P quick file search
- **Side-by-side diff** — Monaco DiffEditor for git changes with nested repo support
- **Event timeline** — Rich event log with expandable details and filtering
- **Theme system** — Dark/Light/System + independently configurable editor and terminal themes
- **Activity detection** — Real-time agent status via terminal text-flow analysis

### Architecture
- **Daemon** — Node.js Express + WebSocket server with bearer token auth
- **SQLite** — Events, tasks, and comments stored in `better-sqlite3` (WAL mode, indexed)
- **tmux** — Process isolation, session persistence, terminal capture
- **MCP server** — Per-agent JSON-RPC server for messaging and task tools
- **WebSocket push** — Instant UI updates on agent/task state changes

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
npm install

# Build
npm run build:shared && npx tsc -p packages/daemon/tsconfig.json
cd packages/dashboard && npm run build && cd ../..

# Start
node packages/daemon/dist/cli.js start
# → Kora daemon running on http://localhost:7890
```

Open `http://localhost:7890` in your browser.

### Create Your First Session

1. Click **"From Playbook"** on the home page
2. Select **"Master + 2 Workers"** — an orchestrator + 2 coding agents
3. Enter your project path and click **"Launch 3 Agents"**
4. Watch agents initialize in the **Command Center**

### Dev Mode

```bash
# Run a separate dev instance on port 7891
node packages/daemon/dist/cli.js start --dev
# → Config: ~/.kora-dev/ | Port: 7891
```

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
| `list_agents()` | See all agents and their status |
| `broadcast(message)` | Message all agents |
| `list_tasks()` | See assigned and unassigned tasks |
| `update_task(taskId, status?, comment?)` | Update task status or post progress |

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
npm install
npm run build:shared

# Daemon (with auto-rebuild)
cd packages/daemon && npx tsc -w &

# Dashboard (hot reload)
cd packages/dashboard && npm run dev

# Or run in dev mode (port 7891, separate config)
node packages/daemon/dist/cli.js start --dev
```

---

## License

MIT
