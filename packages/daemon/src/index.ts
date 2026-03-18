export { createServer } from "./server/index.js";
export type { ServerOptions, ServerDeps } from "./server/index.js";
export { SessionManager } from "./core/session-manager.js";
export {
  startDaemon,
  shutdownDaemon,
  getDaemonInfo,
  isDaemonAlive,
  cleanupDaemonInfo,
  getGlobalConfigDir,
} from "./daemon-lifecycle.js";
export { AgentManager } from "./core/agent-manager.js";
export { MessageBus } from "./core/message-bus.js";
export type { IPtyBackend } from "./core/pty-backend.js";
export { TmuxController } from "./core/tmux-controller.js";
export { HoldptyController } from "./core/holdpty-controller.js";
export { default as tmux } from "./core/tmux-controller.js";
export { CLIProviderRegistry, registry } from "./cli-providers/index.js";
