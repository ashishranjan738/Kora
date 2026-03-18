import * as os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as http from "http";
import * as net from "net";
import * as crypto from "crypto";

import {
  DEFAULT_PORT,
  PID_FILE,
  PORT_FILE,
  TOKEN_FILE,
} from "@kora/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: string; // ISO 8601
  startedBy: "cli" | "vscode";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the path to the global config directory, creating it if needed.
 * Default: `~/.kora/`
 * Override: set KORA_CONFIG_DIR env var or pass --config-dir flag.
 * Dev mode: `~/.kora-dev/` (set via --dev flag or KORA_DEV=1)
 */
export function getGlobalConfigDir(): string {
  const envDir = process.env.KORA_CONFIG_DIR;
  const isDev = process.env.KORA_DEV === "1" || process.argv.includes("--dev");
  const suffix = isDev ? "-dev" : "";
  const dir = envDir || path.join(os.homedir(), `.kora${suffix}`);
  const fsSyn = require("fs") as typeof import("fs");
  fsSyn.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Generate a cryptographically random bearer token.
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Get an existing persisted token or generate a new one.
 * Reusing the token across restarts ensures MCP configs with baked-in
 * --token CLI args continue to work after daemon restart.
 */
export function getOrCreateToken(): string {
  const dir = getGlobalConfigDir();
  const tokenPath = path.join(dir, TOKEN_FILE);
  try {
    const existing = fsSync.readFileSync(tokenPath, "utf-8").trim();
    if (existing.length > 0) return existing;
  } catch { /* file doesn't exist — generate new */ }
  return generateToken();
}

// ---------------------------------------------------------------------------
// Daemon info persistence
// ---------------------------------------------------------------------------

/**
 * Reads the PID, port, and token files from the global config directory.
 * Returns `null` when any required file is missing or unparseable.
 */
export async function getDaemonInfo(): Promise<DaemonInfo | null> {
  try {
    const dir = getGlobalConfigDir();

    const [pidRaw, portRaw, tokenRaw] = await Promise.all([
      fs.readFile(path.join(dir, PID_FILE), "utf-8"),
      fs.readFile(path.join(dir, PORT_FILE), "utf-8"),
      fs.readFile(path.join(dir, TOKEN_FILE), "utf-8"),
    ]);

    const pid = parseInt(pidRaw.trim(), 10);
    const port = parseInt(portRaw.trim(), 10);
    const token = tokenRaw.trim();

    if (isNaN(pid) || isNaN(port) || !token) {
      return null;
    }

    return {
      pid,
      port,
      token,
      startedAt: new Date().toISOString(),
      startedBy: "cli",
    };
  } catch {
    return null;
  }
}

/**
 * Checks whether a daemon is actually responding on the given port.
 */
export async function isDaemonAlive(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      `http://localhost:${port}/api/v1/status`,
      (res) => {
        resolve(res.statusCode === 200);
        res.resume(); // drain the response
      },
    );

    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Finds an available TCP port starting from `startPort`, incrementing until a
 * free port is discovered.
 */
export async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;

  const isPortFree = (p: number): Promise<boolean> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(p, "127.0.0.1");
    });

  while (!(await isPortFree(port))) {
    port++;
  }

  return port;
}

/**
 * Writes daemon PID, port, and token files atomically (write-to-temp then
 * rename).
 */
export async function writeDaemonInfo(info: DaemonInfo): Promise<void> {
  const dir = getGlobalConfigDir();

  const writeAtomic = async (file: string, data: string): Promise<void> => {
    const target = path.join(dir, file);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, data, "utf-8");
    await fs.rename(tmp, target);
  };

  await Promise.all([
    writeAtomic(PID_FILE, String(info.pid)),
    writeAtomic(PORT_FILE, String(info.port)),
    writeAtomic(TOKEN_FILE, info.token),
  ]);
}

/**
 * Removes PID and port files from the global config directory.
 * Token file is preserved so it survives daemon restarts — MCP configs
 * bake the token into --token CLI args and need it to stay the same.
 */
export async function cleanupDaemonInfo(): Promise<void> {
  const dir = getGlobalConfigDir();

  await Promise.all(
    [PID_FILE, PORT_FILE].map((file) =>
      fs.unlink(path.join(dir, file)).catch(() => {
        /* ignore missing */
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// High-level lifecycle
// ---------------------------------------------------------------------------

/**
 * Main startup sequence.  Checks for an existing daemon, cleans up stale PID
 * files, picks a port, generates a token, and persists daemon info.
 *
 * The caller is responsible for actually starting the Express server – this
 * function only prepares and records the metadata.
 */
export async function startDaemon(
  options?: { port?: number },
): Promise<DaemonInfo> {
  // 1. Check if a daemon is already running
  const existing = await getDaemonInfo();
  if (existing) {
    const alive = await isDaemonAlive(existing.port);
    if (alive) {
      return existing;
    }
    // Stale PID – clean up before proceeding
    await cleanupDaemonInfo();
  }

  // 2. Find an available port
  const port = await findAvailablePort(options?.port ?? DEFAULT_PORT);

  // 3. Reuse existing token or generate a new one (survives restarts)
  const token = getOrCreateToken();

  // 4. Build DaemonInfo
  const info: DaemonInfo = {
    pid: process.pid,
    port,
    token,
    startedAt: new Date().toISOString(),
    startedBy: "cli",
  };

  // 5. Persist
  await writeDaemonInfo(info);

  return info;
}

/**
 * Shuts down the daemon by cleaning up PID / port / token files.
 */
export async function shutdownDaemon(): Promise<void> {
  await cleanupDaemonInfo();
}
