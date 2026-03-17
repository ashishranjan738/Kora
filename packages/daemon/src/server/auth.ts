import type { Request, Response, NextFunction } from "express";
import { API_VERSION } from "@kora/shared";

/**
 * Bearer token auth middleware. Checks Authorization header or ?token query param.
 * Skips auth for GET /api/v1/status (health check).
 */
export function createAuthMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip auth for: health check, static assets, and SPA HTML routes
    if (req.path === `/api/${API_VERSION}/status` && req.method === "GET") {
      next();
      return;
    }
    // Don't auth-gate the dashboard HTML/assets (non-API GET requests)
    if (req.method === "GET" && !req.path.startsWith("/api/")) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;

    if (authHeader === `Bearer ${token}` || queryToken === token) {
      next();
    } else {
      res.status(401).json({ error: "Unauthorized" });
    }
  };
}

/** Validate WebSocket token from query params */
export function validateWsToken(url: string, token: string): boolean {
  try {
    // URL may be relative (e.g. "/?token=abc"), so we need a base
    const parsed = new URL(url, "http://localhost");
    return parsed.searchParams.get("token") === token;
  } catch {
    return false;
  }
}
