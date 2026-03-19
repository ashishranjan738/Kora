# Kora Development Rules

**MANDATORY PROCESS — NO NEGOTIATION**

All agents must follow these rules strictly. No exceptions.

---

## 🚨 Critical Environment Rules

### Prod vs Dev Isolation

| Resource | Prod | Dev |
|----------|------|-----|
| Port | 7890 | 7891 |
| Global config | `~/.kora/` | `~/.kora-dev/` |
| Runtime dir | `.kora/` | `.kora-dev/` |
| Tmux prefix (legacy/fallback) | `kora--` | `kora-dev--` |
| Terminal backend | **holdpty** (primary) | **holdpty** (primary) |

> **Note:** The primary terminal backend is **holdpty**. Tmux is retained only as a legacy fallback mechanism. The tmux prefix is listed above for reference but should not be used for new work.

### Kora-Prod Directory — DO NOT TOUCH

**❌ NEVER touch `/Users/ashishranjan738/Projects/Kora-prod/`**

- ❌ No git commands (pull, checkout, rebase)
- ❌ No file modifications
- ❌ No daemon operations
- ✅ Only work in `/Users/ashishranjan738/Projects/Kora/`

This directory is for **manual operations only**. Automated changes risk breaking production.

### Always Use Make Commands

**❌ NEVER suggest raw node/npm commands**

```bash
# ✅ CORRECT
make build
make dev
make test
make status
make logs-dev

# ❌ WRONG
node packages/daemon/dist/cli.js start --dev
npm run build:shared && npx tsc -p packages/daemon/tsconfig.json
```

See `Makefile` and `README.md` for all available commands.

---

## 📋 Development Process Pipeline

**This pipeline is MANDATORY. Follow every step. No shortcuts.**

### Step 1: Implementation
**Owner:** Backend / Frontend

- Implement feature or fix in isolated git worktree
- Follow existing code patterns
- No security vulnerabilities (XSS, SQL injection, command injection)
- Keep changes focused — no over-engineering

### Step 2: Code Review
**Owner:** Reviewer

- Review code quality, security, patterns
- Provide feedback via comments
- Request changes if needed
- **NO CO-AUTHORS** — single author per commit

### Step 3: Unit Tests
**Owner:** Tests (or original implementer)

- Write unit tests for new code
- Run `make test` — all tests must pass
- Target: comprehensive coverage of logic

### Step 4: Integration Tests (if applicable)
**Owner:** Tests

- If feature involves multiple components, write integration tests
- Test API endpoints, database operations, inter-component communication
- Run `make test` — all tests must pass

### Step 5: Full E2E Testing
**Owner:** Tests

**MANDATORY for all PRs. No exceptions.**

E2E testing workflow:

```bash
# 1. Rebase on latest main
git checkout main
git pull origin main
git checkout feature-branch
git rebase main

# 2. Build everything
make build

# 3. Run all tests
make test

# 4. Start dev daemon
make dev-bg

# 5. Test in Chrome browser
# - Open http://localhost:7891
# - Test the actual feature thoroughly
# - Test edge cases
# - Test error handling

# 6. Check logs for errors
make logs-dev

# 7. Take screenshots
# - Screenshot of feature working
# - Screenshot of any UI changes
# - Screenshot of browser console (no errors)

# 8. Stop daemon
make stop-dev
```

### Step 6: PR with Screenshots
**Owner:** Original implementer

- Create PR against `main` branch
- **MANDATORY:** Include screenshots in PR description showing:
  - Feature working in browser
  - Any UI changes
  - Browser console (no errors)
- Link related task IDs
- Describe what was tested

**No PR will be merged without screenshots.**

---

## 🧪 Testing Standards

### What Qualifies as E2E Testing

✅ **Real E2E Testing:**
- Build daemon with `make build`
- Start daemon with `make dev-bg`
- Open Chrome browser at http://localhost:7891
- Interact with the feature in the browser
- Check logs with `make logs-dev`
- Take screenshots of working feature
- Verify no console errors

❌ **Not E2E Testing:**
- Code review only
- "I read the code and it looks good"
- Running unit tests only
- Manual inspection without running daemon

### Screenshot Requirements

**Every PR must include screenshots showing:**

1. Feature working correctly in browser
2. Any UI changes (before/after if applicable)
3. Browser console showing no errors
4. Any relevant log output

**Purpose:** Build confidence that the feature actually works.

### 🚨 No PR Merge Without Browser E2E

**Effective immediately — NO EXCEPTIONS.**

