# YAML Playbook Design: Custom Orchestration Team Import System

## Overview

This document designs a YAML-based system for users to define, import, and reuse custom orchestration teams in Kora. Inspired by CrewAI (YAML configs), Devin (Playbooks), and Kilo Code (Skills).

**Current state:** Playbooks are JSON files stored in `~/.kora/playbooks/`, loaded by `playbook-loader.ts`. Three built-in playbooks exist (Solo Agent, Master + 2 Workers, Full Stack Team). The `PlaybookAgent` interface supports: name, role, provider, model, persona, initialTask, extraCliArgs.

**Goal:** Extend the system to support YAML format, richer agent definitions, project-specific playbooks, template variables, and a polished import/export flow.

---

## 1. YAML Schema

### 1.1 Full Schema Definition

```yaml
# Kora Playbook Schema v1
version: 1                          # Schema version (required)

# ── Team Metadata ──
name: "Full Stack Feature Team"     # Display name (required)
description: "..."                  # Human-readable description (required)
author: "jane@company.com"         # Optional author
tags: ["fullstack", "react", "node"] # Optional tags for filtering/search

# ── Session Defaults ──
defaults:
  provider: claude-code             # Default CLI provider for all agents
  model: claude-sonnet-4-6          # Default model for all agents
  worktreeMode: isolated            # "isolated" | "shared" (default: isolated)
  messagingMode: mcp                # "mcp" | "file" (default: mcp)
  autonomyLevel: full               # "supervised" | "assisted" | "full"

# ── Template Variables ──
# Users are prompted to fill these when launching the playbook
variables:
  project_name:
    description: "Name of the project"
    default: "my-app"
  framework:
    description: "Frontend framework"
    default: "React"
    options: ["React", "Vue", "Svelte", "Angular"]  # Optional enum
  api_style:
    description: "API architecture"
    default: "REST"
    options: ["REST", "GraphQL", "tRPC"]

# ── Agent Definitions ──
agents:
  - name: Architect
    role: master                    # "master" | "worker" (required)
    provider: claude-code           # Override defaults.provider
    model: claude-opus-4-6          # Override defaults.model
    persona: |                      # Multi-line persona (optional)
      You are a senior software architect working on {{project_name}}.
      You decompose features into frontend, backend, and test tasks.
      You use {{framework}} for the frontend and {{api_style}} for the API.

      ## Your Responsibilities
      - Break down the user's request into concrete subtasks
      - Assign tasks to Frontend, Backend, and Tests workers
      - Review completed work before marking done
      - Ensure consistent API contracts between frontend and backend
    channels: ["#all", "#architecture"]  # Message channels
    extraCliArgs:                   # Additional CLI flags
      - "--allowedTools"
      - "mcp__kora__spawn_agent"
    envVars:                        # Environment variables
      DEBUG: "true"
    budgetLimit: 5.00               # Max cost in USD (optional)

  - name: Frontend
    role: worker
    model: claude-sonnet-4-6
    persona: |
      You are a {{framework}} frontend specialist working on {{project_name}}.
      Focus on components, styling, and user experience.
      Follow the Architect's task assignments.
    channels: ["#all", "#frontend"]
    initialTask: "Wait for the Architect to assign your first task."

  - name: Backend
    role: worker
    model: claude-sonnet-4-6
    persona: |
      You are a backend specialist working on {{project_name}}.
      Focus on {{api_style}} endpoints, database models, and business logic.
      Follow the Architect's task assignments.
    channels: ["#all", "#backend"]
    initialTask: "Wait for the Architect to assign your first task."

  - name: Tests
    role: worker
    provider: codex               # Different provider
    model: o4-mini
    persona: |
      You write comprehensive tests for {{project_name}}.
      Cover unit tests, integration tests, and edge cases.
    channels: ["#all", "#testing"]

# ── Initial Tasks (Optional) ──
# Tasks created on the task board when the session starts
tasks:
  - title: "Decompose feature request"
    description: "Break down the user's feature into subtasks"
    assignedTo: Architect           # References agent name
    status: todo

  - title: "Set up project structure"
    description: "Initialize {{framework}} project with proper folder structure"
    assignedTo: Frontend
    status: blocked
    dependencies: ["Decompose feature request"]  # References task titles
```

