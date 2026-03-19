/**
 * Context Discovery — auto-discovers project context files
 * (CLAUDE_CONTEXT.md, README.md, AGENTS.md, etc.) and returns
 * their contents for injection into agent personas.
 *
 * Only includes files that are <200 lines to avoid bloating
 * the agent's context window.
 */

import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

/** Well-known context file names, checked in priority order */
const CONTEXT_FILE_NAMES = [
  "CLAUDE_CONTEXT.md",
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
];

/** Maximum lines to include from a context file */
const MAX_LINES = 200;

export interface ContextFile {
  name: string;
  content: string;
}

/**
 * Discover and read context files from a project directory.
 * Returns files that exist and are under MAX_LINES.
 * Reads synchronously for simplicity (called once at agent spawn).
 */
export function discoverContextFiles(projectPath: string): ContextFile[] {
  const results: ContextFile[] = [];

  for (const fileName of CONTEXT_FILE_NAMES) {
    const filePath = path.join(projectPath, fileName);
    try {
      if (!fs.existsSync(filePath)) continue;

      const stat = fs.statSync(filePath);
      // Skip files larger than 100KB (likely not a context file)
      if (stat.size > 100_000) {
        logger.info(`[context-discovery] Skipping ${fileName} (${Math.round(stat.size / 1024)}KB > 100KB limit)`);
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      if (lines.length > MAX_LINES) {
        // Truncate to MAX_LINES with indicator
        const truncated = lines.slice(0, MAX_LINES).join("\n")
          + `\n\n<!-- Truncated: ${lines.length} lines total, showing first ${MAX_LINES} -->`;
        results.push({ name: fileName, content: truncated });
        logger.info(`[context-discovery] Injected ${fileName} (truncated: ${lines.length} → ${MAX_LINES} lines)`);
      } else {
        results.push({ name: fileName, content });
        logger.info(`[context-discovery] Injected ${fileName} (${lines.length} lines)`);
      }
    } catch (err) {
      // File unreadable — skip silently
      logger.debug(`[context-discovery] Could not read ${fileName}: ${err}`);
    }
  }

  return results;
}
