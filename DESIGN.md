# Agent Orchestrator - VS Code Extension Design

## Overview

A VS Code extension that orchestrates multiple AI coding agents across multiple projects. **CLI-agnostic** — supports Claude Code, OpenAI Codex CLI, Aider, Goose, or any CLI-based coding agent via a pluggable provider system. Each project folder gets its own isolated **session** with its own set of agents, message bus, and task board. Agents run in tmux sessions with unique personas, communicate with each other, and a master agent delegates and coordinates tasks. All progress is visualized in both VS Code and a browser-based dashboard.

---

## Key Concept: Project Sessions

A **Session** is the top-level unit of orchestration. Each session is bound to a specific project folder (any directory — git repo, monorepo subfolder, plain folder, etc.) and contains its own:
- Set of agents (master + workers)
- Message bus
- Task board
- tmux session group
- Runtime state directory

Users can run multiple sessions simultaneously (e.g., a frontend repo and a backend repo), switch between them in the UI, and even have agents in one session communicate with agents in another (cross-project messaging).

```
Session: "frontend-app" (/Users/me/projects/frontend-app)
  +-- Master Agent      [Claude Code]  opus-4-6
  +-- Worker: Components [Claude Code]  sonnet-4-6
  +-- Worker: Styles     [Aider]        deepseek       # different provider!

Session: "backend-api" (/Users/me/projects/backend-api)
  +-- Master Agent      [Kiro]          sonnet-4-6
  +-- Worker: Routes    [Codex]         o4-mini        # mix providers freely
  +-- Worker: Database  [Claude Code]   sonnet-4-6

Session: "mobile-app" (/Users/me/projects/mobile-app)
  +-- Master Agent      [Claude Code]  opus-4-6
  +-- Worker: Screens   [Goose]        gpt-4.1
```

---

## Architecture

The system has three layers: **clients** (VS Code, browser), a **daemon** (the orchestrator core), and **agents** (tmux sessions running CLI tools).

```
+---------------------------+     +---------------------------+
|     VS Code Extension     |     |     Web Browser           |
|  +---------+ +---------+  |     |  +---------------------+  |
|  | Sidebar | | Webview |  |     |  | React Dashboard     |  |
|  | Tree    | | Panel   |  |     |  | (full standalone)   |  |
|  +---------+ +---------+  |     |  | xterm.js terminals  |  |
|        |          |        |     |  +----------+----------+  |
+--------+----------+--------+     +-------------+-------------+
         |          |                             |
         +----------+-----------------------------+
                    |
              REST API + WebSocket (localhost:7890)
                    |
                    v
+---------------------------------------------------------------+
|              Orchestrator Daemon (Node.js process)              |
|                                                                 |
|  +------------------+  +------------------+                     |
|  | Express + WS     |  | CLI Provider     |                    |
|  | (REST API,       |  | Registry         |                    |
|  |  terminal stream)|  | (claude, codex,  |                    |
|  +------------------+  |  aider, kiro...) |                    |
|                         +------------------+                    |
|  +------------------+                                          |
|  | Session Manager  |  (creates/destroys/lists sessions)       |
|  +--------+---------+                                          |
|           |                                                    |
|    +------+------+--------+--------+                           |
|    v             v                 v                            |
|  +-------------+ +-------------+ +-------------+               |
|  | Session A   | | Session B   | | Session C   |  ...          |
|  | project: /a | | project: /b | | project: /c |               |
|  |             | |             | |             |               |
|  | AgentMgr   | | AgentMgr   | | AgentMgr   |               |
|  | MessageBus | | MessageBus | | MessageBus |               |
|  | TaskPlanner| | TaskPlanner| | TaskPlanner|               |
|  +-----+------+ +-----+------+ +-----+------+               |
|        |               |               |                      |
+--------+---------------+---------------+----------------------+
         |               |               |
         v               v               v
+---------------------------------------------------------------+
|                    Agent Layer (tmux sessions)                  |
|                                                                 |
|  Session A agents:        Session B agents:                     |
|  +----------+ +----------+ +----------+ +----------+           |
|  | a-master | | a-wrk-1  | | b-master | | b-wrk-1  |          |
|  | Claude   | | Aider    | | Kiro     | | Codex    |          |
|  | tmux:    | | tmux:    | | tmux:    | | tmux:    |          |
|  | a-orch-0 | | a-orch-1 | | b-orch-0 | | b-orch-1 |          |
|  +----------+ +----------+ +----------+ +----------+          |
+---------------------------------------------------------------+
```

**The daemon can be started two ways:**
1. **By the VS Code extension** — auto-starts when the extension activates, runs as a child process
2. **Standalone from terminal** — `agent-orchestrator start --port 7890` — no VS Code needed

---

## Core Components

### 0. Session Manager

The top-level component that manages project sessions.

```typescript
interface SessionConfig {
  id: string;                      // Auto-generated slug from folder name
  name: string;                    // Display name, e.g. "frontend-app"
  projectPath: string;             // Absolute path to any project folder
  agents: AgentConfig[];           // Agents in this session
  createdAt: Date;
  status: "active" | "paused" | "stopped";
}

interface SessionState {
  config: SessionConfig;
  agents: Map<string, AgentState>;
  messageBus: MessageBus;
  taskBoard: TaskBoard;
  runtimeDir: string;             // {projectPath}/.agent-orchestrator/
}
```

**Session lifecycle:**
```
User creates session -> picks any project folder
  -> Session Manager creates runtime dir in {projectPath}/.agent-orchestrator/
  -> Spawns master agent in tmux: {sessionId}-master
  -> User adds worker agents as needed
  -> All agents scoped to that project's directory
  -> Session can be paused (agents suspended) or stopped (agents killed)
  -> Sessions persist across VS Code restarts (config saved to extension global state)
```

**Persistent session registry:**
Sessions are stored in `~/.agent-orchestrator/sessions.json` so they survive VS Code restarts. Each session's runtime state lives inside the project directory at `.agent-orchestrator/`.

```
~/.agent-orchestrator/
  sessions.json                   # Registry of all sessions
  config.json                     # Global preferences (default provider, default model, dashboard port, etc.)
  providers/                      # User-defined custom provider configs
    my-custom-agent.json          # Custom provider definition

/path/to/project-a/.agent-orchestrator/   # Session A runtime
  session.json                    # Session config snapshot
  messages/
  tasks/
  state/

/path/to/project-b/.agent-orchestrator/   # Session B runtime
  session.json
  messages/
  tasks/
  state/
```

### 1. CLI Provider System (Pluggable Backend)

The orchestrator is **CLI-agnostic**. Each agent specifies which CLI provider to use. Providers implement a common interface that the agent manager calls for spawn, send, capture, and shutdown.

```typescript
// The interface every CLI provider must implement
interface CLIProvider {
  id: string;                      // e.g. "claude-code", "codex", "aider", "goose", "custom"
  displayName: string;             // e.g. "Claude Code", "OpenAI Codex CLI"

  // Build the command as an array of arguments (NOT a shell string) to prevent injection
  buildCommand(config: CLIProviderConfig): string[];

  // How to send a message/prompt to a running instance
  buildSendInput(message: string): string;

  // How to gracefully exit the CLI
  buildExitCommand(): string;

  // Parse raw terminal output into structured progress
  parseOutput(rawOutput: string): ParsedOutput;

  // Available models for this provider
  getModels(): ModelOption[];

  // How to switch model (some CLIs support hot-swap, others need restart)
  supportsHotModelSwap: boolean;
  buildModelSwapCommand?(model: string): string;
}

interface CLIProviderConfig {
  model: string;
  systemPrompt?: string;          // Persona text (written to temp file, never interpolated into shell)
  systemPromptFile?: string;      // Path to the temp file containing the system prompt
  workingDirectory: string;
  extraArgs?: string[];           // Provider-specific flags (validated against allowlist)
  envVars?: Record<string, string>; // e.g. API keys
}

interface ParsedOutput {
  currentActivity?: string;       // What the agent is doing right now
  filesModified?: string[];       // Files being edited
  toolCalls?: string[];           // Tools/commands being used
  tokenUsage?: { input: number; output: number };
  isWaitingForInput?: boolean;    // Agent is idle, waiting for a prompt
  isComplete?: boolean;           // Agent finished its task
}

interface ModelOption {
  id: string;
  label: string;
  tier: "fast" | "balanced" | "capable";  // For cost guidance
}
```

**Built-in providers:**

