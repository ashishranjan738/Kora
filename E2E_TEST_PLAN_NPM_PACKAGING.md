# E2E Test Plan — npm Packaging

## Overview

This document outlines end-to-end testing scenarios for the kora-cli npm package to ensure complete functionality across different installation methods and environments.

## Prerequisites

- Node.js 18+ installed
- npm 8+ installed
- Clean test environment (or Docker container)
- Built package: `kora-cli-0.1.0.tgz`

---

## Scenario 1: Fresh Install via npx (Cold Start)

**Objective**: Verify kora-cli works on a clean machine without any prior setup.

### Test Steps

1. **Setup Clean Environment**
   ```bash
   # Use a fresh terminal or Docker container
   docker run -it --rm node:18 bash
   # OR use a fresh user directory
   cd /tmp && mkdir kora-test && cd kora-test
   ```

2. **Cold Start with npx**
   ```bash
   npx kora-cli@file:/path/to/kora-cli-0.1.0.tgz start --dev --port 7892
   ```

   **Expected Results:**
   - ✅ Package downloads and installs (first time)
   - ✅ Daemon starts on port 7892
   - ✅ Logs show "Kora daemon running on http://localhost:7892"
   - ✅ No "module not found" errors
   - ✅ Dashboard path resolves (bundled or dev fallback logged)

3. **Verify Dashboard Loads**
   ```bash
   curl http://localhost:7892/
   ```

   **Expected Results:**
   - ✅ Returns HTML (not 404 or 500)
   - ✅ HTML contains `<script>window.__KORA_TOKEN__`
   - ✅ Dashboard assets load (check browser dev tools)

4. **Create Session**
   ```bash
   # In browser, navigate to http://localhost:7892
   # Create new session: "test-session"
   # Project path: /tmp/test-project
   ```

   **Expected Results:**
   - ✅ Session created successfully
   - ✅ Session appears in dashboard
   - ✅ No errors in console

5. **Spawn Agent**
   ```bash
   # In dashboard, click "Add Agent"
   # Name: TestAgent
   # Provider: claude-code (or any available)
   ```

   **Expected Results:**
   - ✅ Agent spawns without errors
   - ✅ Terminal streams connect
   - ✅ Agent card shows "running" status
   - ✅ Can send commands to agent terminal

6. **Stop Daemon**
   ```bash
   npx kora-cli@file:/path/to/kora-cli-0.1.0.tgz stop
   ```

   **Expected Results:**
   - ✅ Daemon stops gracefully
   - ✅ No orphaned processes

### Pass Criteria
- All steps complete without errors
- Dashboard loads and is fully functional
- Agent spawning and terminal streaming work
- Clean shutdown

---

## Scenario 2: Global Install

**Objective**: Verify kora-cli works as a globally installed package.

### Test Steps

1. **Global Install**
   ```bash
   npm install -g /path/to/kora-cli-0.1.0.tgz
   ```

   **Expected Results:**
   - ✅ Installation succeeds
   - ✅ No dependency errors
   - ✅ Bin links created: `kora`, `kora-cli`

2. **Verify Commands**
   ```bash
   which kora
   which kora-cli
   kora --version
   kora-cli --version
   ```

   **Expected Results:**
   - ✅ Both commands found in PATH
   - ✅ Both show "Kora v0.1.0"
   - ✅ Help text displays correctly

3. **Start Daemon (Dev Mode)**
   ```bash
   kora start --dev --port 7893
   ```

   **Expected Results:**
   - ✅ Daemon starts on port 7893
   - ✅ Dashboard loads at http://localhost:7893
   - ✅ Log shows bundled dashboard path used
   - ✅ Token saved to ~/.kora-dev/

4. **Full Functionality Test**
   - Create session
   - Add 3 agents (different providers)
   - Send messages between agents (MCP)
   - Execute playbook
   - Check cost tracking
   - View logs
   - Stop/restart agents

   **Expected Results:**
   - ✅ All features work as in dev environment
   - ✅ No regressions
   - ✅ Terminal streaming stable
   - ✅ WebSocket connections solid

5. **Status Check**
   ```bash
   kora status
   ```

   **Expected Results:**
   - ✅ Shows running daemon info
   - ✅ Correct PID, port, uptime
   - ✅ Active sessions/agents count

6. **Stop Daemon**
   ```bash
   kora stop
   ```

   **Expected Results:**
   - ✅ Stops cleanly
   - ✅ Status shows "not running"

7. **Uninstall**
   ```bash
   npm uninstall -g kora-cli
   ```

   **Expected Results:**
   - ✅ Uninstalls successfully
   - ✅ `which kora` returns nothing
   - ✅ Config files remain in ~/.kora/ (not deleted)

### Pass Criteria
- Global install and commands work
- All core features functional
- Clean uninstall

---

## Scenario 3: Development Mode Still Works

**Objective**: Ensure monorepo dev workflow is not broken by packaging changes.

### Test Steps

