.PHONY: build build-shared build-daemon build-dashboard \
       dev dev-debug prod stop-dev stop-prod restart-dev restart-prod \
       dev-bg prod-bg logs-dev logs-prod \
       test typecheck lint check \
       clean clean-dev clean-prod clean-dist clean-all \
       install status

# ─── Build ────────────────────────────────────────────────

build: build-shared build-daemon build-dashboard ## Build all packages

build-shared: ## Build shared types
	npm run build -w packages/shared

build-daemon: build-shared ## Build daemon (depends on shared)
	npx tsc -p packages/daemon/tsconfig.json

build-dashboard: ## Build dashboard
	cd packages/dashboard && npm run build

# ─── Dev (port 7891) ──────────────────────────────────────

dev: build ## Build and start dev daemon
	@if lsof -ti :7891 >/dev/null 2>&1; then \
		echo "Stopping existing dev daemon..."; \
		lsof -ti :7891 | xargs kill 2>/dev/null; \
		sleep 1; \
	fi
	KORA_LOG_LEVEL=info node packages/daemon/dist/cli.js start --dev

dev-debug: build ## Build and start dev daemon with debug logging
	@if lsof -ti :7891 >/dev/null 2>&1; then \
		echo "Stopping existing dev daemon..."; \
		lsof -ti :7891 | xargs kill 2>/dev/null; \
		sleep 1; \
	fi
	KORA_LOG_LEVEL=debug node packages/daemon/dist/cli.js start --dev

dev-bg: build ## Build and start dev daemon in background (logs to ~/.kora-dev/daemon.log)
	@if lsof -ti :7891 >/dev/null 2>&1; then \
		echo "Stopping existing dev daemon..."; \
		lsof -ti :7891 | xargs kill 2>/dev/null; \
		sleep 1; \
	fi
	@mkdir -p ~/.kora-dev
	@if [ -f ~/.kora-dev/daemon.log ]; then mv ~/.kora-dev/daemon.log ~/.kora-dev/daemon.log.prev; fi
	@node packages/daemon/dist/cli.js start --dev >> ~/.kora-dev/daemon.log 2>&1 &
	@sleep 2 && echo "Dev daemon running on http://localhost:7891 (logs: ~/.kora-dev/daemon.log)"

stop-dev: ## Stop dev daemon
	@lsof -ti :7891 | xargs kill 2>/dev/null && echo "Dev daemon stopped" || echo "Dev daemon not running"

restart-dev: stop-dev dev-bg ## Rebuild and restart dev daemon

logs-dev: ## Tail dev daemon logs (formatted with pino-pretty)
	@tail -f ~/.kora-dev/daemon.log 2>/dev/null | npx pino-pretty --colorize 2>/dev/null || tail -f ~/.kora-dev/daemon.log 2>/dev/null || echo "No dev daemon log found at ~/.kora-dev/daemon.log"

# ─── Prod (port 7890) ─────────────────────────────────────

prod: build ## Build and start prod daemon
	@if lsof -ti :7890 >/dev/null 2>&1; then \
		echo "Stopping existing prod daemon..."; \
		lsof -ti :7890 | xargs kill 2>/dev/null; \
		sleep 1; \
	fi
	node packages/daemon/dist/cli.js start

prod-bg: build ## Build and start prod daemon in background (logs to ~/.kora/daemon.log)
	@if lsof -ti :7890 >/dev/null 2>&1; then \
		echo "Stopping existing prod daemon..."; \
		lsof -ti :7890 | xargs kill 2>/dev/null; \
		sleep 1; \
	fi
	@mkdir -p ~/.kora
	@if [ -f ~/.kora/daemon.log ]; then mv ~/.kora/daemon.log ~/.kora/daemon.log.prev; fi
	@node packages/daemon/dist/cli.js start >> ~/.kora/daemon.log 2>&1 &
	@sleep 2 && echo "Prod daemon running on http://localhost:7890 (logs: ~/.kora/daemon.log)"

stop-prod: ## Stop prod daemon
	@lsof -ti :7890 | xargs kill 2>/dev/null && echo "Prod daemon stopped" || echo "Prod daemon not running"

restart-prod: stop-prod prod-bg ## Rebuild and restart prod daemon

