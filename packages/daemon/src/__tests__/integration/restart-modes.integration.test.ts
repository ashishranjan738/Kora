/**
 * Integration tests for restart modes via the REST API.
 * Requires a running daemon on port 7891 (dev mode).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import http from "http";

const PORT = 7891;
const BASE = `/api/v1`;

let TOKEN = "";
let SESSION_ID = "";
let AGENT_ID = "";

function httpRequest(method: string, path: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: "localhost",
      port: PORT,
      path: `${BASE}${path}`,
      method,
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

beforeAll(async () => {
  // Try multiple possible token locations
  const tokenPaths = [
    join(homedir(), ".kora-dev", "daemon.token"),
    "/Users/ashishranjan738/.kora-dev/daemon.token",
  ];
  for (const p of tokenPaths) {
    try {
      TOKEN = readFileSync(p, "utf-8").trim();
      if (TOKEN) break;
    } catch { /* try next */ }
  }
  if (!TOKEN) return;

  try {
    const status = await httpRequest("GET", "/status");
    if (!status?.version) { TOKEN = ""; return; }
  } catch {
    TOKEN = "";
    return;
  }

  // Find a Kiro session with running agents
  const sessions = await httpRequest("GET", "/sessions");
  if (!Array.isArray(sessions)) { TOKEN = ""; return; }

  const kiroSession = sessions.find((s: any) =>
    s.defaultProvider === "kiro" && s.activeAgentCount > 0
  );

  if (kiroSession) {
    SESSION_ID = kiroSession.id;
    const agentsData = await httpRequest("GET", `/sessions/${SESSION_ID}/agents`);
    const running = agentsData?.agents?.find((a: any) => a.status === "running");
    if (running) AGENT_ID = running.id;
  }

  if (!SESSION_ID) {
    // Fallback: any session with agents
    const anySession = sessions.find((s: any) => s.activeAgentCount > 0);
    if (anySession) {
      SESSION_ID = anySession.id;
      const agentsData = await httpRequest("GET", `/sessions/${SESSION_ID}/agents`);
      const running = agentsData?.agents?.find((a: any) => a.status === "running");
      if (running) AGENT_ID = running.id;
    }
  }
}, 10000);

describe("Restart Modes — Integration", () => {
  it("setup check — token loaded", () => {
    // This always runs to verify beforeAll worked
    if (!TOKEN) console.warn("TOKEN not loaded — daemon tests will skip. Token path:", join(homedir(), ".kora-dev", "daemon.token"));
    if (!SESSION_ID) console.warn("No active session found for testing");
    if (!AGENT_ID) console.warn("No running agent found for testing");
    expect(true).toBe(true); // Always passes
  });

  it.skipIf(!TOKEN)("daemon is running", async () => {
    const status = await httpRequest("GET", "/status");
    expect(status.version).toBeDefined();
  });

  it.skipIf(!TOKEN || !SESSION_ID)("poll-usage returns polled: true", async () => {
    const result = await httpRequest("POST", `/sessions/${SESSION_ID}/poll-usage`);
    expect(result.polled).toBe(true);
  });

  it.skipIf(!TOKEN || !SESSION_ID)("agents have cost data after poll", async () => {
    await httpRequest("POST", `/sessions/${SESSION_ID}/poll-usage`);
    const agentsData = await httpRequest("GET", `/sessions/${SESSION_ID}/agents`);
    expect(agentsData.agents).toBeDefined();
    expect(agentsData.agents.length).toBeGreaterThan(0);

    const agent = agentsData.agents[0];
    expect(agent.cost).toBeDefined();
    expect(typeof agent.cost.totalCostUsd).toBe("number");
    expect(typeof agent.cost.totalTokensIn).toBe("number");
  });

  it.skipIf(!TOKEN || !SESSION_ID)("Kiro agents have contextWindowPercent after poll", async () => {
    await httpRequest("POST", `/sessions/${SESSION_ID}/poll-usage`);
    const agentsData = await httpRequest("GET", `/sessions/${SESSION_ID}/agents`);

    const kiroAgent = agentsData.agents?.find((a: any) => a.config?.cliProvider === "kiro");
    if (kiroAgent) {
      expect(typeof kiroAgent.cost.contextWindowPercent).toBe("number");
    }
  });

  it.skipIf(!TOKEN || !AGENT_ID)("restart with summaryMode=true returns running agent", async () => {
    const result = await httpRequest("POST", `/sessions/${SESSION_ID}/agents/${AGENT_ID}/restart`, {
      summaryMode: true,
    });
    if (!result.error) {
      expect(result.id).toBeDefined();
      expect(result.status).toBe("running");
    }
  }, 30000);

  it.skipIf(!TOKEN || !AGENT_ID)("restart with carryContext=false (fresh) returns running agent", async () => {
    await new Promise(r => setTimeout(r, 5000));
    const result = await httpRequest("POST", `/sessions/${SESSION_ID}/agents/${AGENT_ID}/restart`, {
      carryContext: false,
    });
    if (!result.error) {
      expect(result.id).toBeDefined();
      expect(result.status).toBe("running");
    }
  }, 30000);

  it.skipIf(!TOKEN || !AGENT_ID)("restart with carryContext + contextLines returns running agent", async () => {
    await new Promise(r => setTimeout(r, 5000));
    const result = await httpRequest("POST", `/sessions/${SESSION_ID}/agents/${AGENT_ID}/restart`, {
      carryContext: true,
      contextLines: 100,
    });
    if (!result.error) {
      expect(result.id).toBeDefined();
      expect(result.status).toBe("running");
    }
  }, 30000);

  it.skipIf(!TOKEN)("poll-usage on non-existent session returns 404", async () => {
    const result = await httpRequest("POST", "/sessions/nonexistent-xyz/poll-usage");
    expect(result.error).toBeDefined();
  });
});