### 1.2 Minimal Schema (Solo Agent)

```yaml
version: 1
name: "Quick Fix"
description: "Single agent for quick bug fixes"
agents:
  - name: Fixer
    role: master
    model: claude-sonnet-4-6
    persona: "You fix bugs quickly and write tests for your fixes."
```

### 1.3 Research Team Example

```yaml
version: 1
name: "Research Team"
description: "Architect researches, analyst synthesizes, writer documents"
tags: ["research", "documentation"]

variables:
  topic:
    description: "Research topic"
  output_format:
    description: "Output format"
    default: "markdown"
    options: ["markdown", "notion", "confluence"]

agents:
  - name: Lead Researcher
    role: master
    model: claude-opus-4-6
    persona: |
      You lead research on: {{topic}}.
      Decompose the research into subtopics and assign to Analyst.
      Synthesize findings and assign documentation to Writer.
    channels: ["#all"]

  - name: Analyst
    role: worker
    model: claude-sonnet-4-6
    persona: |
      You are a research analyst investigating aspects of: {{topic}}.
      Read source material, extract key findings, and report back to Lead Researcher.
    channels: ["#all", "#analysis"]
    extraCliArgs: ["--allowedTools", "WebFetch,Grep,Read"]

  - name: Writer
    role: worker
    model: claude-sonnet-4-6
    persona: |
      You document research findings in {{output_format}} format.
      Create clear, well-structured documents with citations.
    channels: ["#all", "#docs"]
```

---

## 2. Import Mechanism

### Recommended Implementation Order

| Priority | Method | Effort | Description |
|----------|--------|--------|-------------|
| P0 | **A: File discovery** | ~2 hrs | Drop `.yaml` files in `~/.kora/playbooks/` — auto-discovered |
| P0 | **D: Project-specific** | ~1 hr | `.kora/playbooks/*.yaml` in repo root — version-controlled |
| P1 | **C: CLI import** | ~2 hrs | `kora playbook import my-team.yaml` copies to global dir |
| P2 | **B: Dashboard upload** | ~4 hrs | File upload via dashboard UI with preview |

### P0: File Discovery (Options A + D)

The playbook loader scans multiple directories on startup and on API request:

```
Discovery order (last wins on name conflict):
1. Built-in playbooks (bundled with Kora as JSON — existing behavior)
2. Global user playbooks: ~/.kora/playbooks/*.yaml, *.yml, *.json
3. Project playbooks: <projectPath>/.kora/playbooks/*.yaml, *.yml
```

**Implementation:** Extend `playbook-loader.ts` to:
1. Accept both `.json` and `.yaml`/`.yml` extensions
2. Parse YAML files with `js-yaml` (already common in Node ecosystem)
3. Merge results from all discovery directories
4. Tag each playbook with its `source: "builtin" | "global" | "project"`

### P1: CLI Import

```bash
# Import a YAML file to global playbooks
kora playbook import ./my-team.yaml

# Import to project-specific playbooks
kora playbook import ./my-team.yaml --project

# List all playbooks
kora playbook list

# Export current session as playbook
kora playbook export <session-name> -o my-team.yaml
```

### P2: Dashboard Upload

File upload button in the Playbook browser. Accepts `.yaml`/`.yml` files. Shows preview of agents before saving. Calls `POST /api/v1/playbooks` with parsed YAML content.

---

## 3. Storage

### Directory Structure

```
~/.kora/                           # Global config (prod)
  playbooks/
    solo-agent.json                # Built-in (JSON, created by ensureBuiltinPlaybooks)
    master-2-workers.json          # Built-in
    full-stack-team.json           # Built-in
    my-custom-team.yaml            # User-created (YAML)
    research-team.yml              # User-created (YAML)

<project-root>/
  .kora/
    playbooks/
      feature-team.yaml            # Project-specific, version-controlled
      migration-team.yaml          # Project-specific
```

### Precedence (name conflicts)

When multiple playbooks have the same slugified name:

```
1. Project playbooks   (highest priority — closest to the work)
2. Global playbooks    (user customization)
3. Built-in playbooks  (lowest priority — defaults)
```