```typescript
// IMPORTANT: buildCommand returns string[] (argument array), NOT a shell string.
// The tmux controller uses these args safely without shell interpolation:
//   tmux send-keys -t {session} "{args.join(' ')}" Enter
// System prompts are written to a temp file and passed via --system-prompt-file
// to avoid shell injection through prompt content.

// --- Claude Code ---
const claudeCodeProvider: CLIProvider = {
  id: "claude-code",
  displayName: "Claude Code",
  buildCommand: (config) => {
    const args = ["claude", "--model", config.model];
    if (config.systemPrompt) args.push("--system-prompt-file", config.systemPromptFile);
    return [...args, ...(config.extraArgs || [])];
  },
  buildSendInput: (msg) => msg,
  buildExitCommand: () => "/exit",
  parseOutput: (raw) => { /* parse Claude Code's output format */ },
  getModels: () => [
    { id: "claude-opus-4-6",   label: "Opus 4.6",   tier: "capable" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6",  tier: "balanced" },
    { id: "claude-haiku-4-5",  label: "Haiku 4.5",   tier: "fast" },
  ],
  supportsHotModelSwap: false,
};

// --- OpenAI Codex CLI ---
const codexProvider: CLIProvider = {
  id: "codex",
  displayName: "OpenAI Codex CLI",
  buildCommand: (config) => {
    const args = ["codex", "--model", config.model];
    if (config.systemPrompt) args.push("--instructions-file", config.systemPromptFile);
    return [...args, ...(config.extraArgs || [])];
  },
  buildSendInput: (msg) => msg,
  buildExitCommand: () => "/exit",
  parseOutput: (raw) => { /* parse Codex output format */ },
  getModels: () => [
    { id: "o4-mini",     label: "o4-mini",     tier: "fast" },
    { id: "o3",          label: "o3",           tier: "balanced" },
    { id: "gpt-4.1",     label: "GPT-4.1",     tier: "capable" },
  ],
  supportsHotModelSwap: false,
};

// --- Aider ---
const aiderProvider: CLIProvider = {
  id: "aider",
  displayName: "Aider",
  buildCommand: (config) => {
    const args = ["aider", "--model", config.model, "--no-auto-commits"];
    if (config.systemPrompt) args.push("--system-prompt-file", config.systemPromptFile);
    return [...args, ...(config.extraArgs || [])];
  },
  buildSendInput: (msg) => msg,
  buildExitCommand: () => "/exit",
  parseOutput: (raw) => { /* parse Aider output format */ },
  getModels: () => [
    { id: "claude-sonnet-4-6",  label: "Sonnet 4.6 (via Aider)",  tier: "balanced" },
    { id: "gpt-4.1",            label: "GPT-4.1 (via Aider)",     tier: "capable" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek (via Aider)", tier: "fast" },
  ],
  supportsHotModelSwap: true,
  buildModelSwapCommand: (model) => `/model ${model}`,
};

// --- Goose ---
const gooseProvider: CLIProvider = {
  id: "goose",
  displayName: "Goose",
  buildCommand: (config) =>
    `goose session --model ${config.model}${config.systemPrompt ? ` --system-prompt '${config.systemPrompt}'` : ''}`,
  buildSendInput: (msg) => msg,
  buildExitCommand: () => "exit",
  parseOutput: (raw) => { /* parse Goose output format */ },
  getModels: () => [
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6 (via Goose)", tier: "balanced" },
    { id: "gpt-4.1",          label: "GPT-4.1 (via Goose)",     tier: "capable" },
  ],
  supportsHotModelSwap: false,
};

// --- Kiro (Amazon) ---
const kiroProvider: CLIProvider = {
  id: "kiro",
  displayName: "Kiro",
  buildCommand: (config) =>
    `kiro --model ${config.model}${config.systemPrompt ? ` --system-prompt '${config.systemPrompt}'` : ''}${(config.extraArgs || []).map(a => ` ${a}`).join('')}`,
  buildSendInput: (msg) => msg,
  buildExitCommand: () => "/exit",
  parseOutput: (raw) => { /* parse Kiro output format */ },
  getModels: () => [
    { id: "claude-sonnet-4-6",       label: "Sonnet 4.6 (via Kiro)",       tier: "balanced" },
    { id: "amazon-nova-pro",         label: "Amazon Nova Pro (via Kiro)",   tier: "balanced" },
  ],
  supportsHotModelSwap: false,
};

// --- Custom CLI ---
const customProvider: CLIProvider = {
  id: "custom",
  displayName: "Custom CLI",
  // User provides the full command template in extraArgs
  buildCommand: (config) => config.extraArgs?.join(' ') || 'bash',
  buildSendInput: (msg) => msg,
  buildExitCommand: () => "exit",
  parseOutput: (raw) => ({ currentActivity: raw.split('\n').pop() }),
  getModels: () => [],
  supportsHotModelSwap: false,
};
```

**Provider Registry:**
```typescript
class CLIProviderRegistry {
  private providers = new Map<string, CLIProvider>();

  register(provider: CLIProvider): void { this.providers.set(provider.id, provider); }
  get(id: string): CLIProvider | undefined { return this.providers.get(id); }
  list(): CLIProvider[] { return [...this.providers.values()]; }
}

// Extension startup: register built-in + user-contributed providers
const registry = new CLIProviderRegistry();
registry.register(claudeCodeProvider);
registry.register(codexProvider);
registry.register(aiderProvider);
registry.register(gooseProvider);
registry.register(kiroProvider);
registry.register(customProvider);
```

**How the Agent Manager uses providers:**
```typescript
// When spawning an agent, the Agent Manager delegates to the provider:
async function spawnAgent(config: AgentConfig): Promise<void> {
  const provider = registry.get(config.cliProvider);
  const command = provider.buildCommand({
    model: config.model,
    systemPrompt: config.persona,
    workingDirectory: config.workingDirectory,
    extraArgs: config.extraCliArgs,
    envVars: config.envVars,
  });

  // Create tmux session and run the provider's command
  await tmux.newSession(config.tmuxSession);
  await tmux.sendKeys(config.tmuxSession, `cd ${config.workingDirectory}`);
  await tmux.sendKeys(config.tmuxSession, command);
}

// When sending a message to an agent:
async function sendMessage(agentId: string, message: string): Promise<void> {
  const agent = getAgent(agentId);
  const provider = registry.get(agent.config.cliProvider);
  const input = provider.buildSendInput(message);
  await tmux.sendKeys(agent.config.tmuxSession, input);
}

// When parsing output for progress:
function parseAgentOutput(agentId: string, rawOutput: string): ParsedOutput {
  const agent = getAgent(agentId);
  const provider = registry.get(agent.config.cliProvider);
  return provider.parseOutput(rawOutput);
}
```

### 2. Agent Manager (per session)

Responsible for the lifecycle of agents within a single session. Agents can be spawned/removed by the **user**, the **master agent**, or **any agent** with spawn permissions.

```typescript
interface AgentConfig {
  id: string;
  sessionId: string;               // Which session this agent belongs to
  name: string;                    // e.g. "Master", "Frontend Worker", "Test Writer"
  role: "master" | "worker";
  cliProvider: string;             // "claude-code" | "codex" | "aider" | "goose" | "kiro" | "custom"
  persona: string;                 // System prompt / persona injected per provider's mechanism
  model: string;                   // Model ID (provider-specific, e.g. "claude-sonnet-4-6", "o4-mini")
  workingDirectory: string;        // Defaults to session's projectPath, can be subdir
  allowedTools?: string[];         // Restrict tool access per agent
  extraCliArgs?: string[];         // Provider-specific extra CLI flags
  envVars?: Record<string, string>; // Environment variables (API keys, etc.)
  tmuxSession: string;             // tmux session name: "{sessionId}-{agentId}"
  spawnedBy: string;               // "user" or agent ID that created this agent
  permissions: AgentPermissions;
}

interface AgentPermissions {
  canSpawnAgents: boolean;         // Can this agent create new agents?
  canRemoveAgents: boolean;        // Can this agent remove other agents?
  canModifyFiles: boolean;         // File system access
  maxSubAgents?: number;           // Limit how many agents this agent can spawn
}

interface AgentState {
  id: string;
  sessionId: string;
  config: AgentConfig;
  status: "idle" | "running" | "waiting" | "error" | "stopped";
  currentTask?: string;
  output: string[];                // Rolling buffer of recent output
  startedAt?: Date;
  lastActivityAt?: Date;
  childAgents: string[];           // IDs of agents spawned by this agent
}
```

**How agents are spawned:**
Each agent is a CLI process running inside a tmux session. The Agent Manager uses the CLI Provider to build the correct command. The session ID is prefixed to avoid collisions across projects:

```bash
# Create tmux session for agent (namespaced by project session)
tmux new-session -d -s {sessionId}-{agentId} -x 200 -y 50

# cd into the project directory first
tmux send-keys -t {sessionId}-{agentId} "cd {projectPath}" Enter

# Start the CLI via the provider's buildCommand()
# Claude Code example:
tmux send-keys -t {sessionId}-{agentId} \
  "claude --model claude-sonnet-4-6 --system-prompt '{persona}'" Enter

# Codex example (same agent manager, different provider):
tmux send-keys -t {sessionId}-{agentId} \
  "codex --model o4-mini --instructions '{persona}'" Enter

# Kiro example:
tmux send-keys -t {sessionId}-{agentId} \
  "kiro --model {model} --system-prompt '{persona}'" Enter
```