1. **Clone/Navigate to Dev Environment**
   ```bash
   cd /path/to/kora
   git pull origin main
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

   **Expected Results:**
   - ✅ All packages install
   - ✅ No dependency conflicts with kora-cli

3. **Build Packages**
   ```bash
   npm run build:shared
   cd packages/daemon && npm run build
   cd ../dashboard && npm run build
   cd ../..
   ```

   **Expected Results:**
   - ✅ All builds succeed
   - ✅ No TypeScript errors

4. **Run Dev Daemon**
   ```bash
   node packages/daemon/dist/cli.js start --dev
   ```

   **Expected Results:**
   - ✅ Daemon starts from source
   - ✅ Dashboard resolves to dev path (../../dashboard/dist)
   - ✅ Log shows "Using dev path"
   - ✅ Hot reload works (if watching)

5. **Make Code Changes**
   ```bash
   # Edit packages/daemon/src/server/index.ts
   # Add a console.log or comment
   npm run build -w packages/daemon
   # Restart daemon
   ```

   **Expected Results:**
   - ✅ Changes reflected after rebuild
   - ✅ Dev workflow unchanged

6. **Run Tests**
   ```bash
   npm run test -w packages/daemon
   ```

   **Expected Results:**
   - ✅ All tests pass (591+ tests)
   - ✅ New packaging tests included

### Pass Criteria
- Dev environment works identically to before packaging
- No build or runtime regressions
- Tests pass

---

## Scenario 4: Upgrade Test

**Objective**: Verify upgrading from one version to another works smoothly.

### Test Steps

1. **Install v0.1.0**
   ```bash
   npm install -g /path/to/kora-cli-0.1.0.tgz
   kora start --dev
   # Create sessions, agents, etc.
   kora stop
   ```

2. **Upgrade to New Version**
   ```bash
   # Simulate: rebuild with version bump
   # (In real scenario: npm install -g kora-cli@0.2.0)
   npm install -g /path/to/kora-cli-0.1.1.tgz
   ```

   **Expected Results:**
   - ✅ Upgrade succeeds
   - ✅ Old version replaced

3. **Restart Daemon**
   ```bash
   kora start --dev
   ```

   **Expected Results:**
   - ✅ Previous sessions restored
   - ✅ Agents reconnect
   - ✅ No data loss

### Pass Criteria
- Upgrade preserves sessions and config
- No breaking changes

---

## Scenario 5: Production Mode Test

**Objective**: Verify kora-cli works in production (port 7890, ~/.kora/).

### Test Steps

1. **Start Production Daemon**
   ```bash
   kora start  # (no --dev flag)
   ```

   **Expected Results:**
   - ✅ Starts on port 7890
   - ✅ Config saved to ~/.kora/
   - ✅ Dashboard loads at http://localhost:7890

2. **Full Feature Test**
   - Create production session
   - Spawn agents
   - Run playbook
   - Check persistence across restarts

   **Expected Results:**
   - ✅ All features work
   - ✅ Production mode stable

3. **Parallel Dev/Prod Test**
   ```bash
   # In terminal 1:
   kora start  # prod on 7890

   # In terminal 2:
   kora start --dev  # dev on 7891

   kora status  # should show prod daemon
   KORA_DEV=1 kora status  # should show dev daemon
   ```

   **Expected Results:**
   - ✅ Both daemons run simultaneously
   - ✅ No port conflicts
   - ✅ Separate config directories
   - ✅ Status command distinguishes correctly

### Pass Criteria
- Production mode works
- Dev/prod isolation maintained

---

## Manual Testing Checklist

Before creating PR, manually verify:

### Build & Package
- [ ] `cd packages/daemon && npm run build:all` succeeds
- [ ] `npm pack` succeeds
- [ ] `ls -lh kora-cli-*.tgz` shows ~1MB (under 30MB)
- [ ] `tar -tzf kora-cli-*.tgz | wc -l` shows 728+ files

### Installation
- [ ] `npm install -g ./kora-cli-0.1.0.tgz` succeeds
- [ ] `which kora` returns path
- [ ] `which kora-cli` returns path
- [ ] `kora --version` shows v0.1.0
- [ ] `kora-cli --version` shows v0.1.0
- [ ] `kora --help` displays usage

### Daemon Functionality
- [ ] `kora start --dev` starts daemon on 7891
- [ ] Dashboard loads at http://localhost:7891
- [ ] Dashboard assets load (no 404s in network tab)
- [ ] Token injected in HTML source
- [ ] Create session works
- [ ] Add agent works
- [ ] Terminal streams work
- [ ] MCP messaging works
- [ ] Playbook execution works
- [ ] Stop/restart agents works

### Tests
- [ ] `npm run test -w packages/daemon` passes (591+ tests)
- [ ] New packaging unit tests pass
- [ ] New packaging integration tests pass

### Cleanup
- [ ] `kora stop` stops daemon
- [ ] `npm uninstall -g kora-cli` uninstalls cleanly
- [ ] Config preserved in ~/.kora-dev/

---

## Success Criteria

All scenarios must pass with:
- ✅ No errors during install/uninstall
- ✅ All features functional
- ✅ Dashboard loads and works correctly
- ✅ Dev workflow unchanged
- ✅ Tests pass
- ✅ Package size under 30MB

## Failure Handling

If any scenario fails:
1. Document the failure (error message, steps, environment)
2. Fix the root cause
3. Rebuild and retest all scenarios
4. Do not proceed to PR until all pass

---

## Sign-off

**Tester**: ________________
**Date**: ________________
**All scenarios passed**: [ ] Yes [ ] No
**Notes**: ________________
