# .kora.yml Configuration Reference

Per-project configuration for Kora. Place a `.kora.yml` file in your project root to customize agent behavior, models, and rules for that specific project.

## File Location

```
your-project/
  .kora.yml          # Primary (YAML format)
  .kora.json         # Fallback (JSON format)
  src/
  ...
```

Kora checks for `.kora.yml` first, then falls back to `.kora.json`. If neither exists, default settings are used.

## Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default_provider` | string | `"claude-code"` | CLI provider for all agents (`claude-code`, `aider`, `codex`, `kiro`, `goose`) |
| `default_model` | string | Provider default | Model override for all agents (e.g., `claude-sonnet-4-6`) |
| `knowledge` | string[] | `[]` | Short knowledge statements injected into every agent's persona |
| `rules` | string[] | `[]` | Rules all agents must follow (appended to persona) |
| `agents` | object | — | Agent-specific overrides |
| `agents.master` | object | — | Override settings for master/orchestrator agent |
| `agents.default_worker` | object | — | Default settings for all worker agents |

### Agent Override Fields

Each agent override (`agents.master`, `agents.default_worker`) supports:

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Model override for this agent role |
| `persona` | string | Custom persona/system prompt text |
| `autonomy` | number | Autonomy level (0-5) — higher = more independent |

## YAML Subset Parser

Kora uses a lightweight built-in YAML parser (no external dependency). It supports:

- Top-level `key: value` pairs (strings, numbers, booleans, null)
- Lists with `- item` syntax (one level deep)
- Nested objects with 2-space indentation (one level)
- Sub-nested objects with 4-space indentation (two levels)
- Comments with `#`
- Quoted strings (`"value"` or `'value'`)

For complex configurations, use `.kora.json` as a JSON fallback.

### Supported Scalar Types

| YAML Value | Parsed As |
|-----------|-----------|
| `"quoted"` or `'quoted'` | String (quotes stripped) |
| `true` / `false` | Boolean |
| `null` / `~` | Null |
| `42` / `3.14` | Number |
| `plain text` | String |

## Examples

### Minimal Configuration

```yaml
# .kora.yml
default_provider: claude-code
default_model: claude-sonnet-4-6
```

### Project Knowledge and Rules

```yaml
# .kora.yml
default_provider: claude-code
default_model: claude-sonnet-4-6

knowledge:
  - "This is a React + TypeScript monorepo with 3 packages"
  - "We use Mantine v8 for UI components"
  - "Database is SQLite with WAL mode via better-sqlite3"
  - "Terminal backend is holdpty (Unix domain sockets)"

rules:
  - "Never push directly to main — always use feature branches"
  - "All PRs must be rebased onto latest main before merging"
  - "No Co-Authored-By lines in commit messages"
  - "Never touch production configs (port 7890, ~/.kora/)"
  - "Run tests before creating PRs"
```

### Agent Role Overrides

```yaml
# .kora.yml
default_provider: claude-code
default_model: claude-sonnet-4-6

agents:
  master:
    model: claude-sonnet-4-6
    persona: "You are the lead architect. Break tasks into subtasks and delegate to workers."
    autonomy: 5
  default_worker:
    model: claude-sonnet-4-6
    persona: "You are a focused developer. Implement assigned tasks and report completion."
    autonomy: 3
```

### Full Configuration

```yaml
# .kora.yml — Full example with all fields
default_provider: claude-code
default_model: claude-sonnet-4-6

knowledge:
  - "Monorepo: packages/shared, packages/daemon, packages/dashboard"
  - "Build: npm run build:shared && npx tsc -p packages/daemon/tsconfig.json"
  - "Tests: npm run test -w packages/daemon (vitest)"
  - "Dev port: 7891, Prod port: 7890"

rules:
  - "Feature branches only — never commit to main"
  - "Rebase onto origin/main before PRs"
  - "No Co-Authored-By in commits"
  - "Dev testing on port 7891 only"
  - "All SQL must use parameterized queries"

agents:
  master:
    model: claude-sonnet-4-6
    persona: "You are the Architect. Plan work, delegate tasks, review PRs."
    autonomy: 5
  default_worker:
    model: claude-sonnet-4-6
    persona: "You are a developer. Implement tasks assigned by the Architect."
    autonomy: 3
```

## JSON Fallback Format

If you prefer JSON, create `.kora.json` instead:

```json
{
  "default_provider": "claude-code",
  "default_model": "claude-sonnet-4-6",
  "knowledge": [
    "This is a React + TypeScript monorepo"
  ],
  "rules": [
    "Never push directly to main"
  ],
  "agents": {
    "master": {
      "model": "claude-sonnet-4-6",
      "persona": "You are the lead architect.",
      "autonomy": 5
    },
    "default_worker": {
      "model": "claude-sonnet-4-6",
      "autonomy": 3
    }
  }
}
```

## How It Works

1. When a session is created, Kora reads `.kora.yml` from the project's working directory
2. `knowledge` entries are injected into every agent's system prompt via the persona builder
3. `rules` are appended as constraints to every agent's persona
4. `default_provider` and `default_model` set defaults for agents that don't specify their own
5. `agents.master` overrides apply to the master/orchestrator agent
6. `agents.default_worker` overrides apply to all worker agents unless individually overridden

## Source Code

- Parser: `packages/daemon/src/core/project-config.ts`
- Persona integration: `packages/daemon/src/core/persona-builder.ts`
- Interface: `ProjectConfig` type in `project-config.ts`
