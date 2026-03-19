# Kora CLI

Multi-agent orchestration platform for AI coding CLI agents (Claude Code, Aider, Codex, Kiro, Goose).

## Quick Start

```bash
npx kora-cli start
```

Or install globally:

```bash
npm install -g kora-cli
kora start
```

## Commands

- `kora start` — Start daemon + dashboard (port 7890)
- `kora start --dev` — Dev mode (port 7891, uses ~/.kora-dev/)
- `kora start --port <port>` — Custom port
- `kora stop` — Stop running daemon
- `kora status` — Check daemon status

## Features

- **Multi-Agent Orchestration**: Coordinate multiple AI agents (Claude Code, Aider, Codex, Kiro, Goose)
- **Browser Dashboard**: Real-time monitoring, terminal streaming, task management
- **Session Management**: Persist sessions across restarts
- **Git Worktree Mode**: Isolate agent changes in separate branches
- **Cost Tracking**: Monitor API usage and costs
- **MCP Integration**: Agent-to-agent messaging via Model Context Protocol

## Configuration

### Global Config
- **Production**: `~/.kora/`
- **Development**: `~/.kora-dev/`

### Project Config
Create `.kora/config.yaml` in your project:

```yaml
defaultProvider: claude-code
messagingMode: mcp
worktreeMode: true
agents:
  - name: Backend
    provider: claude-code
    role: backend
    model: claude-sonnet-4
```

## Development

```bash
git clone https://github.com/ashishranjan738/kora.git
cd kora
npm install
npm run build:shared
cd packages/daemon
npm run build:all
node dist/cli.js start --dev
```

## Documentation

- [GitHub Repository](https://github.com/ashishranjan738/kora)
- [Project Context](https://github.com/ashishranjan738/kora/blob/main/CLAUDE_CONTEXT.md)
- [API Documentation](https://github.com/ashishranjan738/kora/blob/main/BACKEND_API_SUMMARY.md)

## Requirements

- Node.js 18+
- tmux or holdpty (terminal backend)
- Supported AI CLI agents (Claude Code, Aider, etc.)

## License

MIT

## Support

- **Issues**: https://github.com/ashishranjan738/kora/issues
- **Discussions**: https://github.com/ashishranjan738/kora/discussions