The extension captures tmux output via `tmux capture-pane` on a polling interval (or `tmux pipe-pane` for streaming). The provider's `parseOutput()` method extracts structured progress from the raw output.

### 1a. Agent Control Plane (spawn/remove/interact)

Agents interact with the orchestrator through a **control plane** — a set of special commands written to a control file that the orchestrator watches and executes.

```typescript
// Control commands that agents can issue
type ControlCommand =
  | { action: "spawn-agent"; name: string; role: "worker"; persona: string;
      cliProvider?: string; model: string; task?: string }  // cliProvider defaults to session's default
  | { action: "remove-agent"; targetAgentId: string; reason: string }
  | { action: "list-agents" }
  | { action: "get-agent-status"; targetAgentId: string };

// Written by agents to:
// .agent-orchestrator/control/commands-{agentId}.jsonl

// Orchestrator writes responses to:
// .agent-orchestrator/control/responses-{agentId}.jsonl
```

**How an agent spawns a new agent:**
```
Master Agent decides it needs a CSS specialist:
  |
  v
Master writes to .agent-orchestrator/control/commands-master.jsonl:
  { "action": "spawn-agent", "name": "CSS Specialist", "role": "worker",
    "persona": "You are a CSS/styling expert...", "model": "claude-haiku-4-5",
    "task": "Fix the responsive layout issues in src/components/" }
  |
  v
Orchestrator watches control dir, reads command, validates permissions:
  - Does master have canSpawnAgents: true? Yes
  - Has master exceeded maxSubAgents? No
  |
  v
Orchestrator spawns new tmux session: {sessionId}-css-specialist
  |
  v
Orchestrator writes response to .agent-orchestrator/control/responses-master.jsonl:
  { "status": "ok", "agentId": "css-specialist", "tmux": "{sessionId}-css-specialist" }
  |
  v
Master reads response, knows the new agent is running
Can now send tasks to css-specialist via the message bus
```

**How an agent removes another agent:**
```
Master decides the CSS specialist is done:
  |
  v
Master writes to control:
  { "action": "remove-agent", "targetAgentId": "css-specialist",
    "reason": "Task completed, no longer needed" }
  |
  v
Orchestrator validates:
  - Does master have canRemoveAgents: true? Yes
  - Is css-specialist a child of master (or master has global remove)? Yes
  |
  v
Orchestrator gracefully stops the agent:
  1. Sends "exit" or "/exit" to the tmux session
  2. Waits for graceful shutdown (timeout 10s)
  3. Kills tmux session if still alive
  4. Archives agent's output/state
  5. Removes from active agent list
  |
  v
Dashboard updates: agent card disappears, timeline shows removal event
```

**Default permissions by role:**
```typescript
const DEFAULT_PERMISSIONS: Record<string, AgentPermissions> = {
  master: {
    canSpawnAgents: true,
    canRemoveAgents: true,
    canModifyFiles: true,
    maxSubAgents: 10,
  },
  worker: {
    canSpawnAgents: false,       // Workers can't spawn by default
    canRemoveAgents: false,
    canModifyFiles: true,
    maxSubAgents: 0,
  },
};
// User can override these per agent at creation time
```

### 1b. User Direct Interaction with Agents

The user can directly interact with any agent (master or worker) at any time through multiple interfaces:

**1. Terminal Attach (tmux):**
The user can attach to any agent's tmux session to see its full terminal and type directly:
```bash
# From the extension: right-click agent -> "Attach Terminal"
# Or from command palette: "Agent Orchestrator: Attach to Agent"
# Under the hood:
tmux attach-session -t {sessionId}-{agentId}
```

**2. Chat Input (Dashboard/Webview):**
Each agent card in the dashboard has a chat input box. The user types a message and it's injected into the agent's tmux session via `send-keys`:
```typescript
// User types "focus on the header component first" into agent's chat box
async function sendUserMessage(sessionId: string, agentId: string, message: string) {
  const tmuxSession = `${sessionId}-${agentId}`;
  // Send the message as keystrokes to the agent's Claude Code session
  await tmuxController.sendKeys(tmuxSession, message);
  await tmuxController.sendKeys(tmuxSession, 'Enter');
}
```

**3. Slash Commands in Chat:**
The user can issue special commands to agents through the chat input:
```
/pause          - Pause this agent (stop sending output, keep session alive)
/resume         - Resume a paused agent
/model sonnet   - Switch this agent's model (restarts the session)
/task "do X"    - Assign a new task directly
/status         - Get detailed status report
/history        - Show recent conversation history
/transfer worker-2 "take over the CSS work"  - Transfer task to another agent
```

**4. Sidebar Quick Actions:**
Right-click context menu on any agent in the sidebar tree:
```
Master Agent (opus-4-6)  [running]
  > Send Message...              # Opens input box
  > Attach Terminal              # Opens tmux in VS Code terminal
  > View Full Output             # Opens webview with scrollback
  > Assign Task...               # Task assignment dialog
  > Change Model...              # Model picker
  > Pause Agent
  > Remove Agent
```

**5. Dashboard Agent Detail View:**
Clicking an agent card in the dashboard opens a split view:
```
+------------------------------------------+
| Agent: Worker-Components (sonnet-4-6)    |
| Status: running | Task: Login page       |
+------------------------------------------+
|                    |                      |
|  Live Terminal     |  Agent Info          |
|  (xterm.js)        |  - Files modified    |
|  Shows real-time   |  - Messages sent     |
|  Claude Code       |  - Tasks completed   |
|  output            |  - Token usage       |
|                    |  - Spawned by: master|
|                    |                      |
+------------------------------------------+
| [Send message to this agent...]    [Send] |
+------------------------------------------+
```

The terminal is interactive — the user can click into it and type directly, just like attaching to tmux. The chat box below is a convenience for sending one-off messages without interrupting the terminal view.

### 2. Message Bus (Inter-Agent Communication)

Agents communicate through a shared message file system within their session's runtime directory. Cross-session messaging is routed by the orchestrator core.

```typescript
interface AgentMessage {
  id: string;
  from: string;                    // "{sessionId}:{agentId}" fully qualified, or "user"
  to: string | "all";             // "{sessionId}:{agentId}", "all" (session broadcast),
                                   // or "{sessionId}:all" (cross-session broadcast)
  type: "task" | "status" | "question" | "response" | "result" | "user-message";
  content: string;
  timestamp: Date;
  metadata?: {
    taskId?: string;
    priority?: "low" | "normal" | "high";
    sessionId?: string;            // For cross-session routing
    spawnRequest?: ControlCommand; // If this message triggers a spawn/remove
  };
}
```

**Communication mechanism:**
- Each session has its own `.agent-orchestrator/messages/` directory inside the project
- **One file per message** pattern (NOT appending to shared JSONL files) to avoid race conditions:
  - Inbox: `.agent-orchestrator/messages/inbox-{agentId}/{timestamp}-{msgId}.json`
  - Outbox: `.agent-orchestrator/messages/outbox-{agentId}/{timestamp}-{msgId}.json`
  - Each message is an atomic file write — no concurrent append conflicts
  - Agents read by listing directory contents sorted by timestamp
  - Daemon uses `fs.watch` on directories (not file tailing)
  - Processed messages are moved to a `processed/` subdirectory
- For cross-session messages, the orchestrator reads from one project's outbox and writes to another project's inbox
- The master agent's persona includes instructions to coordinate, delegate, and check on workers

```
/path/to/project-a/.agent-orchestrator/
  messages/
    inbox-master/             # One file per message TO master
      1710500000-msg001.json
      1710500010-msg002.json
      processed/              # Consumed messages moved here
    outbox-master/            # One file per message FROM master
      1710500005-msg003.json
    inbox-worker-1/
    outbox-worker-1/
  control/                    # Agent control plane (one file per command)
    commands-master/          # Commands FROM master agent
      1710500020-cmd001.json
      processed/
    responses-master/         # Responses TO master agent
      1710500021-res001.json
  tasks/
    task-001.json             # Task definition + status
    task-002.json
  state/
    agent-master.json         # Agent state snapshots
    agent-worker-1.json
  archive/                    # Removed agents' state (for history)
    agent-css-specialist/
      output.log
      state.json

/path/to/project-b/.agent-orchestrator/
  messages/                   # Separate mailbox for project B
    inbox-master.jsonl
    ...
```

**Cross-session messaging example:**
Frontend session's master agent asks backend session's master about an API contract:
```
frontend-app:master -> outbox: { to: "backend-api:master", type: "question",
                                  content: "What's the /auth endpoint schema?" }
  |
  v
Orchestrator: detects cross-session target, routes to backend-api's inbox
  |
  v
backend-api:master reads inbox, responds
```

### 3. Task Planner

The master agent (or the user) can decompose work into tasks.

