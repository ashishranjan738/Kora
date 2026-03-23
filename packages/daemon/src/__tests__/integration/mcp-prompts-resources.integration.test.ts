/**
 * E2E test: MCP Prompts & Resources handlers.
 *
 * Spawns the MCP server as a child process and sends JSON-RPC messages
 * via stdio to verify prompts/list, prompts/get, resources/list,
 * resources/read, and resources/subscribe handlers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import * as path from "path";

// ---------------------------------------------------------------------------
// JSON-RPC client over stdio
// ---------------------------------------------------------------------------

class McpTestClient {
  private proc: ChildProcess;
  private buffer = "";
  private pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private ready = false;

  constructor(serverPath: string, args: string[]) {
    this.proc = spawn("node", [serverPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" },
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      // Ignore stderr (debug/error output)
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const { resolve } = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  async send(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 5000);

      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v as Record<string, unknown>); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.proc.stdin!.write(msg + "\n");
    });
  }

  async initialize(): Promise<Record<string, unknown>> {
    const resp = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    // Send initialized notification (no response expected)
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    this.ready = true;
    return resp;
  }

  close(): void {
    try {
      this.proc.stdin!.end();
      this.proc.kill("SIGTERM");
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SERVER_PATH = path.resolve(__dirname, "../../mcp/agent-mcp-server.js");
// Check if compiled version exists, fall back to dist path
const DIST_SERVER_PATH = path.resolve(__dirname, "../../../dist/mcp/agent-mcp-server.js");

describe("MCP Prompts & Resources E2E", () => {
  let client: McpTestClient;
  let initResp: Record<string, unknown>;
  const serverPath = require("fs").existsSync(DIST_SERVER_PATH) ? DIST_SERVER_PATH : SERVER_PATH;

  beforeAll(async () => {
    // Spawn MCP server with test agent credentials
    // No real daemon needed — prompts/list and resources/list work without API calls
    client = new McpTestClient(serverPath, [
      "--agent-id", "test-agent-001",
      "--session-id", "test-session",
      "--agent-role", "worker",
      "--project-path", "/tmp/kora-test",
      "--daemon-url", "http://localhost:19999", // Non-existent — API calls will fail gracefully
    ]);

    initResp = await client.initialize();
  }, 10000);

  afterAll(() => {
    client?.close();
  });

  // ── C3: Prompts ─────────────────────────────────────────────────────────

  describe("C3: MCP Prompts", () => {
    it("C3.1: initialize declares prompts capability", () => {
      const result = initResp.result as Record<string, unknown>;
      expect(result).toBeDefined();
      const caps = result.capabilities as Record<string, unknown>;
      expect(caps.prompts).toBeDefined();
      expect((caps.prompts as Record<string, unknown>).listChanged).toBe(true);
    });

    it("C3.2: prompts/list returns prompts for worker role", async () => {
      const resp = await client.send("prompts/list");
      const result = resp.result as Record<string, unknown>;
      expect(result).toBeDefined();

      const prompts = result.prompts as Array<Record<string, unknown>>;
      expect(Array.isArray(prompts)).toBe(true);
      expect(prompts.length).toBeGreaterThanOrEqual(1);

      // Each prompt has name and description
      for (const p of prompts) {
        expect(p.name).toBeDefined();
        expect(typeof p.name).toBe("string");
        expect(p.description).toBeDefined();
        expect(typeof p.description).toBe("string");
      }

      // Worker should see persona and communication but NOT master-protocol
      const names = prompts.map(p => p.name);
      expect(names).toContain("persona");
      expect(names).toContain("communication");
      expect(names).not.toContain("master-protocol");
    });

    it("C3.4: prompts/get error for nonexistent prompt", async () => {
      const resp = await client.send("prompts/get", { name: "nonexistent" });
      expect(resp.error).toBeDefined();
      const error = resp.error as Record<string, unknown>;
      expect(error.code).toBe(-32602);
    });
  });

  // ── C4: Resources ───────────────────────────────────────────────────────

  describe("C4: MCP Resources", () => {
    it("C4.1: initialize declares resources capability", () => {
      const result = initResp.result as Record<string, unknown>;
      const caps = result.capabilities as Record<string, unknown>;
      expect(caps.resources).toBeDefined();
      const resCaps = caps.resources as Record<string, unknown>;
      expect(resCaps.subscribe).toBe(true);
      expect(resCaps.listChanged).toBe(true);
    });

    it("C4.2: resources/list returns all resources with kora:// URIs", async () => {
      const resp = await client.send("resources/list");
      const result = resp.result as Record<string, unknown>;
      expect(result).toBeDefined();

      const resources = result.resources as Array<Record<string, unknown>>;
      expect(Array.isArray(resources)).toBe(true);
      expect(resources.length).toBeGreaterThanOrEqual(5);

      // Each resource has required fields
      for (const r of resources) {
        expect(r.uri).toBeDefined();
        expect((r.uri as string).startsWith("kora://")).toBe(true);
        expect(r.name).toBeDefined();
        expect(r.description).toBeDefined();
        expect(r.mimeType).toBe("text/markdown");
      }

      // Check expected URIs
      const uris = resources.map(r => r.uri);
      expect(uris).toContain("kora://team");
      expect(uris).toContain("kora://workflow");
      expect(uris).toContain("kora://knowledge");
      expect(uris).toContain("kora://rules");
      expect(uris).toContain("kora://tasks");
    });

    it("C4.4: resources/read error for unknown URI", async () => {
      const resp = await client.send("resources/read", { uri: "kora://unknown" });
      expect(resp.error).toBeDefined();
      const error = resp.error as Record<string, unknown>;
      expect(error.code).toBe(-32602);
    });

    it("C4.5: resources/subscribe accepted", async () => {
      const resp = await client.send("resources/subscribe", { uri: "kora://team" });
      // Should succeed (no error)
      expect(resp.error).toBeUndefined();
      expect(resp.result).toBeDefined();
    });

    it("C4.5b: resources/unsubscribe accepted", async () => {
      const resp = await client.send("resources/unsubscribe", { uri: "kora://team" });
      expect(resp.error).toBeUndefined();
      expect(resp.result).toBeDefined();
    });
  });
});
