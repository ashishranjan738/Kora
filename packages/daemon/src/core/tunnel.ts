/**
 * Cloudflare Tunnel manager for remote access.
 *
 * Spawns cloudflared (via npm package) to create a public HTTPS URL
 * pointing to the local Kora daemon. Displays QR code for phone access.
 *
 * Usage: kora tunnel start [--dev]
 *        kora tunnel stop
 *        kora tunnel status
 */

import { spawn, type ChildProcess } from "child_process";
import { logger } from "./logger.js";

const DEFAULT_EXPIRE_MS = 2 * 60 * 60 * 1000; // 2 hours

let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let tunnelStartTime: number | null = null;
let expireTimer: NodeJS.Timeout | null = null;

export interface TunnelInfo {
  url: string;
  port: number;
  startedAt: string;
  expiresAt: string;
}

/**
 * Start a cloudflared tunnel to the local daemon.
 *
 * @param port - Local port to tunnel (7890 for prod, 7891 for dev)
 * @param token - Auth token to append to URL
 * @param expireMs - Auto-expire after this many ms (default: 2 hours)
 */
export async function startTunnel(
  port: number,
  token?: string,
  expireMs = DEFAULT_EXPIRE_MS,
): Promise<TunnelInfo> {
  if (tunnelProcess) {
    throw new Error("Tunnel already running. Stop it first with: kora tunnel stop");
  }

  // Try to use the npm cloudflared package
  let cloudflaredBin: string;
  try {
    const cloudflaredPkg = await import("cloudflared");
    cloudflaredBin = (cloudflaredPkg as any).bin || "cloudflared";
  } catch {
    cloudflaredBin = "cloudflared"; // Fallback to system install
  }

  return new Promise((resolve, reject) => {
    const args = ["tunnel", "--url", `http://localhost:${port}`];
    const proc = spawn(cloudflaredBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    tunnelProcess = proc;
    tunnelStartTime = Date.now();
    let urlFound = false;

    const parseUrl = (data: string) => {
      // cloudflared outputs the URL in stderr like:
      // "INF |  https://xxx-xxx-xxx.trycloudflare.com"
      // or "INF +---https://xxx.trycloudflare.com"
      const match = data.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !urlFound) {
        urlFound = true;
        tunnelUrl = match[0];

        // Append token to URL if provided
        // Use hash-based token (not query param) to avoid token leaking in server logs
        const fullUrl = token ? `${tunnelUrl}#token=${token}` : tunnelUrl;

        // Display QR code
        displayQrCode(fullUrl);

        // Set auto-expire timer
        expireTimer = setTimeout(() => {
          logger.info("[tunnel] Auto-expiring after 2 hours");
          stopTunnel();
        }, expireMs);

        const expiresAt = new Date(tunnelStartTime! + expireMs).toISOString();

        resolve({
          url: fullUrl,
          port,
          startedAt: new Date(tunnelStartTime!).toISOString(),
          expiresAt,
        });
      }
    };

    proc.stderr?.on("data", (data: Buffer) => parseUrl(data.toString()));
    proc.stdout?.on("data", (data: Buffer) => parseUrl(data.toString()));

    proc.on("error", (err) => {
      tunnelProcess = null;
      tunnelUrl = null;
      tunnelStartTime = null;
      reject(new Error(`Failed to start cloudflared: ${err.message}. Install with: npm install cloudflared`));
    });

    proc.on("exit", (code) => {
      if (!urlFound) {
        tunnelProcess = null;
        tunnelUrl = null;
        tunnelStartTime = null;
        reject(new Error(`cloudflared exited with code ${code} before establishing tunnel`));
      }
      // Normal exit after stop
      tunnelProcess = null;
      tunnelUrl = null;
    });

    // Timeout if URL not found in 30s
    setTimeout(() => {
      if (!urlFound) {
        proc.kill();
        tunnelProcess = null;
        tunnelUrl = null;
        tunnelStartTime = null;
        reject(new Error("Timeout: cloudflared did not establish tunnel within 30 seconds"));
      }
    }, 30_000);
  });
}

/** Stop the running tunnel */
export function stopTunnel(): boolean {
  if (!tunnelProcess) return false;

  tunnelProcess.kill();
  tunnelProcess = null;
  tunnelUrl = null;
  tunnelStartTime = null;

  if (expireTimer) {
    clearTimeout(expireTimer);
    expireTimer = null;
  }

  logger.info("[tunnel] Stopped");
  return true;
}

/** Get current tunnel status */
export function getTunnelStatus(): TunnelInfo | null {
  if (!tunnelUrl || !tunnelStartTime) return null;

  return {
    url: tunnelUrl,
    port: 0, // Not tracked separately
    startedAt: new Date(tunnelStartTime).toISOString(),
    expiresAt: new Date(tunnelStartTime + DEFAULT_EXPIRE_MS).toISOString(),
  };
}

/** Display QR code in terminal */
function displayQrCode(url: string): void {
  try {
    // Dynamic import to avoid bundling issues
    const qrcode = require("qrcode-terminal");
    console.log("\n🌐 Tunnel active: " + url);
    console.log("📱 Scan to open on phone:\n");
    qrcode.generate(url, { small: true });
    console.log("");
  } catch {
    // qrcode-terminal not available — just print URL
    console.log("\n🌐 Tunnel active: " + url);
    console.log("📱 Open this URL on your phone: " + url + "\n");
  }
}