```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  status: "pending" | "assigned" | "in-progress" | "review" | "done" | "failed";
  assignedTo?: string;       // agent ID
  createdBy: string;         // "user" or agent ID
  dependencies?: string[];   // task IDs that must complete first
  subtasks?: string[];       // child task IDs
  result?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### 4. Output Capture & Progress Tracking

Each agent's tmux pane is captured periodically to extract:
- Current activity (what file is being edited, what command is running)
- Token/cost usage (parsed from Claude Code output)
- Conversation turns count
- Tool calls being made

```typescript
interface AgentProgress {
  agentId: string;
  currentActivity: string;       // Parsed from latest output
  filesModified: string[];       // Tracked via git diff per agent
  toolCallsCount: number;
  conversationTurns: number;
  tokenUsage?: { input: number; output: number };
  costEstimate?: number;
}
```

**Capture approach:**
```bash
# Poll every 1-2 seconds
tmux capture-pane -t orch-{agentId} -p -S -50   # last 50 lines
```

Parse the captured output with regex/heuristics to determine agent state.

---

## VS Code Extension UI

### Sidebar: Session & Agent Tree View

```
AGENT ORCHESTRATOR
  [+ New Session] [Open Dashboard]

  > frontend-app (/Users/me/projects/frontend)     [active]
    [+ Add Agent] [Pause] [Stop]
    Master Agent [Claude Code] (opus-4-6)        [running]
      Current: Decomposing task into subtasks
      Tokens: 12.4k in / 3.2k out
      Spawned: CSS Expert, Test Runner
    Worker: Components [Claude Code] (sonnet-4-6) [running]
      Task: Implement login page
      Files: src/Login.tsx, src/auth.ts
    Worker: CSS Expert [Aider] (deepseek)        [running]  # spawned by master, different provider!
      Task: Fix responsive breakpoints
    Worker: Tests [Codex] (o4-mini)              [running]  # mixing providers in same session
      Task: Write unit tests for auth module

  > backend-api (/Users/me/projects/backend)        [active]
    [+ Add Agent] [Pause] [Stop]
    Master Agent [Kiro] (sonnet-4-6)             [running]
      Current: Implementing /auth endpoint
    Worker: Database [Claude Code] (sonnet-4-6)  [idle]
      Waiting for task assignment

  > mobile-app (/Users/me/projects/mobile)          [paused]
    [Resume] [Stop]
    (2 agents paused)
```

### Webview Dashboard (also served to browser)

A React-based dashboard with:

**Top Bar:**
- Session selector dropdown (switch between projects)
- "All Sessions" overview mode (see everything at a glance)
- Global controls: new session, dashboard settings

**Per-Session Views:**

1. **Agent Cards Grid** - Each agent as a card showing:
   - Name, model, role badge
   - Status indicator (color-coded)
   - Current task description
   - Mini terminal preview (last few lines of output)
   - Token usage / cost
   - Click to expand full terminal view

2. **Communication Timeline** - A vertical timeline showing:
   - Messages between agents (within session and cross-session)
   - Task delegations
   - Status updates
   - Color-coded by agent, with session badges for cross-session messages

3. **Task Board** (Kanban-style) - Columns:
   - Pending | In Progress | Review | Done
   - Cards show task title, assigned agent, progress
   - Scoped to the selected session

4. **Dependency Graph** - Visual DAG of:
   - Tasks and their dependencies
   - Which agent is working on what
   - Completion status

5. **Full Terminal View** - Embedded terminal showing the raw tmux output for a selected agent (via xterm.js)

**All Sessions Overview:**

6. **Session Cards** - One card per project showing:
   - Project name and path
   - Agent count and status summary (3 running, 1 idle)
   - Aggregate token usage / cost
   - Active task count
   - Quick actions: pause/resume/stop session
   - Click to drill into session detail

7. **Cross-Session Activity Feed** - Shows cross-project messages and dependencies

---

## Web Interface (Full Standalone Browser Experience)

The browser is a **first-class interface** — not a secondary view. You can do everything from the browser that you can do from VS Code: create sessions, spawn agents, interact with them, manage tasks. The orchestrator core runs as a **daemon process** that both VS Code and the browser connect to.

### Architecture: Daemon + Clients

```
+-------------------+     +-------------------+
| VS Code Extension |     | Web Browser       |
| (client)          |     | (client)          |
+--------+----------+     +--------+----------+
         |                          |
         |     REST API + WebSocket |
         +------------+-------------+
                      |
                      v
         +------------+-------------+
         |   Orchestrator Daemon    |
         |   (Node.js process)      |
         |                          |
         |   Express + WebSocket    |
         |   Orchestrator Core      |
         |   tmux management        |
         |   file watchers          |
         +------------+-------------+
                      |
                      v
         +------------+-------------+
         |   tmux sessions          |
         |   (CLI agents)           |
         +--------------------------+
```

**Two launch modes:**

1. **VS Code Extension mode** — The extension starts the daemon automatically when activated. The daemon runs as a child process. VS Code webviews and the browser both connect to it.

2. **Standalone CLI mode** — Start the daemon directly from the terminal without VS Code:
   ```bash
   # Install globally
   npm install -g agent-orchestrator

   # Start the daemon
   agent-orchestrator start --port 7890

   # Open in browser
   open http://localhost:7890
   ```
   This lets users on remote servers, headless machines, or those who prefer a browser-only workflow use the orchestrator without VS Code.

### REST API (Full CRUD)

```typescript
const server = express();
const wss = new WebSocketServer({ server });

server.use(express.static(path.join(__dirname, 'dashboard/build')));

// Auth middleware: all /api/v1/* routes (except /api/v1/status) require bearer token
server.use('/api/v1', authMiddleware);

// === System (status is unauthenticated for health checks) ===
server.get('/api/v1/status', ...);                                // { alive: true, version: "1.0.0", apiVersion: "v1" }
server.get('/api/v1/config', ...);                                // Global config
server.put('/api/v1/config', ...);                                // Update global config

// === Sessions ===
server.get('/api/v1/sessions', ...);                              // List all sessions
server.post('/api/v1/sessions', ...);                             // Create session (pick folder + default provider)
server.get('/api/v1/sessions/:sid', ...);                         // Get session detail
server.put('/api/v1/sessions/:sid', ...);                         // Update session config
server.delete('/api/v1/sessions/:sid', ...);                      // Stop & remove session
server.post('/api/v1/sessions/:sid/pause', ...);                  // Pause session
server.post('/api/v1/sessions/:sid/resume', ...);                 // Resume session

// === Agents ===
server.get('/api/v1/sessions/:sid/agents', ...);                  // List agents in session
server.post('/api/v1/sessions/:sid/agents', ...);                 // Spawn new agent
server.get('/api/v1/sessions/:sid/agents/:aid', ...);             // Get agent detail (includes health, cost)
server.delete('/api/v1/sessions/:sid/agents/:aid', ...);          // Remove agent
server.post('/api/v1/sessions/:sid/agents/:aid/message', ...);    // Send message to agent
server.get('/api/v1/sessions/:sid/agents/:aid/output', ...);      // Get terminal output (last N lines)
server.post('/api/v1/sessions/:sid/agents/:aid/model', ...);      // Change agent model
server.post('/api/v1/sessions/:sid/agents/:aid/provider', ...);   // Change agent CLI provider (restarts)
server.post('/api/v1/sessions/:sid/agents/:aid/pause', ...);      // Pause agent
server.post('/api/v1/sessions/:sid/agents/:aid/resume', ...);     // Resume agent

// === Terminal streaming ===
server.get('/api/v1/sessions/:sid/agents/:aid/terminal', ...);    // WebSocket upgrade (max 3 per agent)

// === Tasks ===
server.get('/api/v1/sessions/:sid/tasks', ...);                   // List tasks in session
server.post('/api/v1/sessions/:sid/tasks', ...);                  // Create task
server.put('/api/v1/sessions/:sid/tasks/:tid', ...);              // Update task

// === Events (historical + catch-up) ===
server.get('/api/v1/sessions/:sid/events', ...);                  // ?since={ISO}&limit=100&type={type}
server.get('/api/v1/events/cross-session', ...);                  // Cross-session events

// === Messages / Timeline ===
server.get('/api/v1/sessions/:sid/messages', ...);                // Get message history
server.get('/api/v1/messages/cross-session', ...);                // Cross-session messages

// === Providers ===
server.get('/api/v1/providers', ...);                             // List available CLI providers
server.get('/api/v1/providers/:pid/models', ...);                 // List models for a provider

// WebSocket for real-time push
wss.on('connection', (ws) => {
  orchestrator.on('agent-update',   (d) => ws.send(JSON.stringify({ event: 'agent-update', ...d })));
  orchestrator.on('agent-spawned',  (d) => ws.send(JSON.stringify({ event: 'agent-spawned', ...d })));
  orchestrator.on('agent-removed',  (d) => ws.send(JSON.stringify({ event: 'agent-removed', ...d })));
  orchestrator.on('message',        (d) => ws.send(JSON.stringify({ event: 'message', ...d })));
  orchestrator.on('task-update',    (d) => ws.send(JSON.stringify({ event: 'task-update', ...d })));
  orchestrator.on('session-update', (d) => ws.send(JSON.stringify({ event: 'session-update', ...d })));
  orchestrator.on('terminal-data',  (d) => ws.send(JSON.stringify({ event: 'terminal-data', ...d })));
});

