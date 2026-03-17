# Feature Gap Analysis: Agent Orchestrator vs The Competition

## Competitors Analyzed

| Tool | Type | Key Strength |
|------|------|-------------|
| **Claude Squad** | Terminal TUI | Git worktree isolation, multi-CLI support |
| **Roo Code (Boomerang)** | VS Code Extension | Mode-based orchestration, context isolation |
| **Kilo Code** | VS Code + JetBrains | Agent Manager (parallel), Cloud Agents, Memory Bank, Orchestrator Mode |
| **Cline** | VS Code Extension | Checkpoints/restore, human-in-the-loop approval, cost tracking |
| **CrewAI** | Python Framework | YAML config, hierarchical process, observability |
| **AutoGen (Microsoft)** | Python Framework | AutoGen Studio (no-code GUI), team topologies |
| **LangGraph** | Framework | State machines, checkpointing, human-in-the-loop |
| **OpenHands** | Platform | Cloud scaling (1000s of agents), SDK, GUI+CLI |
| **Cursor** | IDE | Background agents, task board, checkpoint rewind, autonomy slider |
| **Devin** | Autonomous Agent | Slack-first, AGENTS.md, Playbooks, Session Insights |
| **Amp (Sourcegraph)** | CLI Agent | Thread branching, Oracle/Librarian specialists, thread sharing |
| **Factory AI** | Enterprise Platform | Droids on every surface, War Room (Slack), CLI parallelization |
| **Copilot Workspace** | GitHub (sunset) | Spec → Plan → Implement editable pipeline, Brainstorm Agent |
| **Windsurf Cascade** | IDE | Coherence engine (tracks manual edits between AI interactions) |

---

## Feature Comparison Matrix

### Legend: Y = Has it | P = Partial | N = Missing | -- = N/A

| Feature | Ours (Design) | Claude Squad | Roo Code | Kilo Code | Cline | CrewAI | Cursor | Devin | Amp | Factory |
|---------|---------------|-------------|----------|-----------|-------|--------|--------|-------|-----|---------|
| **Multi-agent orchestration** | Y | Y | Y | Y | N | Y | P | N | P | Y |
| **Browser dashboard** | Y | N | N | N | N | N | N | Y | N | Y |
| **VS Code integration** | Y | N | Y | Y | Y | N | Y (native) | P | P | Y |
| **CLI standalone mode** | Y | Y (TUI) | N | Y | N | Y | N | N | Y | Y |
| **Pluggable CLI providers** | Y | Y | N | N | N | -- | N | N | N | P |
| **Inter-agent messaging** | Y | N | P | P | N | Y | N | N | P | N |
| **Agent spawn/remove (dynamic)** | Y | Y | Y | Y | N | N | N | N | N | N |
| **Agent-initiated spawn** | Y | N | N | P | N | P | N | N | N | N |
| **User direct agent interaction** | Y | Y | Y | Y | Y | N | P | Y | Y | Y |
| **Interactive terminal (browser)** | Y | N | N | N | N | N | N | Y | N | N |
| **Task board (kanban)** | Y | N | N | N | N | N | Y | N | N | P |
| **Cross-project sessions** | Y | N | N | N | N | N | N | N | N | N |
| **Git worktree isolation** | **N (GAP!)** | Y | N | N | N | N | N | N | N | N |
| **Communication timeline** | Y | N | N | N | N | P | N | N | N | N |
| **Mobile responsive** | Y | N | N | Y | N | N | N | Y | N | N |
| **Cost tracking per agent** | **N (GAP!)** | N | P | Y | Y | N | N | N | P | N |
| **Model per agent** | Y | Y | Y (per mode) | Y (Auto Model) | N | Y | Y | N | Y | P |
| **Checkpoints / rewind** | **N (GAP!)** | N | N | N | Y | N | Y | N | N | N |
| **Editable plan before exec** | **N (GAP!)** | N | N | N | N | N | N | N | N | N |
| **Memory / knowledge persist** | **N (GAP!)** | N | N | Y (Memory Bank) | N | N | N | Y (Knowledge) | N | N |
| **Cloud agents (remote exec)** | N | N | N | Y | N | N | Y (Background) | Y | N | Y |
| **Coherence (track manual edits)** | **N (GAP!)** | N | N | N | N | N | N | N | N | N |
| **Thread branching / forking** | **N (GAP!)** | N | N | N | N | N | N | N | Y | N |
| **Playbooks / reusable workflows** | P (Phase 2) | N | N | Y (Skills) | N | N | N | Y (Playbooks) | N | N |
| **AGENTS.md / repo config** | **N (GAP!)** | N | Y (.roomodes) | Y | Y (.clinerules) | N | N | Y (AGENTS.md) | N | N |
| **Slack/Teams integration** | P (Phase 4) | N | N | Y | N | N | N | Y | N | Y |
| **Issue tracker integration** | P (Phase 5) | N | N | N | N | N | N | Y | N | Y |

