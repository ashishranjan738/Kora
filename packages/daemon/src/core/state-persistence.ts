// ============================================================
// State Persistence — saves/restores agent state to disk
// so sessions survive daemon restarts
// ============================================================

import fs from "fs/promises";
import path from "path";
import type { AgentState } from "@kora/shared";
import { STATE_DIR } from "@kora/shared";

const AGENTS_FILE = "agents.json";

/**
 * Save all agent states for a session to disk.
 * Written to: {runtimeDir}/state/agents.json
 */
export async function saveAgentStates(
  runtimeDir: string,
  agents: AgentState[],
): Promise<void> {
  const stateDir = path.join(runtimeDir, STATE_DIR);
  await fs.mkdir(stateDir, { recursive: true });
  const filePath = path.join(stateDir, AGENTS_FILE);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(agents, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Load agent states for a session from disk.
 * Returns empty array if no saved state.
 */
export async function loadAgentStates(
  runtimeDir: string,
): Promise<AgentState[]> {
  const filePath = path.join(runtimeDir, STATE_DIR, AGENTS_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as AgentState[];
  } catch {
    return [];
  }
}