server.listen(PORT); // default 7890
```

### Browser Dashboard Pages

**URLs:**
```
http://localhost:7890                                     # All sessions overview
http://localhost:7890/session/{sessionId}                  # Session detail (agents, tasks, timeline)
http://localhost:7890/session/{sessionId}/agent/{agentId}  # Agent detail (full terminal + chat)
http://localhost:7890/session/{sessionId}/tasks            # Task board (kanban)
http://localhost:7890/session/{sessionId}/timeline         # Communication timeline
http://localhost:7890/settings                             # Global settings, provider config
```

**Full browser capabilities (everything VS Code can do):**

| Action | How in browser |
|--------|---------------|
| Create session | Click "+ New Session", enter folder path, pick default provider |
| Spawn agent | Click "+ Add Agent" on session page, pick provider + model + persona |
| Remove agent | Click trash icon on agent card, or via agent detail page |
| Send message to agent | Chat input on agent card or agent detail page |
| Interactive terminal | Full xterm.js terminal on agent detail page (bidirectional via WebSocket) |
| Change model/provider | Dropdowns on agent card |
| Manage tasks | Drag-and-drop kanban board |
| View timeline | Filterable message timeline with cross-session view |
| Pause/resume/stop | Buttons on session and agent cards |

### Live Terminal in Browser (xterm.js + WebSocket)

The browser gets a **fully interactive terminal** for each agent, not just a read-only preview:

```typescript
// Terminal streaming uses tmux pipe-pane (event-driven, not polling)
// One pipe per agent, fan-out to multiple WebSocket clients

// On agent spawn, start the pipe:
// tmux pipe-pane -t {session} "cat >> {agentPipeFile}"
// The daemon watches agentPipeFile with fs.watch and streams new bytes to clients

wss.on('connection', (ws, req) => {
  // Authenticate: check token in query param
  if (!validateToken(req)) { ws.close(4001, 'Unauthorized'); return; }

  const match = req.url?.match(/\/terminal\/(.+?)\/(.+)/);
  if (match) {
    const [_, sessionId, agentId] = match;
    const stream = terminalStreams.get(`${sessionId}-${agentId}`);
    if (!stream) { ws.close(4004, 'Agent not found'); return; }

    // Enforce max 3 concurrent connections per agent
    if (stream.clientCount >= 3) { ws.close(4029, 'Too many connections'); return; }

    // Send ring buffer (last 1000 lines) for catch-up, then live stream
    stream.addClient(ws);

    // Browser keystrokes -> tmux (using -l literal flag to prevent injection)
    ws.on('message', (msg) => {
      const { type, data } = JSON.parse(msg.toString());
      if (type === 'input') {
        tmux.sendKeys(`${sessionId}-${agentId}`, data, { literal: true });
      }
    });
  }
});
```

This means you can open the dashboard on a **phone, tablet, or any device** with a browser and fully interact with your agents. Useful for:
- Monitoring agents on the go from your phone
- Running agents on a remote server and managing them from your laptop's browser
- Sharing the dashboard URL with a colleague to observe progress
- Using on machines where VS Code isn't installed

### Mobile-Responsive Dashboard

The React dashboard uses responsive design:
- **Desktop**: Full grid layout with side-by-side panels
- **Tablet**: Stacked cards, collapsible panels
- **Mobile**: Single-column, swipeable agent cards, simplified terminal view

---

## Agent Persona Injection

Each agent gets a tailored system prompt (via `--system-prompt` flag) that defines its role, communication protocol, and control plane access.

**Base persona (all agents):**
```markdown
# Agent: {name}
## Role: {master|worker}
## Instructions
{persona text - e.g. "You are a frontend specialist. Focus on React components..."}

## Communication Protocol
- Check `.agent-orchestrator/messages/inbox-{id}.jsonl` periodically for new messages
- Write responses to `.agent-orchestrator/messages/outbox-{id}.jsonl`
- Message format: one JSON object per line with fields: to, type, content
- When you complete a task, write a summary to outbox with type "result"
- Messages from the user will appear with from: "user"

## Constraints
- Only modify files in: {allowedPaths}
- Do not modify files being worked on by other agents (check state/)
```

**Master agent persona (adds control plane access):**
```markdown
## Master Orchestrator Instructions
- You coordinate a team of worker agents
- Decompose the user's request into subtasks
- Write task assignments to worker inboxes
- Monitor worker progress via their outbox messages
- Resolve conflicts between workers
- Synthesize final results

## Agent Management (Control Plane)
You can spawn and remove agents by writing commands to the control plane.

### To spawn a new agent:
Write to `.agent-orchestrator/control/commands-{your-id}.jsonl`:
{"action": "spawn-agent", "name": "Agent Name", "role": "worker", "persona": "You are a...", "model": "claude-sonnet-4-6", "task": "Optional initial task"}

Then read the response from `.agent-orchestrator/control/responses-{your-id}.jsonl`
The response will contain the new agent's ID.

### To remove an agent:
Write to `.agent-orchestrator/control/commands-{your-id}.jsonl`:
{"action": "remove-agent", "targetAgentId": "agent-id", "reason": "Task completed"}

### To list current agents:
Write: {"action": "list-agents"}
Response will contain all agents, their status, and current tasks.