### Storage Format

- **New playbooks**: Always stored as YAML (human-readable, easy to edit)
- **Existing JSON playbooks**: Continue to work (backward compatible)
- **Internal representation**: Parsed to `Playbook` TypeScript interface regardless of source format
- **No database storage**: Playbooks are files — simple, portable, version-controllable

### Extended Playbook Interface

```typescript
// Extends existing Playbook interface
export interface PlaybookV2 {
  version: 1;
  name: string;
  description: string;
  author?: string;
  tags?: string[];

  defaults?: {
    provider?: string;
    model?: string;
    worktreeMode?: WorktreeMode;
    messagingMode?: MessagingMode;
    autonomyLevel?: AutonomyLevel;
  };

  variables?: Record<string, {
    description: string;
    default?: string;
    options?: string[];      // Enum constraint
    required?: boolean;      // Default: true if no default
  }>;

  agents: PlaybookAgentV2[];

  tasks?: PlaybookTask[];

  // Metadata (set by system, not user)
  source?: "builtin" | "global" | "project";
  filePath?: string;
}

export interface PlaybookAgentV2 {
  name: string;
  role: "master" | "worker";
  provider?: string;         // Overrides defaults.provider
  model?: string;            // Overrides defaults.model (required if no defaults.model)
  persona?: string;
  autonomyLevel?: AutonomyLevel;
  channels?: string[];
  extraCliArgs?: string[];
  envVars?: Record<string, string>;
  initialTask?: string;
  budgetLimit?: number;
  workingDirectory?: string; // Relative to project root
}

export interface PlaybookTask {
  title: string;
  description?: string;
  assignedTo?: string;       // Agent name reference
  status?: "todo" | "in-progress" | "blocked";
  dependencies?: string[];   // Task title references
}
```

### Backward Compatibility

The loader detects format by:
1. File extension: `.yaml`/`.yml` → parse as YAML, `.json` → parse as JSON
2. Content: If parsed object has `version: 1`, treat as V2 schema
3. If no `version` field, treat as legacy V1 (current `Playbook` interface)
4. V1 playbooks are upconverted to V2 in memory (no file modification)

---

## 4. Dashboard UI

### 4.1 Playbook Browser (Enhanced Session Creation)

```
┌─────────────────────────────────────────────────────────┐
│  Create New Session                                      │
│                                                          │
│  Session Name: [my-feature-session        ]              │
│  Project Path: [/Users/jane/projects/app  ] [Browse]     │
│                                                          │
│  ── Choose a Playbook ──────────────────────────────────│
│                                                          │
│  [Search playbooks...]              [Upload YAML] [+New] │
│                                                          │
│  ┌──────────────────┐ ┌──────────────────┐               │
│  │ Solo Agent    ⚙️  │ │ Full Stack Team  │               │
│  │ Built-in         │ │ Built-in         │               │
│  │ 1 agent          │ │ 4 agents         │               │
│  │ Simple tasks     │ │ Arch+FE+BE+Test  │               │
│  └──────────────────┘ └──────────────────┘               │
│  ┌──────────────────┐ ┌──────────────────┐               │
│  │ Research Team 📁 │ │ My Custom    📁  │               │
│  │ Global           │ │ Project          │               │
│  │ 3 agents         │ │ 5 agents         │               │
│  │ Research + Docs  │ │ Custom workflow  │               │
│  └──────────────────┘ └──────────────────┘               │
│                                                          │
│  Source: ⚙️ Built-in  📁 Global  📂 Project              │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Playbook Preview (Before Launch)

When a playbook is selected, show a preview panel:

```
┌─────────────────────────────────────────────────────────┐
│  Full Stack Feature Team                    [Edit YAML]  │
│  "Architect + Frontend + Backend + Tests"                │
│  Tags: fullstack, react, node                            │
│  Source: Global (~/.kora/playbooks/)                     │
│                                                          │
│  ── Fill Variables ─────────────────────────────────────│
│  Project Name:  [my-app          ]                       │
│  Framework:     [React        ▾]  (React/Vue/Svelte)     │
│  API Style:     [REST         ▾]  (REST/GraphQL/tRPC)    │
│                                                          │
│  ── Agents (4) ─────────────────────────────────────────│
│  ┌─────────────────────────────────────────────────────┐│
│  │ ● Architect    master   claude-code/opus-4-6    $5  ││
│  │ ● Frontend     worker   claude-code/sonnet-4-6      ││
│  │ ● Backend      worker   claude-code/sonnet-4-6      ││
│  │ ● Tests        worker   codex/o4-mini               ││
│  └─────────────────────────────────────────────────────┘│
│                                                          │
│  ── Initial Tasks (2) ──────────────────────────────────│
│  □ Decompose feature request → Architect                 │
│  □ Set up project structure → Frontend (blocked)         │
│                                                          │
│  [Cancel]                              [Launch Session]  │
└─────────────────────────────────────────────────────────┘
```

### 4.3 YAML Editor (Monaco)

When "Edit YAML" is clicked, show a Monaco editor with:
- YAML syntax highlighting
- Schema validation (red squiggles on invalid fields)
- Auto-complete for known fields (role, provider, model)
- Live preview of parsed agents on the right side
- Save button that writes back to the playbook file

### 4.4 Export Session as Playbook

In the session detail page, add an "Export as Playbook" button:
- Generates YAML from current session config + agents
- Opens Monaco editor with the generated YAML for review
- User can edit name/description, then save to global or project playbooks
- Also offers "Download as .yaml" for sharing

---

## 5. Validation

### 5.1 Validation Rules

```typescript
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];   // Must be empty to proceed
  warnings: ValidationWarning[]; // Informational, don't block
}

