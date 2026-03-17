# Kora — Quick Start Guide

## Prerequisites

```bash
# Node.js 20+ required
node --version

# tmux required
brew install tmux    # macOS
# apt install tmux   # Linux

# At least one AI coding CLI
claude --version     # Claude Code
# codex --version    # Codex
# aider --version    # Aider
```

## Install

```bash
git clone https://github.com/AshishRanjan738/Kora.git
cd Kora
npm install
```

## Build

```bash
# Build shared types first (required)
npm run build:shared

# Build daemon
npx tsc -p packages/daemon/tsconfig.json

# Build dashboard
cd packages/dashboard && npm run build && cd ../..
```

> If you see "Cannot find module '@kora/shared'" errors, delete `packages/shared/tsconfig.tsbuildinfo` and rebuild shared.

---

## Running in Production Mode

```bash
node packages/daemon/dist/cli.js start
```

Output:
```
Kora daemon running on http://localhost:7890
Auth token: bab17656... (saved to ~/.kora/)
```

| Setting | Value |
|---------|-------|
| **URL** | http://localhost:7890 |
| **Port** | 7890 (default) |
| **Config dir** | `~/.kora/` |
| **Project data** | `{project}/.kora/` |
| **Database** | `{project}/.kora/data.db` |

### Custom port

```bash
node packages/daemon/dist/cli.js start --port 8080
```

### Stop

```bash
node packages/daemon/dist/cli.js stop
```

---

## Running in Dev Mode

Dev mode runs a completely isolated instance — different port, config, and token. Use this when developing Kora itself, so your dev instance doesn't interfere with production.

```bash
node packages/daemon/dist/cli.js start --dev
```

Output:
```
  [dev mode] Config: ~/.kora-dev/ | Port: 7891
Kora daemon running on http://localhost:7891
Auth token: a365f70a... (saved to ~/.kora-dev/)
```

| Setting | Value |
|---------|-------|
| **URL** | http://localhost:7891 |
| **Port** | 7891 (default dev port) |
| **Config dir** | `~/.kora-dev/` |
| **Token** | Separate from production |
| **Sessions** | Separate from production |

### Run both simultaneously

```bash
# Terminal 1 — Production
node packages/daemon/dist/cli.js start
# → http://localhost:7890

# Terminal 2 — Dev
node packages/daemon/dist/cli.js start --dev
# → http://localhost:7891
```

Both instances have completely separate:
- Auth tokens (different `daemon.token` files)
- Session registries
- Playbook templates
- Agent MCP configs (agents find the right daemon automatically via `KORA_DEV` env)

### Environment variables

You can also control the config directory directly:

```bash
# Custom config directory
KORA_CONFIG_DIR=/tmp/kora-test node packages/daemon/dist/cli.js start

# Enable dev mode via env
KORA_DEV=1 node packages/daemon/dist/cli.js start
```

---

## Dashboard Development (Hot Reload)

For iterating on the dashboard UI without rebuilding:

```bash
# Start the daemon (dev mode recommended)
node packages/daemon/dist/cli.js start --dev

# In another terminal, start Vite dev server
cd packages/dashboard
npm run dev
# → http://localhost:5173 (hot reload, proxies API to daemon)
```

---

## Creating Your First Session

1. Open the dashboard in your browser (http://localhost:7890 or :7891)
2. Click **"From Playbook"**
3. Select **"Master + 2 Workers"**
4. Enter your project path (e.g., `/Users/you/Projects/my-app`)
5. Click **"Launch 3 Agents"**
6. Switch to the **Command Center** to see all agents in a mosaic layout

---

## File Layout

```
~/.kora/                           # Global config (production)
  ├── daemon.pid
  ├── daemon.port                  # 7890
  ├── daemon.token                 # Bearer token
  ├── sessions.json                # Session registry
  └── playbooks/                   # Built-in playbooks

~/.kora-dev/                       # Global config (dev mode)
  ├── daemon.pid
  ├── daemon.port                  # 7891
  ├── daemon.token                 # Different token
  └── ...

{project}/.kora/                   # Per-project runtime data
  ├── data.db                      # SQLite (events, tasks, comments)
  ├── agents.json                  # Persisted agent state
  ├── session.json                 # Session config
  ├── messages/                    # MCP message inboxes
  ├── worktrees/                   # Git worktrees per agent
  ├── mcp/                         # MCP server configs
  ├── personas/                    # Agent system prompts
  └── {agentId}.log               # Terminal logs (auto-rotated at 5MB)
```

---

## Troubleshooting

**"Cannot find module '@kora/shared'"**
```bash
rm packages/shared/tsconfig.tsbuildinfo
npm run build:shared
```

**"tmux is not installed"**
```bash
brew install tmux    # macOS
apt install tmux     # Linux
```

**Agent won't start / stays at shell prompt**
The agent needs a few seconds for the shell to initialize. If it's stuck, check the tmux session directly:
```bash
tmux list-sessions
tmux attach -t <session-name>
```

**Port already in use**
```bash
node packages/daemon/dist/cli.js stop
# Or kill manually:
kill $(cat ~/.kora/daemon.pid)
```

**"Disconnected" in dashboard after daemon restart**
Hard refresh the browser (Cmd+Shift+R) to pick up the new auth token.