### Guidelines for spawning agents:
- Spawn specialists when a task requires focused expertise
- Use cheaper models (haiku) for simple/repetitive tasks
- Use capable models (sonnet/opus) for complex reasoning tasks
- Remove agents when their task is complete to free resources
- Don't spawn more than you need — prefer reusing idle agents
```

**Worker agent with spawn permissions (optional, user-enabled):**
```markdown
## Sub-Agent Spawning
You have permission to spawn helper agents for your task.
Write commands to `.agent-orchestrator/control/commands-{your-id}.jsonl`
(Same format as master, but limited to {maxSubAgents} sub-agents)
```

---

## Model & Provider Configuration

Each agent can use a different CLI provider AND a different model. The model list is dynamic — it comes from the selected provider's `getModels()` method.

```typescript
// When the user picks a provider, the model dropdown updates:
//
// Provider: Claude Code  ->  Models: Opus 4.6, Sonnet 4.6, Haiku 4.5
// Provider: Codex CLI    ->  Models: o4-mini, o3, GPT-4.1
// Provider: Aider        ->  Models: Sonnet 4.6, GPT-4.1, DeepSeek
// Provider: Kiro         ->  Models: Sonnet 4.6, Amazon Nova Pro
// Provider: Goose        ->  Models: Sonnet 4.6, GPT-4.1
// Provider: Custom       ->  Models: (user enters manually)
```

**Strategy:** Use the most capable model+provider for the master agent (e.g., Claude Code + Opus) and cheaper/faster combos for workers (e.g., Codex + o4-mini, Aider + DeepSeek). You can even **mix providers within a session** — a Claude Code master orchestrating Codex and Aider workers.

**Model change at runtime:**
- If the provider supports `supportsHotModelSwap` (e.g., Aider's `/model` command), send the swap command directly.
- Otherwise, gracefully restart the agent's tmux session with the new model.

**Session-level default provider:**
Each session has a `defaultProvider` so agents spawned by the master (via control plane) inherit the session's provider unless explicitly overridden.

```typescript
interface SessionConfig {
  id: string;
  name: string;
  projectPath: string;
  defaultProvider: string;          // e.g. "claude-code" — new agents inherit this
  agents: AgentConfig[];
  createdAt: Date;
  status: "active" | "paused" | "stopped";
}
```

---

## Project Structure

```
agent-orchestrator/
  package.json                    # Monorepo root (workspaces)
  tsconfig.json

  # === Shared Types (used by daemon, dashboard, and extension) ===
  packages/shared/
    package.json                  # "@agent-orchestrator/shared"
    src/
      types.ts                    # SessionConfig, AgentConfig, AgentState, Task, AgentMessage, etc.
      api.ts                      # API request/response types, event types
      constants.ts                # Autonomy levels, default ports, version strings
      providers.ts                # CLIProvider interface, ModelOption, CLIProviderConfig

  # === Daemon (the core — runs standalone or inside VS Code) ===
  packages/daemon/
    package.json                  # "agent-orchestrator" CLI package (npm installable)
    src/
      index.ts                    # Daemon entry point, starts Express + orchestrator
      cli.ts                      # CLI: `agent-orchestrator start --port 7890`
      daemon-lifecycle.ts         # PID file, port discovery, token generation, shutdown
      core/
        session-manager.ts        # Create/list/pause/stop project sessions
        session.ts                # Single session: owns agents, message bus, tasks
        agent-manager.ts          # Agent lifecycle (tmux spawn/stop/monitor) per session
        agent-health.ts           # Health check loop, crash detection, restart policy
        agent-control-plane.ts    # Watches control/ dir, executes spawn/remove commands (idempotent)
        message-bus.ts            # Inter-agent message routing (one-file-per-message pattern)
        user-interaction.ts       # Handles user -> agent direct messaging
        task-planner.ts           # Task decomposition & assignment
        output-parser.ts          # Parse tmux output via provider's parseOutput()
        tmux-controller.ts        # Low-level tmux commands (uses -l literal flag)
        terminal-stream.ts        # pipe-pane based streaming, fan-out to multiple clients
        event-log.ts              # Structured event log, historical query support
        cost-tracker.ts           # Per-agent token/cost tracking, budget enforcement
      cli-providers/
        provider-interface.ts     # CLIProvider interface + CLIProviderRegistry
        arg-validator.ts          # Allowlist-based validation for extraArgs per provider
        claude-code.ts            # Claude Code provider
        codex.ts                  # OpenAI Codex CLI provider
        aider.ts                  # Aider provider
        goose.ts                  # Goose provider
        kiro.ts                   # Kiro (Amazon) provider
        custom.ts                 # Custom CLI provider (user-defined command)
      server/
        index.ts                  # Express + WebSocket server setup
        auth.ts                   # Bearer token middleware, token generation/validation
        api-routes.ts             # /api/v1/ routes for sessions/agents/tasks/providers/events
        terminal-ws.ts            # WebSocket handler for live terminal streaming (fan-out)

  # === VS Code Extension (thin client, connects to daemon) ===
  packages/vscode-extension/
    package.json                  # VS Code extension manifest
    src/
      extension.ts                # Extension entry: discovers/starts daemon, registers commands
      daemon-discovery.ts         # Read PID/token files, connect or start daemon, reconnection loop
      daemon-client.ts            # HTTP/WS client to talk to daemon API (with auth token)
      providers/
        session-tree-provider.ts  # Sidebar tree view (sessions > agents)
        webview-provider.ts       # Embeds dashboard React app in VS Code webview
        status-bar.ts             # Status bar: daemon connection state, active agent count

  # === Dashboard (React app — served by daemon, embedded in VS Code) ===
  packages/dashboard/
    package.json
    vite.config.ts
    src/
      App.tsx
      pages/
        AllSessions.tsx           # Overview of all project sessions
        SessionDetail.tsx         # Single session: agents, tasks, timeline
        AgentView.tsx             # Full terminal + detail + chat for one agent
        TaskBoardPage.tsx         # Full-page kanban board
        TimelinePage.tsx          # Full-page communication timeline
        SettingsPage.tsx          # Global settings, provider config, API keys
      components/
        SessionCard.tsx           # Project session summary card
        AgentCard.tsx             # Agent status card with chat input
        AgentTerminal.tsx         # xterm.js interactive terminal (bidirectional via WS)
        AgentChatInput.tsx        # Message input box for direct agent interaction
        SpawnAgentDialog.tsx      # Dialog: pick provider + model + persona + name
        CreateSessionDialog.tsx   # Dialog: pick folder path + default provider
        ProviderSelector.tsx      # CLI provider picker
        TaskBoard.tsx             # Kanban board component
        Timeline.tsx              # Communication timeline (user interactions + agent msgs)
        DependencyGraph.tsx       # Task dependency DAG
        ModelSelector.tsx         # Model picker dropdown (dynamic per provider)
        SessionSelector.tsx       # Session switcher dropdown
        Navbar.tsx                # Top nav: session switcher, settings, status indicator
      hooks/
        useWebSocket.ts           # Real-time updates from daemon
        useTerminal.ts            # xterm.js + WebSocket terminal hook
        useApi.ts                 # REST API client hook
      stores/
        sessionStore.ts           # Zustand: sessions state
        agentStore.ts             # Zustand: agents state (scoped by session)
        uiStore.ts                # Zustand: UI state (selected session, theme, layout)

# Global config (persists across restarts)
~/.agent-orchestrator/
  sessions.json                   # Registry: [{id, name, projectPath, status}]
  config.json                     # Default provider, model, dashboard port, preferences
  daemon.pid                      # PID of running daemon process
  daemon.port                     # Port the daemon is listening on
  daemon.token                    # Bearer token for API auth (generated on first start)
  playbooks/                      # Saved session templates
    fullstack.yml
    solo-agent.yml

# Per-project runtime (auto-added to .gitignore on session creation)
/path/to/any-project/.agent-orchestrator/
  session.json                    # Session config snapshot
  .agent-orchestrator.yml         # Optional: per-repo config (version-controlled, NOT gitignored)
  knowledge/                      # Persistent project knowledge base
    architecture.md
    conventions.md
  messages/                       # One file per message (atomic writes, no race conditions)
    inbox-master/
      1710500000-msg001.json
      processed/
    outbox-master/
      1710500005-msg003.json
  control/                        # One file per command (idempotent on daemon restart)
    commands-master/
      1710500020-cmd001.json
      processed/
    responses-master/
  personas/                       # System prompt files (avoids shell injection)
    master-prompt.md
    worker-1-prompt.md
  tasks/
    task-001.json
  state/
    agent-master.json
    agent-worker-1.json
  events/                         # Structured event log (queryable via REST API)
    2026-03-15.jsonl              # One file per day
  archive/                        # Removed agents' history
    agent-css-specialist/
      output.log
      state.json
```

---

## Key Flows

### Flow 0: User creates a new project session

```
User -> Extension: "New Session" -> picks folder /Users/me/projects/frontend-app
  |
  v
Session Manager:
  1. Creates session config {id: "frontend-app", projectPath: "/Users/me/projects/frontend-app"}
  2. Creates /Users/me/projects/frontend-app/.agent-orchestrator/ directory
  3. Registers session in ~/.agent-orchestrator/sessions.json
  4. Prompts: "Add a master agent?" -> User picks model + persona
  5. Spawns master agent in tmux: "frontend-app-master"
  |
  v
Sidebar & Dashboard update to show new session
User can now add worker agents and assign tasks
```

### Flow 1: User starts a multi-agent task within a session

```
User -> Extension (session: frontend-app): "Build a login page with tests"
  |
  v
Extension -> Master Agent (tmux: frontend-app-master): Injects task via stdin
  |
  v
Master Agent: Decomposes into subtasks:
  - Task 1: "Create Login component" -> assign to components worker
  - Task 2: "Write tests" -> assign to test worker (depends on 1)
  |
  v
Master Agent -> outbox: Writes task assignments
  |
  v
Message Bus (frontend-app session): Routes messages to worker inboxes
  |
  v
Workers: Read inbox, start working
  |
  v
Output Parser: Captures tmux output every 1s, updates AgentState
  |
  v
Dashboard: WebSocket pushes updates to UI (tagged with sessionId)
  |
  v
Workers -> outbox: "Task complete, here's what I did"
  |
  v
Message Bus -> Master inbox: Delivers results
  |
  v
Master Agent: Reviews, integrates, reports to user
```

### Flow 2: Cross-session communication

```
frontend-app:master -> outbox:
  { to: "backend-api:master", type: "question",
    content: "I need the /auth endpoint to return {userId, token}. Can you confirm the schema?" }
  |
  v
Message Bus: Detects cross-session target "backend-api:master"
  |
  v
Orchestrator: Reads from frontend-app outbox, writes to backend-api inbox
  |
  v
backend-api:master reads inbox, responds -> outbox:
  { to: "frontend-app:master", type: "response",
    content: "Confirmed. Schema is {userId: string, token: string, expiresAt: number}" }
  |
  v
Orchestrator: Routes back to frontend-app inbox
  |
  (Shown in Timeline with cross-session badge)
```

### Flow 3: Agent-to-Agent conversation (within session)

```
Worker A -> outbox: { to: "worker-b", type: "question",
                      content: "What's the auth token format?" }
  |
  v
Message Bus: Routes to Worker B's inbox (same session)
  |
  v
Worker B reads inbox, responds -> outbox: { to: "worker-a",
                      type: "response", content: "JWT with..." }
  |
  v
Message Bus: Routes back to Worker A's inbox
  |
  (All shown in Timeline view)
```

### Flow 4: Master agent dynamically spawns a worker

```
Master Agent is working on a complex task, realizes it needs a CSS expert:
  |
  v
Master writes to .agent-orchestrator/control/commands-master.jsonl:
  {"action": "spawn-agent", "name": "CSS Expert", "role": "worker",
   "persona": "You are a CSS expert specializing in responsive layouts...",
   "model": "claude-haiku-4-5",
   "task": "Fix responsive breakpoints in src/components/Layout.tsx"}
  |
  v
Orchestrator detects new command, validates master's permissions
  |
  v
Orchestrator spawns new tmux session: frontend-app-css-expert
  Injects persona, starts Claude Code, sends initial task
  |
  v
Orchestrator writes to .agent-orchestrator/control/responses-master.jsonl:
  {"status": "ok", "agentId": "css-expert"}
  |
  v