interface ValidationError {
  path: string;      // e.g., "agents[0].role"
  message: string;
  code: string;
}
```

**Required field rules:**
| Field | Required | Validation |
|-------|----------|------------|
| `version` | Yes | Must be `1` |
| `name` | Yes | Non-empty string, max 100 chars |
| `description` | Yes | Non-empty string, max 500 chars |
| `agents` | Yes | Non-empty array, at least 1 agent |
| `agents[].name` | Yes | Non-empty, unique within playbook, max 50 chars |
| `agents[].role` | Yes | Must be `"master"` or `"worker"` |
| `agents[].model` | Conditional | Required if no `defaults.model` |
| `agents[].provider` | No | Falls back to `defaults.provider` then `"claude-code"` |

**Semantic rules:**
- At most one agent with `role: master` (warning, not error — some teams have no master)
- If `variables` are defined, all `{{var}}` references in personas/tasks must have matching variable definitions
- `channels` values should start with `#` (warning if not)
- `extraCliArgs` values should start with `--` (warning if not)
- `budgetLimit` must be positive number
- `tasks[].assignedTo` must reference an existing agent name
- `tasks[].dependencies` must reference existing task titles
- No circular task dependencies

**Unknown field warnings:**
- Any field not in the schema produces a warning (not error) — forward compatibility

### 5.2 Validation Function

```typescript
export function validatePlaybook(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // ... type checks, required fields, semantic rules ...

  return { valid: errors.length === 0, errors, warnings };
}
```

Validation runs:
1. On file load (during discovery) — invalid playbooks are skipped with console warning
2. On API import (`POST /playbooks`) — returns 400 with validation errors
3. On dashboard upload — shows errors inline before saving
4. On CLI import — prints errors to stderr

---

## 6. API Endpoints

### Updated Endpoints

```
GET    /api/v1/playbooks
  Query: ?source=builtin|global|project&tags=react,node&search=full+stack
  Response: {
    playbooks: [{
      name, description, slug, source, agentCount, tags, hasVariables
    }]
  }

GET    /api/v1/playbooks/:slug
  Response: Full PlaybookV2 object (parsed from YAML/JSON)

POST   /api/v1/playbooks
  Body: { yaml: string } | PlaybookV2 object
  Validates, saves to global playbooks dir
  Response: 201 { playbook: PlaybookV2 }

PUT    /api/v1/playbooks/:slug
  Body: { yaml: string } | PlaybookV2 object
  Updates existing playbook (only global/project, not built-in)
  Response: 200 { playbook: PlaybookV2 }

DELETE /api/v1/playbooks/:slug
  Deletes a custom playbook (only global/project, not built-in)
  Response: 204

POST   /api/v1/playbooks/validate
  Body: { yaml: string }
  Response: { valid, errors, warnings }

POST   /api/v1/sessions/:sid/export-playbook
  Generates a PlaybookV2 YAML from current session config
  Response: { yaml: string, playbook: PlaybookV2 }
```