After the fullscreen regression (PR #128 merged without browser E2E and broke prod), we are enforcing:

1. **Every PR that touches dashboard UI MUST have browser E2E screenshots** showing the feature working in Chrome at http://localhost:7891
2. **The Architect will NOT merge any PR** without seeing E2E screenshots in the PR description or completion message
3. **If the dev daemon can't be restarted** (live session running), the PR MUST WAIT — do not accept "unit tests are sufficient" for UI changes
4. **E2E test plan must be reviewed** by the Tester before execution — not just the code
5. **Fullscreen, scroll, navigation, and layout changes** require EXTRA verification: test in both normal and fullscreen modes, both themes, mobile viewport

**The tester's E2E workflow:**

1. Write E2E test plan
2. Get plan reviewed by Reviewer
3. Execute plan in Chrome at http://localhost:7891
4. Take screenshots at every step
5. Include screenshots in completion message
6. Only then can the PR be merged

---

## 🔄 Git Workflow

### Branch Strategy
- Main branch: `main`
- Feature branches: `agent/<agent-name>-<short-hash>`
- Always rebase on `origin/main` before creating PR
- Never push directly to main

### Commit Messages
- Clear, descriptive messages
- Format: `type: description` (e.g., `feat:`, `fix:`, `docs:`)
- **NO CO-AUTHORS** — single author per commit

### PR Process
1. Rebase on latest `origin/main`
2. Test against rebased code (full E2E)
3. Create PR with screenshots
4. Address review feedback
5. Merge only after approval + all checks pass

---

## 🎯 Task Assignment Guidelines

When creating or assigning tasks, **always include this hint:**

```
⚠️ **Process Reminder:**
Follow RULES.md pipeline: Implementation → Review → Unit Tests → Integration Tests → E2E (with screenshots) → PR

E2E testing is mandatory. Take screenshots showing the feature works in Chrome at http://localhost:7891.
```

---

## 🚀 Quality Standards

### Before Creating PR:
- [ ] Code reviewed
- [ ] Unit tests written and passing
- [ ] Integration tests written (if applicable)
- [ ] Full E2E completed in Chrome
- [ ] Screenshots taken
- [ ] `make build` succeeds
- [ ] `make test` passes
- [ ] No console errors
- [ ] Logs checked with `make logs-dev`
- [ ] Rebased on latest `origin/main`

### Before Merging PR:
- [ ] All review feedback addressed
- [ ] Screenshots included in PR
- [ ] CI/checks passing
- [ ] Reviewer approval
- [ ] No merge conflicts

---

## 📞 Inter-Agent Communication

- Use MCP tools: `send_message`, `broadcast`, `check_messages`
- Coordinate on complex features
- Report blockers immediately
- Share testing results

---

## 🎓 Examples

### ✅ Good Workflow
```
1. Backend implements API endpoint
2. Reviewer reviews code, requests changes
3. Backend addresses feedback
4. Tests writes unit tests for endpoint
5. Tests writes integration test for full flow
6. Tests does E2E: builds, starts daemon, tests in Chrome, takes screenshots
7. Backend creates PR with screenshots
8. PR merged after approval
```

### ❌ Bad Workflow (DO NOT DO THIS)
```
1. Backend implements feature
2. Backend: "I reviewed the code, looks good"
3. Backend creates PR without testing
4. PR merged without screenshots
5. Main branch breaks ❌
```

---

## 🖥️ Terminal Backend

Kora has migrated from tmux to **holdpty** as the primary terminal backend.

- **holdpty is primary** — All terminal operations (spawn, stream, send keys) go through holdpty
- **tmux is fallback only** — Tmux is retained as a legacy fallback mechanism, not the default
- **All new terminal work must target holdpty** — Do not write new code that uses tmux as the primary backend
- **Do not add tmux-first code** — If a feature needs terminal interaction, implement it against the holdpty `TerminalProvider` interface
- **Flag tmux-first code for migration** — If you encounter existing code that targets tmux as primary, flag it for migration to holdpty

### When to use tmux

The only acceptable uses of tmux are:
1. Fallback when holdpty is unavailable (controlled by `--terminal-backend` flag)
2. Maintaining existing tmux provider code until fully deprecated
3. Testing tmux fallback behavior

---

## 🐕 Dogfooding Awareness

We use **Kora (prod, port 7890)** to build **Kora (dev, port 7891)** — this is dogfooding.

Every agent is both a **user** and a **developer** of Kora. This means you must actively watch for issues during your work.

### What to watch for

- Message delivery delays or failures
- MCP tool failures (send_message, check_messages, etc.)
- Task board glitches (tasks not updating, wrong status)
- Terminal problems (output not streaming, input not working)
- Dashboard bugs (UI glitches, broken layouts)
- WebSocket issues (disconnects, missed events)
- Slow or unresponsive API calls

### When you encounter a Kora issue, you MUST:

1. **Acknowledge it** — Note what happened (error message, unexpected behavior, timing)
2. **Report it to Architect immediately** — Use `send_message` with details of the issue
3. **Architect will create a bug task** and prioritize it for the team

### Why this matters

- Dogfooding bugs are **HIGH PRIORITY** — they affect our own productivity
- These bugs get fixed in the dev environment (port 7891) — that's our core output
- **Do NOT ignore friction** — If something feels slow, broken, or awkward, report it
- Every bug we find and fix makes Kora better for all users

---

## 📚 Reference Documents

- `Makefile` — All Make commands
- `README.md` — Project overview, setup, commands
- `CLAUDE_CONTEXT.md` — Full technical context
- `MEMORY.md` — Auto-memory across conversations
- `ALWAYS_USE_MAKE.md` — Make command reference
- `KORA_PROD_RULE.md` — Kora-prod directory rules

---

**REMEMBER: This process is mandatory. No shortcuts. Quality over speed.**