Dashboard: New agent card appears with "spawned by: master" badge
Timeline: Shows "Master spawned CSS Expert" event
  |
  v
Master can now message css-expert via the message bus
When done, master removes it via: {"action": "remove-agent", "targetAgentId": "css-expert"}
```

### Flow 5: Master removes a worker agent

```
Master decides worker-1 is done:
  |
  v
Master writes to control:
  {"action": "remove-agent", "targetAgentId": "worker-1", "reason": "Login page complete"}
  |
  v
Orchestrator validates permissions (master can remove its children)
  |
  v
Orchestrator graceful shutdown sequence:
  1. Sends Ctrl+C to tmux session (interrupt current operation)
  2. Sends "/exit" to Claude Code
  3. Waits up to 10s for graceful exit
  4. Force-kills tmux session if still alive: tmux kill-session -t {session}
  5. Archives agent state to .agent-orchestrator/archive/worker-1/
  6. Removes agent from active roster
  |
  v
Dashboard: Agent card fades out, timeline shows removal event
Master receives confirmation in control responses
```

### Flow 6: User directly interacts with a subagent

```
User sees Worker-Components is going in the wrong direction (via dashboard):
  |
  v
Option A: Chat input on the agent card
  User types: "Stop working on the footer, focus on the header nav instead"
  |
  v
  Extension sends via tmux: tmux send-keys -t frontend-app-worker-1 "Stop working..."
  Agent receives it as a new user message in its Claude Code session
  |
  v
Option B: Attach terminal
  User clicks "Attach Terminal" on the agent card
  |
  v
  VS Code opens a new terminal panel attached to:
    tmux attach-session -t frontend-app-worker-1
  User can now interact with Claude Code directly, full bidirectional
  When done, user detaches (Ctrl+B, D) and agent continues autonomously
  |
  v
Option C: Quick action from sidebar
  User right-clicks agent -> "Assign Task..."
  Dialog opens, user types task description
  Extension sends it via tmux send-keys
  |
  v
All interactions logged in timeline as "user -> agent" messages
Master agent is notified (via its inbox) that user intervened on a worker
```

---

## Operational Robustness

### Daemon Lifecycle Management

```typescript
// ~/.agent-orchestrator/
//   daemon.pid          — PID of the running daemon process
//   daemon.token        — Bearer token for API authentication
//   daemon.port         — Port the daemon is listening on

interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: Date;
  startedBy: "cli" | "vscode";   // Who started it
}
```

**Startup sequence:**
```
1. Check if ~/.agent-orchestrator/daemon.pid exists
2. If exists, read PID and port, try GET http://localhost:{port}/api/v1/status
3. If daemon is alive → connect to it (don't start a new one)
4. If daemon is dead (stale PID) → clean up PID file, start fresh
5. If no PID file → start new daemon:
   a. Find an available port (default 7890, auto-increment if busy)
   b. Generate a random bearer token (crypto.randomBytes(32).toString('hex'))
   c. Write daemon.pid, daemon.token, daemon.port
   d. Start Express server
```

**Graceful shutdown:**
- Standalone CLI mode: daemon stays alive until explicitly stopped (`agent-orchestrator stop`) or SIGTERM
- VS Code mode: daemon stays alive even when VS Code closes (agents keep running). The extension reconnects on reactivation.
- `agent-orchestrator stop` sends SIGTERM → daemon saves state, gracefully stops all agents, cleans up PID file

**Crash recovery:**
- If the daemon crashes, the PID file becomes stale. Next client startup detects this and restarts.
- On restart, the daemon reads `sessions.json` and checks which tmux sessions are still alive → marks them as recovered.
- Agents that were running continue in tmux (tmux survives the daemon crash). The daemon reconnects to them.

### API Authentication

All API endpoints require a bearer token (except GET /api/v1/status which returns only { alive: true }):

```
Authorization: Bearer {token from ~/.agent-orchestrator/daemon.token}
```

- The token is generated on first daemon start and persists across restarts (stored in daemon.token)
- VS Code extension reads the token file automatically
- Browser dashboard: token is passed via query param on first load (`?token=...`), stored in httpOnly cookie
- WebSocket connections include the token in the initial handshake (`?token=...` query param)
- If exposed via tunnel for remote access, the token provides basic auth protection

### API Versioning

All routes are prefixed with `/api/v1/`:
```
GET  /api/v1/status              — { version: "1.0.0", apiVersion: "v1", alive: true }
GET  /api/v1/sessions
POST /api/v1/sessions
GET  /api/v1/sessions/:sid/agents
...
```

Clients check `apiVersion` on connect. If the daemon is running a newer API version, the client shows a warning to update.

### Agent Health Checks & Crash Recovery

```typescript
interface AgentState {
  // ... existing fields ...
  status: "idle" | "running" | "waiting" | "error" | "crashed" | "stopped";
  healthCheck: {
    lastPingAt: Date;            // Last time we confirmed the tmux session is alive
    consecutiveFailures: number;  // How many health checks failed in a row
    restartCount: number;         // How many times this agent has been restarted
  };
  restartPolicy: "never" | "on-crash" | "always";  // Default: "on-crash"
  maxRestarts: number;           // Default: 3
}
```

**Health check loop (runs every 5 seconds per agent):**
```
1. tmux has-session -t {sessionId}-{agentId}
2. If session exists → check if process inside is alive (tmux list-panes -F '#{pane_pid}')
3. If session is gone or process is dead:
   a. Mark agent as "crashed"
   b. If restartPolicy is "on-crash" and restartCount < maxRestarts:
      - Re-spawn the tmux session
      - Inject a recovery prompt: "You were working on {lastTask}. The session was interrupted. Continue from where you left off."
      - Increment restartCount
   c. Else: mark as "stopped", notify user via dashboard + desktop notification
4. Emit 'agent-health' event for dashboard updates
```

### Terminal Streaming Efficiency

**Problem:** Polling `tmux capture-pane` at 100ms per terminal per client doesn't scale.

**Solution: `tmux pipe-pane` with single-writer, multi-reader fan-out:**

```typescript
class TerminalStream {
  private pipe: fs.ReadStream;       // One pipe per agent (not per client)
  private clients: Set<WebSocket>;   // Multiple clients subscribe
  private buffer: RingBuffer;        // Last 1000 lines for new client catchup

  // On agent spawn: start piping tmux output to a file
  // tmux pipe-pane -t {session} "cat >> /tmp/orch-{sessionId}-{agentId}.pipe"
  startCapture(tmuxSession: string): void {
    // Watch the pipe file with fs.watch + read new bytes
    // Fan out to all subscribed WebSocket clients
  }

  // New client connects: send buffer (catchup), then live stream
  addClient(ws: WebSocket): void {
    ws.send(JSON.stringify({ type: 'catchup', data: this.buffer.getAll() }));
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
  }
}
```

Key decisions:
- **One pipe per agent** regardless of how many browser tabs are watching
- **Adaptive polling fallback**: if `pipe-pane` isn't available, fall back to capture-pane with adaptive rate: 200ms when output is flowing, 2s when idle
- **Max 3 concurrent terminal WebSocket connections per agent** (prevents browser tab proliferation)
- **Ring buffer of last 1000 lines** so new clients get immediate context

### File I/O Safety

**One-file-per-message pattern** (described in Message Bus section above):
- Messages are individual JSON files, not appended to shared JSONL
- Atomic file write: write to temp file, then `fs.rename()` (atomic on same filesystem)
- Directory listing with sorted names provides ordering
- No locks needed — the filesystem provides atomicity

**Control plane commands** use the same pattern:
- `.agent-orchestrator/control/commands-{agentId}/{timestamp}-{cmdId}.json`
- Each command has a unique ID. Daemon tracks processed command IDs in memory.
- On daemon restart, daemon reads the `processed/` directory to know which commands were already handled → **idempotency**.

### Shell Injection Prevention

- `buildCommand()` returns `string[]` (argument array), never a shell string
- System prompts are written to temp files at `.agent-orchestrator/personas/{agentId}-prompt.md` and passed via `--system-prompt-file` or equivalent flag
- `tmux send-keys` uses the `-l` (literal) flag to prevent escape sequence injection
- `extraArgs` are validated against a per-provider allowlist of safe flags
- Environment variables are set via `tmux set-environment`, not shell interpolation

### .gitignore Automation

On session creation, the daemon automatically:
1. Checks if `.agent-orchestrator/` is already in `.gitignore`
2. If not, appends `.agent-orchestrator/` to `.gitignore`
3. If no `.gitignore` exists, creates one with `.agent-orchestrator/`
4. Logs this action in the session creation event

### Historical Events Endpoint

```
GET /api/v1/sessions/:sid/events?since={ISO timestamp}&limit=100&type={event type}
```

Returns structured event log for catch-up on initial page load:
- All agent spawns, removes, status changes
- All messages between agents
- All task status transitions
- All user interactions

The dashboard uses this on connect to populate the timeline, then switches to WebSocket for live updates.

---

## Implementation Phases

### Phase 1: Daemon Foundation
- Monorepo setup (packages/daemon, packages/dashboard, packages/vscode-extension, **packages/shared**)
- **Shared types package**: SessionConfig, AgentState, AgentMessage, Task, API types (prevents type drift)
- **Daemon lifecycle**: PID file, port discovery, connect-to-existing check, graceful shutdown
- **API authentication**: bearer token generated on start, stored in `~/.agent-orchestrator/daemon.token`
- **API versioning**: all routes under `/api/v1/`, status endpoint returns `{ version, apiVersion }`
- tmux controller (spawn, capture, send-keys with `-l` literal flag, kill)
- **Shell injection prevention**: `buildCommand()` returns `string[]`, system prompts written to files, extraArgs validated against allowlist
- CLI provider interface + Claude Code provider (first provider)
- Session manager (create session from any project folder, persist to registry)
- **Git worktree isolation** (auto-create worktree per agent for git repos; scoped paths for non-git)
- **One-file-per-message** I/O pattern (atomic writes, no race conditions, directory-based routing)
- **Control command idempotency**: track processed command IDs, skip on daemon restart
- Single agent spawn within a session, with model selection
- **Agent health checks**: 5s polling loop, crash detection, `restartPolicy: "on-crash"`, max 3 restarts
- **Terminal streaming via `tmux pipe-pane`**: one pipe per agent, fan-out to multiple WS clients, ring buffer for catchup
- **Quick Start flow**: `agent-orchestrator start ./my-project` → auto-creates session + master agent with smart defaults
- Express server with REST API (sessions, agents)
- Standalone CLI: `agent-orchestrator start`
- `.agent-orchestrator/` runtime directory setup per project + **auto-add to .gitignore**
- **Desktop notifications** (OS-level) when agents complete tasks or need input
- **Autonomy levels** per agent (suggest-only → auto-apply → full-auto)
- **Real-time cost tracking** per agent (parse token usage from CLI output, show $/tokens)
- **`.agent-orchestrator.yml`** per-project config file (default provider, model, rules, knowledge)

### Phase 2: Multi-Agent, Communication & More Providers
- Multiple agents per session
- Message bus with one-file-per-message routing (intra-session)
- Master agent persona with delegation capability
- **Summary-only returns**: workers send structured summaries to master (not full conversation)
- **Editable plan step**: master generates task decomposition → shown in UI → user reviews/edits → then workers execute
- Agent control plane (spawn/remove agents via file-based commands, idempotent)
- Task data model and basic task tracking per session
- Session pause/resume/stop
- Add Codex, Aider, Kiro, Goose providers
- **Budget enforcement**: per-agent and per-session cost limits, auto-pause on overspend
- **Playbooks**: YAML-defined reusable session templates (agent teams + workflows)
- **CLI templates**: `agent-orchestrator start --template fullstack --project ./app`
- **Checkpointing**: periodic state snapshots, resume after crash/restart
- **Project knowledge base**: `.agent-orchestrator/knowledge/` — persistent docs agents read at startup
- **Structured event log**: all events persisted to `.agent-orchestrator/events/` for queryability

### Phase 3: Web Dashboard
- React dashboard app (packages/dashboard)
- All sessions overview page
- Session detail: agent cards with live terminal preview (xterm.js + WebSocket)
- Interactive terminal in browser (bidirectional, via fan-out terminal streams)
- Chat input to send messages to agents
- Spawn/remove agents from browser
- **Seamless takeover**: "Take Control" button → inline Monaco editor, agent pauses
- Communication timeline (populated via **historical events endpoint** on load, then live WS)
- **GET /api/v1/sessions/:sid/events?since=&limit=** for catch-up on initial page load
- Task board (kanban) per session
- **Observability panel**: structured event logs, tool call timeline, token breakdown per agent
- **Plan editor view**: visual display of task decomposition, drag-to-reorder, edit before execute
- Mobile-responsive layout
- **Playbook picker**: browse and launch from saved playbooks
- **WebSocket reconnection**: auto-reconnect with exponential backoff, state sync on reconnect via events endpoint

### Phase 4: VS Code Extension + Multi-Session
- VS Code extension as thin client (connects to daemon)
- **Daemon discovery**: read PID/token files, connect to existing daemon or start new one
- **Reconnection strategy**: detect daemon disconnect, status bar warning, retry every 5s
- **Loading states**: handle "daemon starting up" gracefully (queued commands, loading indicators)
- Sidebar tree view: sessions > agents
- Webview panel embedding the dashboard (passes auth token via postMessage)
- Multiple simultaneous sessions
- Cross-session message routing
- Cross-session activity feed
- Aggregate cost/token tracking across sessions
- **Slack/Discord webhook** notifications for agent status updates
- **File change detection**: watch for external edits, notify agents (Windsurf coherence pattern)

### Phase 5: Advanced Orchestration
- Dependency graph visualization
- Conflict detection (two agents editing same file)
- **Agent forking**: "Try both approaches" — fork agent onto separate branches, compare results (Amp pattern)
- Auto-scaling (spawn more workers as needed)
- Budget limits per agent and per session (auto-stop on overspend)
- **Issue tracker integration**: auto-create sessions from GitHub Issues / Linear / Jira
- **Execution flow graph**: visual trace of agent decisions (LangSmith-style)
- Session presets: "Solo Agent", "Master + 2 Workers", "Full Team"
- Remote access (expose daemon via tunnel for remote monitoring)
- **Cloud agents**: remote execution for long-running tasks
- PWA manifest + push notifications for mobile

---

## Open Questions / Decisions

1. **tmux vs pty.js**: tmux gives us session persistence and the user can manually attach. `node-pty` gives tighter integration but loses persistence. Recommendation: **tmux** (matches Claude Code's own approach).

2. **Message passing**: File-based (simple, agents can read/write naturally) vs WebSocket (faster, but agents can't directly use it). Recommendation: **file-based** since Claude Code agents can read/write files natively.

3. **Agent file isolation**: Should each worker agent operate in its own subdirectory / git worktree to avoid conflicts? Recommendation: **Yes for Phase 5**. For git repos, use worktrees; for plain folders, use copy-on-write subdirectories or scoped allowed-paths per agent.

4. **Agent input method**: Use `tmux send-keys` to type prompts into Claude Code, or use Claude Code's `--print` mode for non-interactive use? Recommendation: **tmux send-keys for interactive, --print for fire-and-forget tasks**.

5. **Dashboard framework**: React with Vite for fast builds. Use xterm.js for terminal rendering. Zustand for state management (lightweight).

6. **Session discovery**: Should sessions auto-detect when the user opens a folder that has `.agent-orchestrator/` in it? Recommendation: **Yes** - if VS Code opens a folder with an existing `.agent-orchestrator/session.json`, offer to resume the session.

7. **Session isolation vs sharing**: Should sessions be fully isolated or should there be a global message bus? Recommendation: **Isolated by default with opt-in cross-session messaging**. Each session is self-contained; cross-session communication requires explicit addressing (`sessionId:agentId`).

8. **CLAUDE.md conflicts**: Injecting a per-agent CLAUDE.md into the project directory will conflict with any existing CLAUDE.md. Options:
   - Use `--system-prompt` flag instead (cleaner, no file conflicts)
   - Place CLAUDE.md in a per-agent subdirectory
   - Use `.agent-orchestrator/personas/{agentId}/CLAUDE.md` and symlink or `--config` flag
   Recommendation: **Use `--system-prompt` flag** for persona injection to avoid touching the project's own CLAUDE.md. Use the `.agent-orchestrator/personas/` directory for longer persona definitions that get loaded and passed via the flag.

9. **Session concurrency limits**: How many sessions/agents can run simultaneously? Recommendation: **No hard limit from our side** - let the user's machine resources be the constraint. Show resource usage (CPU, memory) per session in the dashboard as a soft guide.

10. **CLI provider output parsing**: Each CLI has different output formats. Options:
    - Write custom parsers per provider (most accurate, most work)
    - Use generic heuristics (look for file paths, "editing", "running", etc.)
    - Hybrid: generic base parser + provider-specific overrides
    Recommendation: **Hybrid approach**. A base parser handles common patterns (file paths, command execution). Each provider overrides with specific regex for its output format. The `custom` provider uses the generic parser only.

11. **Provider API keys**: Different CLIs need different API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.). How to manage?
    Recommendation: **Let the user's environment handle it**. The extension reads from the user's shell environment. Optionally, allow per-agent `envVars` override in the config for cases where different agents use different API keys.

12. **Cross-provider communication**: When a Claude Code master spawns an Aider worker, the communication protocol (file-based messaging) must be injected into the worker's persona regardless of provider. This works because all supported CLIs can read/write files. The persona injection mechanism differs per provider (`--system-prompt` vs `--instructions` vs config file), but the CLIProvider interface abstracts this.
