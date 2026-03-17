# Backend API Endpoints Summary

## Base URL
- API: `http://localhost:7890/api/v1`
- WebSocket: `ws://localhost:7890/terminal/{sessionId}/{agentId}`

## Authentication
All API endpoints require Bearer token authentication:
```
Authorization: Bearer {TOKEN}
```
Token is read from `~/.agent-orchestrator/daemon.token` and auto-injected into the dashboard via `window.__AO_TOKEN__`.

---

## 1. Status Endpoints

### GET /api/v1/status
Get daemon health and statistics.

**Response:** `DaemonStatusResponse`
```json
{
  "alive": true,
  "version": "1.0.0",
  "apiVersion": "v1",
  "uptime": 3600,
  "activeSessions": 2,
  "activeAgents": 5
}
```

---

## 2. Session Endpoints

### GET /api/v1/sessions
List all sessions.

**Response:**
```json
{
  "sessions": [
    {
      "id": "session-123",
      "name": "my-app",
      "projectPath": "/path/to/project",
      "defaultProvider": "claude-code",
      "status": "active",
      "agentCount": 3,
      "activeAgentCount": 2,
      "crashedAgentCount": 0,
      "stoppedAgentCount": 1,
      "totalCostUsd": 0.45,
      "agentSummaries": [...]
    }
  ]
}
```

### POST /api/v1/sessions
Create a new session.

**Request:** `CreateSessionRequest`
```json
{
  "name": "my-app",
  "projectPath": "/Users/me/projects/my-app",
  "defaultProvider": "claude-code"
}
```

**Response:** `SessionResponse` (201 Created)

### GET /api/v1/sessions/:sid
Get a specific session by ID.

**Response:** `SessionResponse`

### PUT /api/v1/sessions/:sid
Update session configuration.

**Request:** `UpdateSessionRequest`
```json
{
  "name": "new-name",
  "defaultProvider": "aider"
}
```

**Response:** `SessionResponse`

### DELETE /api/v1/sessions/:sid
Stop and delete a session (stops all agents).

**Response:** 204 No Content

### POST /api/v1/sessions/:sid/pause
Pause a session (pauses all agents).

**Response:**
```json
{ "status": "paused" }
```

### POST /api/v1/sessions/:sid/resume
Resume a paused session.

**Response:**
```json
{ "status": "active" }
```

---

## 3. Agent Endpoints

### GET /api/v1/sessions/:sid/agents
List all agents in a session.

**Response:**
```json
{
  "agents": [
    {
      "id": "agent-abc",
      "sessionId": "session-123",
      "config": {
        "name": "Master",
        "role": "master",
        "cliProvider": "claude-code",
        "model": "claude-sonnet-4-6",
        "persona": "...",
        "tmuxSession": "ao-session-123-agent-abc"
      },
      "status": "running",
      "currentTask": "Implement login page",
      "cost": {
        "totalTokensIn": 5000,
        "totalTokensOut": 2000,
        "totalCostUsd": 0.15
      }
    }
  ]
}
```

### POST /api/v1/sessions/:sid/agents
Spawn a new agent in the session.

**Request:** `SpawnAgentRequest`
```json
{
  "name": "Frontend Worker",
  "role": "worker",
  "cliProvider": "claude-code",
  "model": "claude-sonnet-4-6",
  "persona": "You are a React specialist...",
  "autonomyLevel": 2,
  "initialTask": "Create a login component",
  "workingDirectory": "/path/to/project",
  "extraCliArgs": [],
  "envVars": {}
}
```

**Response:** `AgentState` (201 Created)

### GET /api/v1/sessions/:sid/agents/:aid
Get a specific agent's state.

**Response:** `AgentState`

### DELETE /api/v1/sessions/:sid/agents/:aid
Stop and remove an agent.

**Response:** 204 No Content

### POST /api/v1/sessions/:sid/agents/:aid/restart
Restart a crashed/stopped agent with fresh state.

**Response:** `AgentState` (201 Created)

### POST /api/v1/sessions/:sid/agents/:aid/replace
Replace an agent with a new instance, optionally preserving terminal context.

**Request:**
```json
{
  "contextLines": 50,
  "extraContext": "The agent was working on login feature",
  "freshStart": false
}
```

**Response:** `AgentState` (201 Created)

### POST /api/v1/sessions/:sid/agents/:aid/message
Send a message to a specific agent.

**Request:** `SendMessageRequest`
```json
{
  "message": "Please implement the login form"
}
```

**Response:**
```json
{
  "sent": true,
  "message": "Please implement the login form"
}
```

### POST /api/v1/sessions/:sid/broadcast
Broadcast a message to all running agents in a session.

**Request:** `SendMessageRequest`
```json
{
  "message": "Project deadline is tomorrow"
}
```

