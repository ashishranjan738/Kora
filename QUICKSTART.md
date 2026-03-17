# Agent Orchestrator — Quick Start Guide

## Prerequisites

```bash
# 1. tmux (required — agents run in tmux sessions)
brew install tmux

# 2. At least one AI coding CLI. Pick any:
brew install --cask claude-code        # Claude Code (recommended)
# npm install -g @openai/codex         # OpenAI Codex CLI
# pip install aider-chat                # Aider
```

## Build

```bash
cd /Users/ashishranjan738/Projects/AgentOrchestratorExtension

# Install dependencies (first time only)
npm install

# Build shared types
npm run build:shared

# Build daemon
npx tsc -p packages/daemon/tsconfig.json

# Build dashboard
cd packages/dashboard && npm run build && cd ../..
```

## Start

```bash
# Start the daemon (serves API + dashboard)
node packages/daemon/dist/cli.js start

# You'll see:
#   Agent Orchestrator daemon running on http://localhost:7890
#   Auth token: abc123... (saved to ~/.agent-orchestrator/)
```

Open **http://localhost:7890** in your browser.

## Use the Dashboard

### 1. Create a Session

- Click **"Create From Scratch"**
- Enter a session name (e.g., `my-app`)
- Enter the full path to your project folder (e.g., `/Users/you/projects/my-app`)
- Click **Create**

Or click **"From Playbook"** to launch a pre-configured team:
- **Solo Agent** — single master agent
- **Master + 2 Workers** — orchestrator with two coding workers
- **Full Stack Team** — architect + frontend + backend + test agents

### 2. Spawn an Agent

- Click **"+ Add Agent"**
- Fill in:
  - **Name**: e.g., "Master" or "Frontend Worker"
  - **Role**: Master (orchestrator) or Worker
  - **Provider**: Claude Code, Codex, Aider, Kiro, or Goose
  - **Model**: picks available models for the chosen provider
  - **Persona** (optional): system instructions for the agent
  - **Initial Task** (optional): first message sent after spawning
- Click **"Spawn Agent"**

The agent will appear as a card with a **live terminal preview** showing the CLI running.

### 3. Interact with Agents

- **Mini terminal**: each agent card shows live output
- **Full terminal**: click **"Open Terminal"** for a two-column view with xterm.js
- **Send message**: click **"Send Message"** on an agent card, or use the chat box in the terminal view
- **Change model**: click **"Change Model"** on an agent
- **Remove agent**: click **"Remove"** (with confirmation)

### 4. View Activity

- **Agents tab**: agent cards with status, cost, terminal preview
- **Tasks tab**: kanban board (Pending → In Progress → Review → Done)
- **Timeline tab**: event log with color-coded badges

### 5. Session Controls

- **Pause Session**: pauses all agents
- **Stop Session**: stops all agents and removes the session
- **+ Add Agent**: spawn more agents at any time

## Use the CLI

```bash
# Start daemon on custom port
node packages/daemon/dist/cli.js start --port 8080

# Start with auto-created session
node packages/daemon/dist/cli.js start --project /path/to/your/project

# Check daemon status
node packages/daemon/dist/cli.js status

# Stop daemon
node packages/daemon/dist/cli.js stop
```

## Use the REST API (curl)

```bash
TOKEN=$(cat ~/.agent-orchestrator/daemon.token)

# List sessions
curl -H "Authorization: Bearer $TOKEN" http://localhost:7890/api/v1/sessions

# Create session
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"my-app","projectPath":"/path/to/my-app"}' \
  http://localhost:7890/api/v1/sessions

# Spawn agent
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Master","role":"master","model":"claude-sonnet-4-6","persona":"You are a helpful assistant.","initialTask":"List files in this directory"}' \
  http://localhost:7890/api/v1/sessions/my-app/agents

# List agents in session
curl -H "Authorization: Bearer $TOKEN" http://localhost:7890/api/v1/sessions/my-app/agents

# Send message to agent
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"Implement a login page with React"}' \
  http://localhost:7890/api/v1/sessions/my-app/agents/{AGENT_ID}/message

# Get agent terminal output
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:7890/api/v1/sessions/my-app/agents/{AGENT_ID}/output?lines=50

# View events
curl -H "Authorization: Bearer $TOKEN" http://localhost:7890/api/v1/sessions/my-app/events

# List playbooks
curl -H "Authorization: Bearer $TOKEN" http://localhost:7890/api/v1/playbooks

# List providers and models
curl -H "Authorization: Bearer $TOKEN" http://localhost:7890/api/v1/providers

# Remove an agent
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:7890/api/v1/sessions/my-app/agents/{AGENT_ID}

# Stop session
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:7890/api/v1/sessions/my-app

# Stop daemon
node packages/daemon/dist/cli.js stop
```

## Project Structure

```
packages/
  shared/       → TypeScript types, API contracts, constants
  daemon/       → Node.js daemon (Express + WebSocket + tmux + orchestrator)
  dashboard/    → React dashboard (Vite + xterm.js + Zustand)
```

## Supported CLI Providers

| Provider | CLI Command | Models |
|----------|-------------|--------|
| Claude Code | `claude` | opus-4-6, sonnet-4-6, haiku-4-5 |
| OpenAI Codex | `codex` | o4-mini, o3, gpt-4.1 |
| Aider | `aider` | claude-sonnet-4-6, gpt-4.1, deepseek |
| Kiro | `kiro` | kiro-default |
| Goose | `goose` | goose-default |

## Tips

- Agents run in tmux sessions. You can attach directly: `tmux attach -t {session-name}`
- Each agent gets its own git worktree (for git repos) to avoid file conflicts
- The dashboard auto-refreshes every 3-5 seconds
- Bearer token is auto-injected into the dashboard — no manual auth needed
- Events are logged to `{project}/.agent-orchestrator/events/` as daily JSONL files
- Session config persists in `~/.agent-orchestrator/sessions.json`
