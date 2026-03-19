// ============================================================
// Terminal Persistence — saves/restores standalone terminal state
// so terminals survive daemon restarts (holdpty --bg mode)
// ============================================================

import fs from "fs/promises";
import path from "path";
import { STATE_DIR } from "@kora/shared";

const TERMINALS_FILE = "terminals.json";

export interface StandaloneTerminal {
  id: string;
  tmuxSession: string;
  name: string;
  createdAt: string;
  projectPath: string;
}

/**
 * Save standalone terminal state for a session to disk.
 * Written to: {runtimeDir}/state/terminals.json
 */
export async function saveTerminalStates(
  runtimeDir: string,
  terminals: StandaloneTerminal[],
): Promise<void> {
  const stateDir = path.join(runtimeDir, STATE_DIR);
  await fs.mkdir(stateDir, { recursive: true });
  const filePath = path.join(stateDir, TERMINALS_FILE);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(terminals, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Load standalone terminal states for a session from disk.
 * Returns empty array if no saved state.
 */
export async function loadTerminalStates(
  runtimeDir: string,
): Promise<StandaloneTerminal[]> {
  const filePath = path.join(runtimeDir, STATE_DIR, TERMINALS_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as StandaloneTerminal[];
  } catch {
    return [];
  }
}
