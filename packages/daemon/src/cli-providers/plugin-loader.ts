/**
 * Plugin loader — scans directories for provider plugin configs.
 * Loads JSON plugins via GenericCLIProvider, JS plugins directly.
 */

import fs from "fs";
import path from "path";
import { logger } from "../core/logger.js";
import { GenericCLIProvider, validatePluginConfig } from "./generic-provider.js";
import type { CLIProviderRegistry } from "./provider-registry.js";

/**
 * Load provider plugins from disk and register them.
 * Scans ~/.kora/providers/ (or ~/.kora-dev/providers/) and project-local .kora/providers/.
 */
export function loadPluginProviders(registry: CLIProviderRegistry, globalConfigDir: string): number {
  const dirs = [
    path.join(globalConfigDir, "providers"),        // ~/.kora/providers/ or ~/.kora-dev/providers/
    path.join(process.cwd(), ".kora", "providers"), // project-local plugins
  ];

  let loaded = 0;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch (err) {
      logger.warn({ dir, err }, "[Plugins] Failed to read plugin directory");
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        if (file.endsWith(".json")) {
          const raw = fs.readFileSync(filePath, "utf-8");
          const config = JSON.parse(raw);
          validatePluginConfig(config);
          registry.register(new GenericCLIProvider(config));
          loaded++;
          logger.info({ file, id: config.id }, "[Plugins] Loaded JSON provider plugin");
        } else if (file.endsWith(".js") || file.endsWith(".mjs")) {
          // Security warning for executable plugins
          logger.warn({ file, path: filePath }, "[Plugins] Loading executable plugin from disk — verify trust");
          const plugin = require(filePath);
          const provider = plugin.default || plugin;
          if (!provider.id || !provider.buildCommand) {
            throw new Error("JS plugin must export { id, buildCommand, ... }");
          }
          registry.register(provider);
          loaded++;
          logger.info({ file, id: provider.id }, "[Plugins] Loaded JS provider plugin");
        }
      } catch (err) {
        logger.warn({ file, err }, "[Plugins] Failed to load provider plugin");
      }
    }
  }

  if (loaded > 0) {
    logger.info({ count: loaded }, `[Plugins] Loaded ${loaded} provider plugin(s)`);
  }

  return loaded;
}