---

## What Competitors Do BETTER Than Us (Gaps to Close)

### 1. Git Worktree Isolation (Claude Squad) — CRITICAL GAP

**What they do:** Claude Squad creates a git worktree per agent automatically. Each agent works on its own branch with zero conflict risk. This is the #1 most-loved feature.

**Our gap:** We defer this to Phase 5. This should be **Phase 1 or 2** — it's table stakes for multi-agent file editing.

**Recommendation:** Move git worktree support to Phase 1. Make it the default for git repos (opt-out, not opt-in). For non-git folders, use scoped path restrictions.

---

### 2. Zero-Config Quick Start (Cursor, Devin, Claude Squad)

**What they do:**
- **Cursor**: One click to start an agent. Autonomy slider to control how much freedom it has.
- **Claude Squad**: `n` to create a session, type a prompt, done.
- **Devin**: Tag @devin in Slack with a task. That's it.

**Our gap:** Our design requires the user to: create a session → pick a folder → add a master agent → pick a provider → pick a model → set a persona → THEN add workers. Too many steps for a first-time user.

**Recommendation:** Add a **Quick Start flow**:
- "Start agents on this folder" → auto-creates session with sensible defaults (1 master agent, default provider, best available model)
- One-click "Add worker" with smart defaults
- Preset templates: "Solo Agent", "Master + 2 Workers", "Full Team (5 agents)"
- The master agent should auto-spawn workers based on the task (user doesn't manually create them)

---

### 3. Autonomy Slider / Approval Controls (Cursor, Roo Code)

**What they do:**
- **Cursor**: A literal slider from "suggest only" → "auto-apply everything"
- **Roo Code Boomerang**: Subtask creation requires approval by default, with auto-approve toggle

**Our gap:** We have no concept of approval gates or autonomy levels. Agents just run freely.

**Recommendation:** Add per-agent autonomy levels:
```
Level 0: Suggest Only — agent proposes changes, user must approve each one
Level 1: Auto-read, ask to write — can explore codebase but asks before editing
Level 2: Auto-apply, ask before commit — edits files freely but asks before git operations
Level 3: Full Auto — does everything including git operations
```
Show this as a slider on each agent card. Master agents should require approval for spawning new agents at Level 0-1.

---

### 4. Context Isolation Between Parent/Child (Roo Code Boomerang) — KEY INSIGHT

**What they do:** Boomerang's killer design: when a subtask completes, only a **summary** flows back to the parent — not the full conversation, diffs, or tool calls. This prevents "context poisoning" where the orchestrator gets overwhelmed with implementation details.

**Our gap:** Our message bus sends full messages between agents. The master agent will get flooded with detailed output from all workers.

**Recommendation:** Implement **summary-only return** as the default for task completion:
- When a worker completes a task, it writes a structured summary (what changed, which files, key decisions)
- The master only sees this summary, not the full conversation
- The full conversation is available on-demand (master can request details if needed)
- This keeps the master's context clean for high-level orchestration

---

### 5. Async / Notification-First Workflow (Devin, Factory)

**What they do:**
- **Devin**: You give it a task, close your laptop, get a Slack notification when the PR is ready
- **Factory**: Droids auto-trigger from issue assignments in Jira/Linear

**Our gap:** Our design assumes the user is actively watching the dashboard. No push notifications, no integration with issue trackers or chat tools.

**Recommendation:** Add notification channels:
- **Desktop notifications** (via VS Code or OS-level) when agents complete tasks or need input
- **Slack/Discord webhook** integration for status updates
- **Issue tracker integration**: pull tasks from GitHub Issues / Linear / Jira, auto-assign to agents
- **Email digest** option for long-running sessions

---

### 6. Observability & Tracing (CrewAI, LangGraph, LangSmith)

**What they do:**
- **CrewAI**: Full tracing and observability — metrics, logs, traces per agent
- **LangGraph + LangSmith**: Execution path visualization, state transitions, runtime metrics
- **AutoGen Studio**: Visual workflow builder with step-by-step execution display

**Our gap:** We capture terminal output and parse it, but we don't have structured tracing of agent decisions, tool calls, token usage breakdowns, or execution flow visualization.

**Recommendation:** Add an **observability layer**:
- Structured event log per agent (not just raw terminal output)
- Tool call timeline: which tools were called, in what order, how long each took
- Token usage breakdown per tool call / per conversation turn
- Execution flow graph: visual trace of what the agent did step-by-step
- Export to OpenTelemetry for integration with external observability tools

---

### 7. Checkpointing & Resume (LangGraph) — IMPORTANT FOR LONG TASKS

**What they do:** LangGraph persists agent state at every step. If an agent crashes, it resumes from exactly where it left off. No work is lost.

**Our gap:** If a tmux session dies or the machine reboots, all agent state is lost. We persist session configs but not agent conversation state.

**Recommendation:**
- Save tmux scrollback to disk periodically (tmux `save-buffer`)
- Persist agent state snapshots (current task, files modified, messages sent)
- On restart, offer to "Resume session" — re-spawns agents and feeds them a recap of what they were doing
- Store the last N messages from each agent's conversation for recovery

---

### 8. Playbooks / Templates / Reusable Workflows (Devin, Factory)

**What they do:**
- **Devin**: Knowledge system where you teach it patterns. "For migrations, always do X then Y"
- **Factory**: Droids can be configured with reusable workflows triggered by events

**Our gap:** No concept of saved workflows or reusable agent configurations beyond "session templates" in Phase 5.

**Recommendation:** Add **Playbooks** (Phase 3):
```yaml
# playbooks/full-stack-feature.yaml
name: "Full Stack Feature"
description: "Implement a feature end-to-end"
agents:
  - name: Architect
    role: master
    provider: claude-code
    model: claude-opus-4-6
    persona: "You are a senior architect. Decompose the feature into frontend/backend/test tasks."
  - name: Frontend
    role: worker
    provider: claude-code
    model: claude-sonnet-4-6
    persona: "You are a React specialist."
  - name: Backend
    role: worker
    provider: claude-code
    model: claude-sonnet-4-6
    persona: "You are a Node.js/Express specialist."
  - name: Tests
    role: worker
    provider: codex
    model: o4-mini
    persona: "You write comprehensive tests."
steps:
  - assign: "Architect decomposes the task"
  - parallel: ["Frontend works on UI", "Backend works on API"]
  - after: "Tests writes tests for both"
```
Users pick a playbook, enter the task description, and it auto-sets up the entire session.

---

### 9. Multi-Surface Presence (Factory, Devin)

**What they do:**
- **Factory**: Available on IDE, CLI, Slack, Teams, browser, and project manager — 5 surfaces
- **Devin**: Slack, Teams, Linear, Jira, IDE extension, web, mobile

**Our gap:** We have VS Code + browser. No chat platform integration, no issue tracker integration, no mobile app.

**Recommendation:** Phase 4+ add:
- Slack bot (receive task assignments, send status updates)
- GitHub Actions integration (trigger agents from CI/CD events)
- Linear/Jira webhook (auto-create session from new issue)
- Progressive Web App (PWA) for mobile — the dashboard already works in mobile browser, just add PWA manifest + push notifications

---

### 10. Real-Time Takeover (Devin, Cursor)

**What they do:**
- **Devin**: User can "take over Devin's editor, shell, or browser at any time"
- **Cursor**: Seamless transition between AI agent and human editing

**Our gap:** We have terminal attach (tmux) and chat input, but no smooth "take control" experience. tmux attach is jarring — it's a full terminal switch.

**Recommendation:** Add a **seamless takeover mode** in the dashboard:
- "Take Control" button on agent card → opens an inline editor (Monaco) showing the agent's current file
- User edits directly, agent sees the changes when it resumes
- "Hand Back" button to let the agent continue
- While user is in control, the agent pauses (no competing edits)
- Show a visual indicator: "You are in control of Agent X"

---

### 11. Editable Plan Before Execution (Copilot Workspace) — UX GOLD

**What they did:** Copilot Workspace (now sunset) had the most structured planning UI: Spec → Plan → Implement. Each step was **editable by the user** before proceeding. You could see exactly which files would change, what the changes would be, and modify the plan before any code was written.

**Our gap:** Our master agent decomposes tasks and delegates immediately. The user has no chance to review or edit the plan before workers start executing.

**Recommendation:** Add an **editable plan step**:
- Master agent generates a decomposition plan (task list, agent assignments, dependencies)
- Plan is shown in the dashboard as an editable document
- User can add/remove/reorder tasks, change agent assignments, modify descriptions
- User clicks "Execute Plan" to start the workers
- This builds trust: users see what will happen before it happens
- Optional: skip this step in "Full Auto" autonomy level

---

### 12. Memory Bank / Persistent Knowledge (Kilo Code, Devin) — TRUST BUILDER

**What they do:**
- **Kilo Code Memory Bank**: Stores architectural decisions, preferences, session history. You never re-explain your project.
- **Devin Knowledge**: Users teach Devin patterns. "For migrations, always do X then Y." Persists across sessions.

**Our gap:** Each agent session starts fresh. No cross-session memory, no learning from past tasks.

**Recommendation:** Add a **project knowledge base** per session:
- `.agent-orchestrator/knowledge/` directory with markdown files
- Agents read these at startup as part of their context
- User and agents can contribute to the knowledge base
- Examples: "This project uses Tailwind CSS", "API endpoints follow REST convention in /api/v2/", "Never modify config/production.yml"
- The master agent's persona includes instructions to check knowledge base before planning

---

### 13. Coherence Engine — Track Manual Edits (Windsurf Cascade) — UNIQUE INSIGHT

**What they do:** Windsurf's "coherence engine" notices when the user manually edits files between AI interactions. The AI doesn't lose context — it adapts to what you changed by hand.

**Our gap:** If a user manually edits a file while an agent is working, the agent is unaware and may overwrite the changes or produce conflicting edits.

**Recommendation:** Add **file change detection** per agent:
- Watch the working directory for changes not made by the agent
- When external changes are detected, notify the agent via its inbox: "User modified src/App.tsx lines 15-30"
- The agent can then re-read the file and adapt
- Show in the timeline: "External edit detected on src/App.tsx"

---

### 14. Thread Branching / Forking (Amp) — EXPLORATION PATTERN

**What they do:** Amp lets you fork a thread to explore a different approach. If it doesn't work, you discard the fork. If it does, you merge it back.

**Our gap:** Agents work linearly. No way to explore multiple approaches in parallel and pick the best one.

**Recommendation:** Add **agent forking** (Phase 3+):
- "Fork Agent" button on agent card → creates a copy of the agent with the same context on a new git branch
- User gives each fork a different approach: "Try approach A: use Redux" / "Try approach B: use Zustand"
- Both forks work in parallel (separate worktrees)
- User reviews both, picks the winner, discards the other
- Great for architectural decisions where you want to see both options implemented

---

### 15. AGENTS.md / Per-Repo Config (Devin, Cline, Kilo Code) — TABLE STAKES

**What they do:**
- **Devin**: `AGENTS.md` in repo root configures how Devin behaves for that project
- **Cline**: `.clinerules` file for project-specific behavior rules
- **Kilo Code / Roo Code**: `.roomodes` for mode definitions, `.roorules-*` for per-mode rules

**Our gap:** We use `--system-prompt` for personas but have no per-project config file that persists in the repo.

**Recommendation:** Support an `.agent-orchestrator.yml` config file in the project root:
```yaml
# .agent-orchestrator.yml — checked into git, shared with team
default_provider: claude-code
default_model: claude-sonnet-4-6
knowledge:
  - "This is a Next.js 15 app with App Router"
  - "Use Tailwind CSS for all styling"
  - "Tests use Vitest + React Testing Library"
rules:
  - "Never modify .env files"
  - "Always run 'npm test' after modifying source files"
  - "Follow existing code patterns — don't introduce new libraries without asking"
agents:
  master:
    model: claude-opus-4-6
    persona: "You are a senior architect familiar with this codebase..."
  default_worker:
    model: claude-sonnet-4-6
    autonomy: 2  # auto-apply, ask before commit
```
This file is version-controlled, so the whole team shares the same agent configuration.

---

### 16. Real-Time Cost Tracking Per Agent (Cline, Kilo Code) — TRANSPARENCY

**What they do:**
- **Cline**: Shows token usage AND dollar cost per task in real-time, right in the UI
- **Kilo Code**: Cost tracking with Auto Model routing to optimize spend

**Our gap:** We mention cost tracking in Phase 5 but it's not in the core design. Users need to see costs NOW, not as a late-phase feature.

**Recommendation:** Move cost tracking to **Phase 1**:
- Parse token usage from CLI output (Claude Code shows this)
- Calculate cost based on model pricing (maintain a pricing table per provider)
- Show on each agent card: "Tokens: 12.4k in / 3.2k out | Cost: $0.42"
- Session-level aggregate: "Total session cost: $2.15"
- Set budget limits per agent and per session: "Stop agent if cost exceeds $5"

---

## What We Do BETTER Than Everyone

| Feature | Why it's unique |
|---------|----------------|
| **Cross-project sessions** | Nobody does this. Running agents across multiple repos with cross-session messaging is novel. |
| **Pluggable CLI providers** | Only Claude Squad supports multiple CLIs, but not with a formal provider interface. We have the cleanest abstraction. |
| **Agent-initiated dynamic spawn** | Roo Boomerang creates subtasks, but our control plane lets agents autonomously spawn other agents with full lifecycle. |
| **Browser-first interactive terminals** | Devin has browser terminals but it's proprietary SaaS. We're the only open-source tool with bidirectional browser terminals. |
| **Mixed provider sessions** | Nobody lets you run Claude Code master + Codex worker + Aider worker in the same session. |
| **Full REST API** | Most tools are locked into their UI. Our API-first design enables custom integrations, scripting, and automation. |

---

## Priority Recommendations (What to Add to Our Design)

### Must-Have (add before Phase 1 starts)

1. **Git worktree isolation** — move from Phase 5 to Phase 1 (Claude Squad's #1 feature)
2. **Quick Start flow** — one-click session with smart defaults
3. **Autonomy levels** — per-agent slider (suggest → auto-apply → full auto)
4. **Cost tracking per agent** — real-time tokens + dollars, budget limits (Cline/Kilo Code table stakes)
5. **Desktop notifications** — alert when agents complete or need input
6. **`.agent-orchestrator.yml`** — per-project config file (like AGENTS.md/clinerules)

### Should-Have (add to Phase 2-3)

7. **Summary-only returns** — prevent context poisoning in master agent (Boomerang insight)
8. **Editable plan before execution** — show decomposition, let user modify before workers start (Copilot Workspace)
9. **Playbooks** — reusable YAML session templates with predefined agent teams
10. **Checkpointing & resume** — survive crashes and restarts (LangGraph)
11. **Project knowledge base** — `.agent-orchestrator/knowledge/` persistent across sessions (Kilo Code/Devin)
12. **Observability panel** — structured event logs, tool call timeline, token breakdown
13. **Seamless takeover** — inline editor for taking control from an agent

### Nice-to-Have (Phase 4-5)

14. **Coherence engine** — detect external file changes, notify agents (Windsurf)
15. **Thread/agent forking** — explore multiple approaches in parallel (Amp)
16. **Slack webhook notifications** — push updates to chat platforms
17. **Issue tracker integration** — auto-create sessions from GitHub Issues / Linear / Jira
18. **PWA for mobile** — push notifications + mobile-optimized dashboard
19. **Execution flow graph** — visual trace of agent decisions (like LangSmith)
20. **Cloud agents** — remote execution for long-running tasks (Kilo Code/Cursor Background Agents)

---

## UX Lessons From The Best

### From Cursor: "Make it feel magical"
- The autonomy slider is genius. One control that says "how much do you trust the AI?"
- Background agents with a task board view — users see progress without watching a terminal
- Agent work is "Ready for Review" — framed as collaboration, not automation

### From Devin: "Async is the future"
- Users don't want to watch agents work. They want to fire and forget.
- Slack-first means meeting users where they already are
- "Ticket → Plan → Test → PR" is a clear, predictable pipeline that builds trust

### From Roo Code Boomerang: "Context isolation is everything"
- The orchestrator should NEVER see implementation details
- Summary-only returns keep the master agent sharp
- Deliberately limiting the orchestrator's tools (no file read/write) is counter-intuitive but brilliant

### From Claude Squad: "Isolation prevents chaos"
- Git worktrees are non-negotiable for multi-agent file editing
- A simple TUI proves you don't need a fancy UI to be useful
- Profile system (named configs for different CLIs) is elegant

### From CrewAI: "YAML makes teams accessible"
- Defining agents and tasks in YAML lowers the barrier dramatically
- Sequential vs Hierarchical process types give users mental models
- Role/Goal/Backstory framework for agent personas is intuitive

### From LangGraph: "Durability builds trust"
- If an agent crashes and you lose all its work, users lose trust permanently
- Checkpointing every state transition means zero work is ever lost
- Human-in-the-loop at any point (not just start/end) is essential

### From Factory: "Be everywhere"
- The same agent accessible from IDE, CLI, Slack, browser, and PM tools
- Users shouldn't have to context-switch to interact with agents
- Enterprise = security + scale + traceability

### From Copilot Workspace: "Let users steer the plan"
- Showing Spec → Plan → Code with editable steps at each stage builds trust
- Users supply crucial info that improves output quality
- Review is easier when you have clear expectations of what should change
- The "Brainstorm Agent" for discussing ideas before committing = reducing costly mistakes

### From Kilo Code: "Memory is loyalty"
- Memory Bank means users never re-explain their project — this is a retention killer
- Cross-device sessions (start on mobile, finish in IDE) = modern expectation
- Auto Model routing (smart model selection per task) saves money without user effort
- Skills (shareable expertise packages) = community flywheel

### From Windsurf: "Notice what the human does"
- The coherence engine is the most underrated innovation in this space
- AI that adapts to your manual edits feels like a true collaborator
- Most tools treat human edits as invisible — that's a trust-breaking disconnect

### From Amp: "Exploration needs branching"
- Thread forking for "try both approaches" is how real engineers think
- Thread sharing with teammates = collaborative AI, not solo AI
- Cross-repo code intelligence (via Sourcegraph) gives massively better context

### From Cline: "Transparency wins trust"
- Showing token count AND dollar cost per task — users feel in control of spend
- Checkpoints with one-click restore — "undo" for AI, massively reduces anxiety
- Human-in-the-loop approval for each action — the gold standard for trust
- `.clinerules` file = team-wide AI behavior config, version-controlled
