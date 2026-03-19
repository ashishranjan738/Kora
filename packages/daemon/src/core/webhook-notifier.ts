/**
 * Webhook Notifier - Sends HTTP POST notifications to configured webhook URLs
 * Supports retry logic with exponential backoff for reliability
 */

import http from "http";
import https from "https";
import { logger } from "./logger.js";

export interface WebhookConfig {
  url: string;
  events: string[];
  enabled?: boolean;
}

export interface WebhookEvent {
  event: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  timestamp: number;
  [key: string]: any;
}

export class WebhookNotifier {
  private webhooks: WebhookConfig[] = [];
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000; // Base delay, doubles with each retry

  constructor(webhooks: WebhookConfig[] = []) {
    this.webhooks = webhooks.filter(wh => wh.enabled !== false);
  }

  /**
   * Update webhook configuration
   */
  setWebhooks(webhooks: WebhookConfig[]): void {
    this.webhooks = webhooks.filter(wh => wh.enabled !== false);
  }

  /**
   * Send event notification to all matching webhooks
   */
  async notify(event: WebhookEvent): Promise<void> {
    const matchingWebhooks = this.webhooks.filter(wh =>
      wh.events.includes(event.event) || wh.events.includes("*")
    );

    if (matchingWebhooks.length === 0) {
      return;
    }

    // Send to all matching webhooks in parallel (fire-and-forget with logging)
    const promises = matchingWebhooks.map(webhook =>
      this.sendWithRetry(webhook.url, event).catch(err => {
        logger.warn({ err, url: webhook.url, event: event.event }, "Webhook delivery failed after retries");
      })
    );

    await Promise.allSettled(promises);
  }

  /**
   * Send webhook with retry logic
   */
  private async sendWithRetry(url: string, event: WebhookEvent, attempt: number = 1): Promise<void> {
    try {
      await this.sendWebhook(url, event);
      logger.debug({ url, event: event.event }, "Webhook delivered successfully");
    } catch (err) {
      if (attempt >= this.maxRetries) {
        throw err;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
      logger.debug({ url, attempt, delay }, "Webhook delivery failed, retrying...");

      await new Promise(resolve => setTimeout(resolve, delay));
      return this.sendWithRetry(url, event, attempt + 1);
    }
  }

  /**
   * Send HTTP POST request to webhook URL
   */
  private sendWebhook(url: string, event: WebhookEvent): Promise<void> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === "https:" ? https : http;
      const payload = JSON.stringify(event);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "Kora-Webhook/1.0",
        },
        timeout: 5000, // 5 second timeout
      };

      const req = client.request(options, (res) => {
        // Consider 2xx status codes as success
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Webhook returned status ${res.statusCode}`));
        }

        // Drain response body to free memory
        res.resume();
      });

      req.on("error", (err) => {
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Webhook request timeout"));
      });

      req.write(payload);
      req.end();
    });
  }
}