**Response:**
```json
{
  "broadcast": true,
  "message": "Project deadline is tomorrow",
  "sentTo": 3,
  "results": [
    { "agentId": "agent-1", "name": "Master", "sent": true },
    { "agentId": "agent-2", "name": "Worker A", "sent": true },
    { "agentId": "agent-3", "name": "Worker B", "sent": true }
  ]
}
```

### POST /api/v1/sessions/:sid/relay
Relay a message from one agent to another (inter-agent communication).

**Request:**
```json
{
  "from": "agent-1",
  "to": "agent-2",
  "message": "Please review my code"
}
```

**Response:**
```json
{
  "relayed": true,
  "from": "agent-1",
  "to": "agent-2"
}
```

### GET /api/v1/sessions/:sid/agents/:aid/terminal-url
Get the WebSocket URL for terminal streaming.

**Response:**
```json
{
  "url": "/terminal/session-123/agent-abc"
}
```

### GET /api/v1/sessions/:sid/agents/:aid/output?lines=100
Get terminal output (tmux capture-pane).

**Query Params:**
- `lines`: Number of lines to capture (default: 100)

**Response:**
```json
{
  "output": [
    "user@host:~/project$ ls",
    "file1.js  file2.js  package.json",
    "user@host:~/project$ "
  ]
}
```

### POST /api/v1/sessions/:sid/agents/:aid/model
Change the model an agent is using (hot-swap).

**Request:** `ChangeModelRequest`
```json
{
  "model": "claude-opus-4-6"
}
```

**Response:**
```json
{
  "model": "claude-opus-4-6"
}
```

### POST /api/v1/sessions/:sid/agents/:aid/pause
Pause an individual agent.

**Response:**
```json
{ "status": "waiting" }
```

### POST /api/v1/sessions/:sid/agents/:aid/resume
Resume a paused agent.

**Response:**
```json
{ "status": "running" }
```

---

## 4. Task Endpoints (Stubs)

### GET /api/v1/sessions/:sid/tasks
List tasks (currently returns empty array).

**Response:**
```json
{ "tasks": [] }
```

### POST /api/v1/sessions/:sid/tasks
Create a task (stub - not fully implemented).

**Request:** `CreateTaskRequest`
```json
{
  "title": "Implement login page",
  "description": "Create a React login component",
  "assignedTo": "agent-abc"
}
```

### PUT /api/v1/sessions/:sid/tasks/:tid
Update a task (stub).

**Request:** `UpdateTaskRequest`

---

## 5. Event Endpoints

### GET /api/v1/sessions/:sid/events
Query historical events from the event log.

**Query Params:**
- `since`: ISO 8601 timestamp (e.g., "2026-03-15T10:00:00Z")
- `limit`: Max events to return (default: 100, max: 1000)
- `type`: Filter by event type (e.g., "agent-spawned", "agent-crashed")

**Response:**
```json
{
  "events": [
    {
      "id": "evt-123",
      "sessionId": "session-123",
      "type": "agent-spawned",
      "timestamp": "2026-03-15T10:30:00Z",
      "data": {
        "agentId": "agent-abc",
        "name": "Master",
        "role": "master"
      }
    }
  ]
}
```

**Event Types:**
- `agent-spawned`
- `agent-removed`
- `agent-status-changed`
- `agent-crashed`
- `agent-restarted`
- `message-sent`
- `message-received`
- `task-created`
- `task-updated`
- `user-interaction`
- `session-created`
- `session-paused`
- `session-resumed`
- `session-stopped`
- `cost-threshold-reached`

---

## 6. Provider Endpoints

### GET /api/v1/providers
List all available CLI providers and their models.

**Response:**
```json
{
  "providers": [
    {
      "id": "claude-code",
      "displayName": "Claude Code",
      "models": [
        {
          "id": "claude-opus-4-6",
          "label": "Claude Opus 4.6",
          "tier": "premium"
        },
        {
          "id": "claude-sonnet-4-6",
          "label": "Claude Sonnet 4.6",
          "tier": "balanced"
        }
      ],
      "supportsHotModelSwap": true
    }
  ]
}
```

### GET /api/v1/providers/:pid/models?sessionId=xxx
Get models for a specific provider, including custom models if sessionId is provided.

**Response:**
```json
{
  "models": [
    {
      "id": "claude-sonnet-4-6",
      "label": "Claude Sonnet 4.6",
      "tier": "balanced",
      "custom": false
    },
    {
      "id": "ft:gpt-4o:my-org:custom:abc123",
      "label": "My Fine-tuned Model",
      "tier": "balanced",
      "custom": true
    }
  ]
}
```

### GET /api/v1/providers/:pid/discover
Discover available models by querying the CLI (e.g., via API calls).

**Response:**
```json
{
  "discoveredModels": ["model-1", "model-2"],
  "builtInModels": [...]
}
```