logs-prod: ## Tail prod daemon logs
	@tail -f ~/.kora/daemon.log 2>/dev/null || echo "No prod daemon log found at ~/.kora/daemon.log"

# ─── Quality ──────────────────────────────────────────────

test: ## Run all tests
	npm run test -w packages/daemon

test-watch: ## Run tests in watch mode
	npx vitest -w packages/daemon

typecheck: build-shared ## Type-check all packages
	npx tsc -p packages/daemon/tsconfig.json --noEmit
	cd packages/dashboard && npx tsc --noEmit

lint: ## Lint all source files
	npm run lint

check: typecheck test lint ## Run all checks (typecheck + test + lint)

# ─── Clean ────────────────────────────────────────────────

clean-dist: ## Remove all build artifacts
	rm -rf packages/shared/dist packages/shared/tsconfig.tsbuildinfo
	rm -rf packages/daemon/dist packages/daemon/tsconfig.tsbuildinfo
	rm -rf packages/dashboard/dist
	rm -f tsconfig.tsbuildinfo

clean-dev: stop-dev ## Stop dev daemon and remove dev runtime files
	rm -rf .kora-dev
	rm -rf ~/.kora-dev
	@echo "Dev runtime cleaned"

clean-prod: stop-prod ## Stop prod daemon and remove prod runtime files
	rm -rf .kora
	rm -rf ~/.kora
	@echo "Prod runtime cleaned"

clean-modules: ## Remove node_modules
	rm -rf node_modules
	rm -rf packages/shared/node_modules
	rm -rf packages/daemon/node_modules
	rm -rf packages/dashboard/node_modules

clean: clean-dist ## Remove build artifacts only
	@echo "Clean complete. Use 'make clean-all' for full cleanup."

clean-all: stop-dev stop-prod clean-dist clean-modules ## Full cleanup: stop daemons, remove builds + node_modules
	rm -rf .kora .kora-dev
	rm -rf ~/.kora ~/.kora-dev
	@echo "Full cleanup complete. Run 'make install && make build' to start fresh."

# ─── Setup ────────────────────────────────────────────────

install: ## Install all dependencies
	npm install
	@rm -rf node_modules/holdpty/node_modules/node-pty 2>/dev/null && echo "Cleaned holdpty bundled node-pty" || true

fresh: clean-all install build ## Full clean, install, and build

# ─── Status ───────────────────────────────────────────────

status: ## Show status of dev and prod daemons
	@echo "=== Dev (port 7891) ==="
	@if lsof -ti :7891 >/dev/null 2>&1; then \
		echo "  Running (PID: $$(lsof -ti :7891 | head -1))"; \
		if [ -f ~/.kora-dev/daemon.token ]; then \
			TOKEN=$$(cat ~/.kora-dev/daemon.token); \
			curl -s "http://localhost:7891/api/v1/sessions" -H "Authorization: Bearer $$TOKEN" 2>/dev/null \
				| python3 -c "import sys,json; d=json.load(sys.stdin); sessions=d.get('sessions',[]); print(f'  Sessions: {len(sessions)}'); [print(f'    {s[\"name\"]}: {s[\"agentCount\"]} agents') for s in sessions]" 2>/dev/null \
				|| echo "  (could not fetch sessions)"; \
		fi; \
	else \
		echo "  Not running"; \
	fi
	@echo ""
	@echo "=== Prod (port 7890) ==="
	@if lsof -ti :7890 >/dev/null 2>&1; then \
		echo "  Running (PID: $$(lsof -ti :7890 | head -1))"; \
		if [ -f ~/.kora/daemon.token ]; then \
			TOKEN=$$(cat ~/.kora/daemon.token); \
			curl -s "http://localhost:7890/api/v1/sessions" -H "Authorization: Bearer $$TOKEN" 2>/dev/null \
				| python3 -c "import sys,json; d=json.load(sys.stdin); sessions=d.get('sessions',[]); print(f'  Sessions: {len(sessions)}'); [print(f'    {s[\"name\"]}: {s[\"agentCount\"]} agents') for s in sessions]" 2>/dev/null \
				|| echo "  (could not fetch sessions)"; \
		fi; \
	else \
		echo "  Not running"; \
	fi

# ─── Help ─────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
