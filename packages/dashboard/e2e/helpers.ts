/**
 * E2E test helpers — direct API calls for setup/teardown and polling utilities.
 */
import fs from "fs";
import path from "path";

const DEV_PORT = 7891;
const DEV_CONFIG_DIR = path.join(process.env.HOME || "~", ".kora-dev");
const BASE_URL = `http://localhost:${DEV_PORT}`;

/** Read the dev daemon auth token */
export function readToken(): string {
  const tokenPath = path.join(DEV_CONFIG_DIR, "daemon.token");
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`Token file not found at ${tokenPath}. Is the dev daemon running?`);
  }
  return fs.readFileSync(tokenPath, "utf-8").trim();
}

/** Make an authenticated API call to the dev daemon */
export async function apiCall<T = any>(
  endpoint: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = readToken();
  const res = await fetch(`${BASE_URL}/api/v1${endpoint}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${options.method || "GET"} ${endpoint} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Create a test session and return its ID */
export async function createTestSession(name?: string): Promise<string> {
  const data = await apiCall<{ session: { id: string } }>("/sessions", {
    method: "POST",
    body: {
      name: name || `e2e-test-${Date.now()}`,
      projectPath: process.cwd(),
      worktreeMode: "shared",
    },
  });
  return data.session.id;
}

/** Delete a session by ID */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await apiCall(`/sessions/${sessionId}`, { method: "DELETE" });
  } catch {
    // Best-effort cleanup
  }
}

/** Poll until an agent reaches "running" status */
export async function waitForAgent(
  sessionId: string,
  agentName: string,
  timeoutMs = 30_000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiCall<{ agents: Array<{ id: string; status: string; config: { name: string } }> }>(
      `/sessions/${sessionId}/agents`
    );
    const agent = data.agents.find(
      (a) => a.config.name.toLowerCase() === agentName.toLowerCase() && a.status === "running"
    );
    if (agent) return agent.id;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Agent "${agentName}" did not reach running state within ${timeoutMs}ms`);
}

/** Poll until a condition is true */
export async function waitFor(
  condition: () => Promise<boolean>,
  { timeout = 10_000, interval = 500, message = "Condition not met" } = {}
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`${message} (timeout: ${timeout}ms)`);
}