### Session Creation with Playbook Variables

The existing `POST /api/v1/sessions` is extended:

```typescript
interface CreateSessionRequest {
  name: string;
  projectPath: string;
  playbook?: string;                    // Playbook slug
  playbookVariables?: Record<string, string>; // Variable values
  // ... existing fields ...
}
```

When `playbook` is specified:
1. Load and validate the playbook
2. Resolve variables (merge user-provided values with defaults)
3. Interpolate `{{var}}` placeholders in personas, tasks, descriptions
4. Create session with playbook defaults
5. Spawn all agents defined in the playbook
6. Create initial tasks if defined

---

## 7. Implementation Plan

### Phase 1: Core YAML Support (P0, ~6 hours)

| Task | Effort | Description |
|------|--------|-------------|
| Add `js-yaml` dependency | 15 min | `npm install js-yaml @types/js-yaml` |
| Extend `PlaybookV2` types | 30 min | Add to `@kora/shared` types |
| Update `playbook-loader.ts` | 2 hrs | YAML parsing, multi-dir discovery, V1 compat |
| Add validation function | 1.5 hrs | `validatePlaybook()` with all rules |
| Template variable interpolation | 1 hr | `{{var}}` replacement in string fields |
| Update API routes | 1 hr | Extend GET/POST /playbooks for YAML |

### Phase 2: CLI + Project Playbooks (P1, ~3 hours)

| Task | Effort | Description |
|------|--------|-------------|
| `kora playbook` CLI subcommands | 1.5 hrs | import, list, export |
| Project-specific discovery | 30 min | Scan `<projectPath>/.kora/playbooks/` |
| Session creation with playbook | 1 hr | Variable resolution + agent spawning |

### Phase 3: Dashboard UI (P2, ~8 hours)

| Task | Effort | Description |
|------|--------|-------------|
| Playbook browser cards | 2 hrs | Source indicator, tags, agent count |
| Variable input form | 1.5 hrs | Dynamic form from playbook variables |
| Playbook preview panel | 1.5 hrs | Agent list, task list, before launch |
| YAML editor (Monaco) | 2 hrs | Syntax highlighting, validation |
| Export session as playbook | 1 hr | Generate YAML from session |

### Phase 4: Polish (P3, ~3 hours)

| Task | Effort | Description |
|------|--------|-------------|
| YAML schema JSON Schema | 1 hr | For Monaco auto-complete + external validation |
| Playbook sharing (copy URL) | 1 hr | Encode small playbooks in URL params |
| Built-in playbooks as YAML | 1 hr | Migrate existing JSON builtins to YAML |

**Total estimated effort: ~20 hours (2-3 days)**

---

## 8. Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `js-yaml` | YAML parsing/serialization | 45KB |
| `@types/js-yaml` | TypeScript types | Dev only |

No other new dependencies needed. Monaco editor is already in the dashboard for the EditorTile feature.

---

## 9. Migration Path

1. **No breaking changes**: Existing JSON playbooks continue to work
2. **Gradual migration**: Built-in playbooks can be migrated from JSON to YAML in Phase 4
3. **`ensureBuiltinPlaybooks()`**: Updated to check for both `.json` and `.yaml` versions
4. **Dashboard**: Shows all playbooks regardless of format, with a "source" badge

---

## 10. Security Considerations

- **YAML parsing**: Use `js-yaml`'s `safeLoad` (default) — no code execution
- **Variable interpolation**: Only replaces `{{var}}` patterns — no eval/template literals
- **File paths**: Playbook file paths are sanitized (no `../` traversal)
- **Budget limits**: Enforced at runtime, not just in playbook definition
- **envVars**: Validated against an allowlist of safe environment variables (no PATH, HOME, etc.)
- **extraCliArgs**: Validated against existing CLI arg allowlist (existing feature)
