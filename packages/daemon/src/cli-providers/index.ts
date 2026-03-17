export { CLIProviderRegistry, registry } from "./provider-registry.js";

import { registry } from "./provider-registry.js";
import { claudeCodeProvider } from "./claude-code.js";
import { codexProvider } from "./codex.js";
import { aiderProvider } from "./aider.js";
import { kiroProvider } from "./kiro.js";
import { gooseProvider } from "./goose.js";

// Register all built-in providers
registry.register(claudeCodeProvider);
registry.register(codexProvider);
registry.register(aiderProvider);
registry.register(kiroProvider);
registry.register(gooseProvider);

export { claudeCodeProvider } from "./claude-code.js";
export { codexProvider } from "./codex.js";
export { aiderProvider } from "./aider.js";
export { kiroProvider } from "./kiro.js";
export { gooseProvider } from "./goose.js";