---

## 7. Session Custom Model Endpoints

### POST /api/v1/sessions/:sid/models
Add a custom model to a session.

**Request:**
```json
{
  "id": "ft:gpt-4o:my-org:custom:abc123",
  "label": "My Fine-tuned GPT-4o",
  "provider": "codex"
}
```

**Response:**
```json
{
  "customModels": {
    "codex": [
      {
        "id": "ft:gpt-4o:my-org:custom:abc123",
        "label": "My Fine-tuned GPT-4o",
        "provider": "codex"
      }
    ]
  }
}
```

### GET /api/v1/sessions/:sid/models?provider=xxx
Get all models (built-in + custom) for a provider in a session.

**Response:**
```json
{
  "models": [...]
}
```

### DELETE /api/v1/sessions/:sid/models/:modelId?provider=xxx
Remove a custom model from a session.

**Response:** 204 No Content

---

## 8. Playbook Endpoints

### GET /api/v1/playbooks
List all available playbooks.

**Response:**
```json
{
  "playbooks": [
    "solo-agent",
    "master-2-workers",
    "full-stack-team"
  ]
}
```

### GET /api/v1/playbooks/:name
Get playbook configuration by name.

**Response:**
```json
{
  "name": "master-2-workers",
  "description": "Master orchestrator with 2 coding workers",
  "agents": [
    {
      "name": "Master",
      "role": "master",
      "model": "claude-opus-4-6",
      "persona": "..."
    },
    {
      "name": "Worker A",
      "role": "worker",
      "model": "claude-sonnet-4-6",
      "persona": "..."
    }
  ]
}
```

### POST /api/v1/playbooks
Create a new playbook.

**Request:**
```json
{
  "name": "my-custom-playbook",
  "description": "Custom team setup",
  "agents": [...]
}
```

**Response:** Playbook object (201 Created)

---

## 9. WebSocket Events

Connect to: `ws://localhost:7890/?token={TOKEN}`

### Real-time Events Pushed to Dashboard:

```typescript
type WSEvent =
  | { event: "agent-update"; sessionId: string; agent: AgentState }
  | { event: "agent-spawned"; sessionId: string; agent: AgentState }
  | { event: "agent-removed"; sessionId: string; agentId: string; reason: string }
  | { event: "agent-health"; sessionId: string; agentId: string; status: string }
  | { event: "message"; sessionId: string; message: AgentMessage }
  | { event: "task-update"; sessionId: string; task: Task }
  | { event: "session-update"; session: SessionConfig }
  | { event: "terminal-data"; sessionId: string; agentId: string; data: string }
  | { event: "cost-update"; sessionId: string; agentId: string; costUsd: number }
  | { event: "error"; message: string };
```

### Terminal Streaming WebSocket

Connect to: `ws://localhost:7890/terminal/{sessionId}/{agentId}?token={TOKEN}`

- Uses node-pty for real-time terminal I/O
- Supports resize events
- Full keyboard input/output
- Managed by `PtyManager`

---

## Architecture Notes

1. **Express 5** - Uses path-to-regexp v8 (no `*` wildcard)
2. **Authentication** - All API routes protected, GET routes for dashboard HTML open
3. **Orchestrator Pattern** - Each session has its own `Orchestrator` instance
4. **tmux Integration** - Agents run in tmux sessions for terminal management
5. **node-pty** - Used for WebSocket terminal streaming (xterm.js compatible)
6. **Event Log** - Daily JSONL files in `{runtimeDir}/events/`
7. **State Persistence** - Sessions saved to `~/.agent-orchestrator/sessions.json`
8. **Hot Model Swap** - Supported for claude-code provider
9. **Playbooks** - Pre-configured team setups stored in `~/.agent-orchestrator/playbooks/`

---

## Error Handling

All endpoints follow consistent error response format:

```json
{
  "error": "Error message description"
}
```

Common HTTP status codes:
- `200` - Success
- `201` - Created
- `204` - No Content (delete success)
- `400` - Bad Request (validation error)
- `404` - Not Found
- `409` - Conflict (duplicate resource)
- `500` - Internal Server Error

---

## Key Dependencies

- **SessionManager** - Session lifecycle management
- **Orchestrator** - Per-session orchestration (AgentManager + MessageBus + ControlPlane + EventLog)
- **AgentManager** - Agent spawning, messaging, lifecycle
- **TmuxController** - tmux session management
- **PtyManager** - Terminal streaming via node-pty
- **CLIProviderRegistry** - Provider registry (claude-code, codex, aider, kiro, goose)
- **EventLog** - Event persistence and querying
- **MessageBus** - Inter-agent messaging
- **ControlPlane** - Agent control commands
- **CostTracker** - Token usage and cost tracking
